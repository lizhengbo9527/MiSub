import { parseNodeList } from '../utils/node-parser.js';
import { fetchWithRetry } from '../../services/fetch-utils.js';
import { buildFetchProxyUrl } from '../../utils/fetch-proxy-utils.js';
import { getOrFetchSubscriptionNodes } from '../../services/subscription-node-cache-service.js';
import {
    filterNodeObjects,
    parseFilterRuleText,
    encodeArrayBufferToBase64,
} from '../utils/node-cleaner.js';

function parseUserInfoHeader(value) {
    if (!value) return null;
    const info = {};
    value.split(';').forEach((part) => {
        const [key, rawValue] = part.trim().split('=');
        if (key && rawValue !== undefined) {
            info[key] = /^\d+$/.test(rawValue) ? Number(rawValue) : rawValue;
        }
    });
    return Object.keys(info).length ? info : null;
}

/**
 * 获取单个订阅的节点。
 *
 * cacheOptions.storage / cacheOptions.subscription 使预览入口与最终订阅共用单机场缓存。
 */
export async function fetchSubscriptionNodes(
    url,
    subscriptionName,
    userAgent,
    customUserAgent = null,
    debug = false,
    excludeRules = '',
    fetchProxy = null,
    skipCertVerify = false,
    plusAsSpace = false,
    enableNodeCache = false,
    cacheOptions = {}
) {
    const shouldDebug = debug || (url && url.includes('b0b422857bb46aba65da8234c84f38c6'));

    try {
        const effectiveUserAgent =
            customUserAgent && customUserAgent.trim() !== '' ? customUserAgent : userAgent;

        const fetchNodes = async () => {
            let requestUrl = url;

            // 仅强制刷新时绕过机场/CDN 自身缓存。
            if (cacheOptions.forceRefresh) {
                try {
                    const parsedUrl = new URL(requestUrl);
                    parsedUrl.searchParams.set('_t', Date.now().toString());
                    requestUrl = parsedUrl.toString();
                } catch {
                    requestUrl += (requestUrl.includes('?') ? '&' : '?') + '_t=' + Date.now();
                }
            }

            if (fetchProxy && typeof fetchProxy === 'string' && fetchProxy.trim()) {
                requestUrl = buildFetchProxyUrl(fetchProxy, requestUrl, effectiveUserAgent);
            }

            const response = await fetchWithRetry(requestUrl, {
                headers: { 'User-Agent': effectiveUserAgent },
                redirect: 'follow',
                ...(skipCertVerify ? { cf: { insecureSkipVerify: true } } : {}),
            });

            if (!response.ok) {
                const error = new Error(`HTTP ${response.status}: ${response.statusText}`);
                error.status = response.status;
                error.retryAfter = response.headers.get('retry-after');
                throw error;
            }

            const buffer = await response.arrayBuffer();
            const text = new TextDecoder('utf-8').decode(buffer);

            let parsedNodes = parseNodeList(text, { plusAsSpace });
            if (parsedNodes.length === 0) {
                const fallbackBase64 = encodeArrayBufferToBase64(buffer);
                const fallbackNodes = parseNodeList(fallbackBase64, { plusAsSpace });
                if (fallbackNodes.length > 0) parsedNodes = fallbackNodes;
            }

            return {
                nodes: parsedNodes.map((node) => node.url).filter(Boolean),
                metadata: {
                    userInfo: parseUserInfoHeader(response.headers.get('subscription-userinfo')),
                },
            };
        };

        let resolved;
        if (cacheOptions.storage) {
            resolved = await getOrFetchSubscriptionNodes({
                storage: cacheOptions.storage,
                lockStorage: cacheOptions.lockStorage || cacheOptions.storage,
                subscription: cacheOptions.subscription || { url },
                fetchNodes,
                forceRefresh: cacheOptions.forceRefresh === true,
                knownNodeCount: Number(cacheOptions.subscription?.nodeCount) || 0,
            });
        } else {
            resolved = await fetchNodes();
            resolved = {
                ...resolved,
                nodeCount: resolved.nodes.length,
                fromCache: false,
                cacheStatus: 'BYPASS',
            };
        }

        let parsedNodes = parseNodeList((resolved.nodes || []).join('\n'), { plusAsSpace });

        if (excludeRules && excludeRules.trim()) {
            parsedNodes = applyExcludeRulesToNodes(parsedNodes, excludeRules);
        }

        return {
            subscriptionName,
            url,
            success: true,
            nodes: parsedNodes,
            error: resolved.error || null,
            cacheStatus: resolved.cacheStatus,
            fromCache: resolved.fromCache,
            userInfo: resolved.metadata?.userInfo || null,
        };
    } catch (error) {
        if (shouldDebug) {
            console.debug(`[DEBUG PREVIEW] Error: ${error.message}`);
        }
        return {
            subscriptionName,
            url,
            success: false,
            nodes: [],
            error: error.message,
        };
    }
}

/**
 * 应用过滤规则 (使用 node-cleaner 的重构逻辑)
 * @param {Array} nodes
 * @param {string} ruleText
 */
function applyExcludeRulesToNodes(nodes, ruleText) {
    if (!ruleText || !ruleText.trim()) return nodes;
    const { includeRules, excludeRules } = parseFilterRuleText(ruleText);

    let resultNodes = nodes;

    if (includeRules.hasRules) {
        resultNodes = filterNodeObjects(resultNodes, includeRules, 'include');
    }
    if (excludeRules.hasRules) {
        resultNodes = filterNodeObjects(resultNodes, excludeRules, 'exclude');
    }

    return resultNodes;
}
