/**
 * MiSub Core Processing Service
 * Handles the logic of: Profile Resolving -> Node Fetching -> Transformation Pipeline -> Response Rendering
 */

import { generateCombinedNodeList } from './subscription-service.js';
import { transformBuiltinSubscription } from '../modules/subscription/transformer-factory.js';
import {
    renderClashFromIniTemplate,
    renderSingboxFromIniTemplate,
    renderSurgeFromIniTemplate,
    renderLoonFromIniTemplate,
    renderQuanxFromIniTemplate,
    renderEgernFromIniTemplate,
} from '../modules/subscription/template-pipeline.js';
import { getBuiltinTemplate } from '../modules/subscription/builtin-template-registry.js';
import { fetchTransformTemplate } from '../modules/subscription/transform-template-cache.js';
import { resolveRuleTemplateSource } from '../modules/rule-template-handler.js';
import { base64EncodeUtf8 } from '../modules/utils.js';
import yaml from 'js-yaml';
import { urlsToClashProxies } from '../utils/url-to-clash.js';
import { resolveSafeDnsConfig } from '../modules/subscription/safe-dns.js';

function getTemplateExtension(templateUrl) {
    const raw = typeof templateUrl === 'string' ? templateUrl.trim() : '';
    if (!raw) return '';

    try {
        const parsed = new URL(raw);
        return parsed.pathname.split('/').pop()?.split('.').pop()?.toLowerCase() || '';
    } catch {
        const cleanPath = raw.split('#')[0].split('?')[0];
        return cleanPath.split('/').pop()?.split('.').pop()?.toLowerCase() || '';
    }
}

const INI_TEMPLATE_SECTION_RE = /^\s*\[(custom|proxy\s*group|rule|ruleset|proxy|server|general)\]/im;

/**
 * INI 模板的内容特征。远程模板 URL 不一定带 .ini 后缀，
 * 因此不能只靠扩展名判断模板类型。
 */
export function hasIniTemplateShape(templateText) {
    return typeof templateText === 'string' && INI_TEMPLATE_SECTION_RE.test(templateText);
}

export function isIniTemplateSource(templateSource, builtinTemplateEntry = null) {
    if (builtinTemplateEntry?.format === 'ini') return true;
    if (templateSource?.kind === 'custom') return true;
    return getTemplateExtension(templateSource?.value) === 'ini';
}

function stripInternalProxyFields(proxy) {
    if (!proxy || typeof proxy !== 'object') return proxy;
    const { metadata, ...publicProxy } = proxy;
    return publicProxy;
}

function deduplicateProxyNames(proxies) {
    const seen = new Map();
    proxies.forEach((proxy) => {
        if (!proxy?.name) return;
        const originalName = proxy.name;
        const count = seen.get(originalName) || 0;
        seen.set(originalName, count + 1);
        if (count > 0) {
            proxy.name = `${originalName} ${count + 1}`;
        }
    });
}

const CLASH_PROFILE_SECTIONS = ['proxy-groups', 'rules', 'proxies', 'proxy-providers'];

/**
 * 判断模板文本是否是完整的 Clash/Mihomo 配置。
 * 不要求 proxy-groups 与 rules 同时齐全：远程模板可能只提供其中一部分，
 * 但其中的静态 proxies 仍然需要保留，不能回退到内置渲染把它们覆盖掉。
 */
export function isClashYamlProfileTemplate(templateText) {
    if (typeof templateText !== 'string' || templateText.trim() === '') return false;

    try {
        const parsed = yaml.load(templateText);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;

        const hasProfileSection = CLASH_PROFILE_SECTIONS.some((key) => key in parsed);
        if (!hasProfileSection) return false;

        // 至少有一项是 Clash 配置特有的数组/对象结构，避免把普通 YAML 文档误判为配置模板。
        return (
            Array.isArray(parsed['proxy-groups']) ||
            Array.isArray(parsed.rules) ||
            Array.isArray(parsed.proxies) ||
            (parsed['proxy-providers'] &&
                typeof parsed['proxy-providers'] === 'object' &&
                !Array.isArray(parsed['proxy-providers']))
        );
    } catch {
        return false;
    }
}

export function renderClashYamlProfileTemplate(templateText, nodeList, options = {}) {
    const config = yaml.load(templateText);
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        return '';
    }

    const nodeUrls = String(nodeList || '')
        .split(/\r?\n+/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'));
    const proxies = urlsToClashProxies(nodeUrls, options).map(stripInternalProxyFields);
    deduplicateProxyNames(proxies);

    return yaml.dump(
        {
            ...config,
            'allow-lan': false,
            'bind-address': '127.0.0.1',
            ipv6: false,
            'external-controller': '127.0.0.1:9090',
            dns: resolveSafeDnsConfig(config.dns, {
                mode: options.dnsMode,
                proxyGroup: '🌐 DNS 出口',
            }),
            proxies: mergeClashProxyLists(config.proxies, proxies, [], []),
        },
        {
            indent: 2,
            lineWidth: -1,
            noRefs: true,
            quotingType: '"',
            forceQuotes: false,
        }
    );
}

function mergeNamedEntries(baseEntries, overlayEntries) {
    const merged = new Map();
    const unnamed = [];

    for (const entry of [
        ...(Array.isArray(baseEntries) ? baseEntries : []),
        ...(Array.isArray(overlayEntries) ? overlayEntries : []),
    ]) {
        if (!entry || typeof entry !== 'object') continue;
        const name = String(entry.name || '').trim();
        if (!name) {
            unnamed.push(entry);
            continue;
        }
        merged.set(name, entry);
    }

    return [...merged.values(), ...unnamed];
}

function mergeClashProxyLists(baseProxies, overlayProxies, overlayGroups, overlayRules) {
    const merged = Array.isArray(baseProxies)
        ? baseProxies.filter((proxy) => proxy && typeof proxy === 'object')
        : [];
    const usedNames = new Set(
        merged.map((proxy) => String(proxy.name || '').trim()).filter(Boolean)
    );
    const renamedNames = new Map();

    for (const proxy of Array.isArray(overlayProxies) ? overlayProxies : []) {
        if (!proxy || typeof proxy !== 'object') continue;
        const originalName = String(proxy.name || '').trim();
        if (!originalName || !usedNames.has(originalName)) {
            merged.push(proxy);
            if (originalName) usedNames.add(originalName);
            continue;
        }

        let candidate = `${originalName} (MiSub)`;
        let suffix = 2;
        while (usedNames.has(candidate)) {
            candidate = `${originalName} (MiSub ${suffix++})`;
        }
        renamedNames.set(originalName, candidate);
        merged.push({ ...proxy, name: candidate });
        usedNames.add(candidate);
    }

    if (renamedNames.size > 0) {
        for (const group of Array.isArray(overlayGroups) ? overlayGroups : []) {
            if (Array.isArray(group.proxies)) {
                group.proxies = group.proxies.map((name) => renamedNames.get(name) || name);
            }
        }
        for (
            let ruleIndex = 0;
            ruleIndex < (Array.isArray(overlayRules) ? overlayRules.length : 0);
            ruleIndex += 1
        ) {
            const rule = overlayRules[ruleIndex];
            if (typeof rule !== 'string') continue;
            const parts = rule.split(',');
            for (let index = 0; index < parts.length; index += 1) {
                const trimmed = parts[index].trim();
                if (!renamedNames.has(trimmed)) continue;
                const leadingWhitespace = parts[index].match(/^\s*/)?.[0] || '';
                const trailingWhitespace = parts[index].match(/\s*$/)?.[0] || '';
                parts[index] = `${leadingWhitespace}${renamedNames.get(trimmed)}${trailingWhitespace}`;
            }
            overlayRules[ruleIndex] = parts.join(',');
        }
    }

    return merged;
}

function filterProxyProviders(proxyProviders, groups) {
    const entries = Object.entries(
        proxyProviders && typeof proxyProviders === 'object' ? proxyProviders : {}
    ).filter(([, provider]) => {
        if (!provider || typeof provider !== 'object') return false;
        const type = String(provider.type || '').toLowerCase();
        const url = String(provider.url || '').trim();
        const path = String(provider.path || '').trim();

        if (type === 'http') return Boolean(url);
        if (type === 'file') return Boolean(path);
        return Boolean(url || path);
    });
    const validNames = new Set(entries.map(([name]) => name));

    for (const group of Array.isArray(groups) ? groups : []) {
        if (!Array.isArray(group.use)) continue;
        const validUses = group.use.filter((name) => validNames.has(name));
        if (validUses.length > 0) group.use = validUses;
        else delete group.use;
    }

    return Object.fromEntries(entries);
}

/**
 * 将完整 Clash YAML 作为基础配置，并用 INI 模板生成的节点、策略组和规则覆盖动态部分。
 * 基础 YAML 负责网络、DNS、TUN、Hosts 等配置；INI 负责动态代理与分流。
 */
export function renderClashYamlWithIniOverlay(
    baseTemplateText,
    iniTemplateText,
    nodeList,
    options = {}
) {
    if (!isClashYamlProfileTemplate(baseTemplateText)) {
        throw new Error('Clash YAML 基础模板无效：必须包含 proxies / proxy-groups / rules 等配置段');
    }

    const baseConfig = yaml.load(baseTemplateText);
    const overlayText = renderClashFromIniTemplate(iniTemplateText, {
        ...options,
        nodeList,
        targetFormat: 'clash',
    });
    const overlayConfig = yaml.load(overlayText);

    if (!overlayConfig || typeof overlayConfig !== 'object' || Array.isArray(overlayConfig)) {
        throw new Error('INI 规则模板未能生成有效的 Clash 配置');
    }

    const overlayGroups = Array.isArray(overlayConfig['proxy-groups'])
        ? overlayConfig['proxy-groups']
        : [];
    const mergedGroups = mergeNamedEntries(baseConfig['proxy-groups'], overlayGroups);
    const overlayRules = Array.isArray(overlayConfig.rules) ? overlayConfig.rules : [];
    const mergedProxies = mergeClashProxyLists(
        baseConfig.proxies,
        overlayConfig.proxies,
        overlayGroups,
        overlayRules
    );
    const mergedRuleProviders = {
        ...(baseConfig['rule-providers'] || {}),
        ...(overlayConfig['rule-providers'] || {}),
    };
    const mergedProxyProviders = filterProxyProviders(
        {
            ...(baseConfig['proxy-providers'] || {}),
            ...(overlayConfig['proxy-providers'] || {}),
        },
        mergedGroups
    );

    const mergedConfig = {
        ...overlayConfig,
        ...baseConfig,
        proxies: mergedProxies,
        'proxy-groups': mergedGroups,
        rules: overlayRules.length > 0 ? overlayRules : baseConfig.rules,
    };

    if (Object.keys(mergedRuleProviders).length > 0) {
        mergedConfig['rule-providers'] = mergedRuleProviders;
    } else {
        delete mergedConfig['rule-providers'];
    }

    if (Object.keys(mergedProxyProviders).length > 0) {
        mergedConfig['proxy-providers'] = mergedProxyProviders;
    } else {
        delete mergedConfig['proxy-providers'];
    }

    // 默认保留基础 YAML 的 DNS；仅在用户显式配置自定义 DNS 时采用 INI 渲染结果。
    if (String(options.customDnsOverride || '').trim() && overlayConfig.dns) {
        mergedConfig.dns = overlayConfig.dns;
    }

    return yaml.dump(mergedConfig, {
        indent: 2,
        lineWidth: -1,
        noRefs: true,
        quotingType: '"',
        forceQuotes: false,
    });
}

export class ProcessorService {
    /**
     * Generate nodes based on target format and configuration
     * @param {Object} context
     * @param {Object} config
     * @param {Object} params
     */
    static async processNodes(context, config, params) {
        const {
            userAgent,
            targetMisubs,
            prependedContent,
            generationSettings,
            isDebugToken,
            shouldSkipCertVerify,
        } = params;

        // 1. Fetch and combine nodes
        const combinedNodeList = await generateCombinedNodeList(
            context,
            { ...config, enableAccessLog: false },
            userAgent,
            targetMisubs,
            prependedContent,
            generationSettings,
            isDebugToken,
            shouldSkipCertVerify
        );

        return combinedNodeList;
    }

    /**
     * Render the combined node list into the final format
     * @param {Object} options
     */
    static async renderOutput(options) {
        const {
            targetFormat,
            combinedNodeList,
            subName,
            config,
            builtinOptions = {},
            templateSource = { kind: 'none', value: '' },
            managedConfigUrl,
            storageAdapter,
            userInfoHeader,
        } = options || {};

        // Check for Base64 (simplest case)
        if (targetFormat === 'base64') {
            return {
                content: base64EncodeUtf8(combinedNodeList),
                contentType: 'text/plain; charset=utf-8',
                headers: userInfoHeader ? { 'Subscription-Userinfo': userInfoHeader } : {},
            };
        }

        // Handle built-in generation with optional templates
        const builtinProxyContent = transformBuiltinSubscription(combinedNodeList, targetFormat, {
            ...builtinOptions,
            managedConfigUrl,
        });

        if (!builtinProxyContent) {
            // Fallback to raw Base64 if generator fails
            return {
                content: base64EncodeUtf8(combinedNodeList),
                contentType: 'text/plain; charset=utf-8',
                headers: userInfoHeader ? { 'Subscription-Userinfo': userInfoHeader } : {},
            };
        }

        let finalContent = builtinProxyContent;
        let contentType = 'text/plain; charset=utf-8';
        const headers = userInfoHeader ? { 'Subscription-Userinfo': userInfoHeader } : {};

        const shouldApplyTemplate = !builtinOptions.hiddifyCompatible;
        const builtinTemplateEntry =
            shouldApplyTemplate && templateSource.kind === 'builtin'
                ? getBuiltinTemplate(templateSource.value)
                : null;
        const customTemplateEntry =
            shouldApplyTemplate && templateSource.kind === 'custom'
                ? await resolveRuleTemplateSource(storageAdapter, templateSource)
                : null;
        const remoteTemplateUrl =
            shouldApplyTemplate && templateSource.kind === 'remote' ? templateSource.value : '';

        if (builtinTemplateEntry || customTemplateEntry || remoteTemplateUrl) {
            const templateText =
                builtinTemplateEntry?.content ||
                customTemplateEntry?.content ||
                (await fetchTransformTemplate(storageAdapter, remoteTemplateUrl));
            // 以模板内容为准：远程 / 内置模板即使被标记为 ini，只要内容是完整 Clash 配置，
            // 就按 YAML profile 渲染，避免静态 proxies 被内置渲染覆盖。
            const isYamlProfileTemplate =
                targetFormat === 'clash' && isClashYamlProfileTemplate(templateText);
            const isIniTemplate =
                !isYamlProfileTemplate &&
                (hasIniTemplateShape(templateText) ||
                    isIniTemplateSource(templateSource, builtinTemplateEntry || customTemplateEntry));

            if (templateText && !isIniTemplate && !isYamlProfileTemplate) {
                console.warn(
                    '[Template] 无法识别的模板格式，已回退到内置渲染（模板中的静态配置不会保留）'
                );
            }

            if (templateText && isIniTemplate) {
                const renderParams = {
                    nodeList: combinedNodeList,
                    fileName: subName,
                    targetFormat,
                    ruleLevel: builtinOptions.ruleLevel,
                    interval: config.UpdateInterval || 86400,
                    managedConfigUrl,
                    skipCertVerify: builtinOptions.skipCertVerify,
                    enableUdp: builtinOptions.enableUdp,
                    isMeta: builtinOptions.isMeta,
                    customDnsOverride: builtinOptions.customDnsOverride || '',
                    dnsMode: builtinOptions.dnsMode || 'clean',
                };
                const clashBaseTemplateUrl =
                    targetFormat === 'clash'
                        ? String(config.clashBaseTemplateUrl || '').trim()
                        : '';

                if (clashBaseTemplateUrl) {
                    const baseTemplateText = await fetchTransformTemplate(
                        storageAdapter,
                        clashBaseTemplateUrl
                    );
                    finalContent = renderClashYamlWithIniOverlay(
                        baseTemplateText,
                        templateText,
                        combinedNodeList,
                        renderParams
                    );
                    contentType = 'application/x-yaml; charset=utf-8';
                    headers['X-MiSub-Template-Mode'] = 'clash-yaml-ini-overlay';
                } else {
                    switch (targetFormat) {
                        case 'clash':
                            finalContent = renderClashFromIniTemplate(templateText, renderParams);
                            contentType = 'application/x-yaml; charset=utf-8';
                            break;
                        case 'singbox':
                        case 'sing-box':
                            finalContent = renderSingboxFromIniTemplate(templateText, renderParams);
                            contentType = 'application/json; charset=utf-8';
                            break;
                        case 'surge':
                        case 'surge&ver=4':
                            finalContent = renderSurgeFromIniTemplate(templateText, renderParams);
                            break;
                        case 'loon':
                            finalContent = renderLoonFromIniTemplate(templateText, renderParams);
                            break;
                        case 'quanx':
                            finalContent = renderQuanxFromIniTemplate(templateText, renderParams);
                            break;
                        case 'egern':
                            finalContent = renderEgernFromIniTemplate(templateText, renderParams);
                            contentType = 'application/x-yaml; charset=utf-8';
                            break;
                    }
                }
            } else if (templateText && isYamlProfileTemplate) {
                finalContent = renderClashYamlProfileTemplate(
                    templateText,
                    combinedNodeList,
                    builtinOptions
                );
                contentType = 'application/x-yaml; charset=utf-8';
                headers['X-MiSub-Template-Mode'] = 'clash-yaml-profile';
            }
        } else if (shouldApplyTemplate && targetFormat === 'clash') {
            // 只配置了 Clash YAML 基础模板、没有选择规则模板时，直接以基础模板渲染，
            // 避免回退到内置渲染把模板里的静态节点覆盖掉。
            const clashBaseTemplateUrl = String(config.clashBaseTemplateUrl || '').trim();
            if (clashBaseTemplateUrl) {
                try {
                    const baseTemplateText = await fetchTransformTemplate(
                        storageAdapter,
                        clashBaseTemplateUrl
                    );
                    if (isClashYamlProfileTemplate(baseTemplateText)) {
                        finalContent = renderClashYamlProfileTemplate(
                            baseTemplateText,
                            combinedNodeList,
                            builtinOptions
                        );
                        contentType = 'application/x-yaml; charset=utf-8';
                        headers['X-MiSub-Template-Mode'] = 'clash-yaml-profile';
                    } else {
                        console.warn(
                            '[Template] Clash YAML 基础模板格式无效，已回退到内置渲染（模板中的静态配置不会保留）'
                        );
                    }
                } catch (err) {
                    console.warn(
                        '[Template] Clash YAML 基础模板拉取失败，已回退到内置渲染：',
                        err?.message || err
                    );
                }
            }
        }

        // Set proper content type for built-in formats if not set by template
        if (contentType === 'text/plain; charset=utf-8') {
            if (targetFormat === 'clash' || targetFormat === 'egern')
                contentType = 'application/x-yaml; charset=utf-8';
            else if (targetFormat === 'singbox' || targetFormat === 'sing-box')
                contentType = 'application/json; charset=utf-8';
        }

        return {
            content: finalContent,
            contentType,
            headers,
        };
    }
}
