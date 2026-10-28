import { describe, expect, it, vi } from 'vitest';
import yaml from 'js-yaml';
import {
    normalizeCustomRuleTemplates,
    resolveRuleTemplateSource,
    handleRuleTemplatesRequest,
} from '../../functions/modules/rule-template-handler.js';
import { ProcessorService } from '../../functions/services/processor-service.js';

const NODE_LIST = 'trojan://pass@1.1.1.1:443#HK-01';

function createMemoryStorage(initial = {}) {
    const data = new Map(Object.entries(initial));
    return {
        get: vi.fn(async (key) => (data.has(key) ? data.get(key) : null)),
        put: vi.fn(async (key, value) => {
            data.set(key, value);
            return true;
        }),
        delete: vi.fn(async (key) => data.delete(key)),
        dump: () => Object.fromEntries(data.entries()),
    };
}

describe('自定义规则模板 Phase 1 后端模型/API/渲染', () => {
    it('normalizes templates and rejects invalid content', () => {
        const templates = normalizeCustomRuleTemplates([
            {
                id: ' tpl 01 ',
                name: ' 我的模板 ',
                type: 'ini',
                content:
                    '[Proxy Group]\n🚀 节点选择 = select, []AUTO, DIRECT\n\n[Rule]\nMATCH,🚀 节点选择',
                description: ' demo ',
                enabled: true,
            },
            { id: 'bad', name: 'bad', content: '' },
        ]);

        expect(templates).toHaveLength(1);
        expect(templates[0]).toMatchObject({
            id: 'tpl-01',
            name: '我的模板',
            type: 'ini',
            description: 'demo',
            enabled: true,
        });
        expect(templates[0].content).toContain('[Proxy Group]');
        expect(templates[0].updatedAt).toEqual(expect.any(String));
    });

    it('provides authenticated CRUD API for custom rule templates', async () => {
        const storage = createMemoryStorage();
        const env = { __TEST_STORAGE_ADAPTER: storage };

        const saveReq = new Request('https://example.com/api/rule_templates', {
            method: 'POST',
            body: JSON.stringify({
                templates: [
                    {
                        id: 'tpl-a',
                        name: '自定义规则模板 A',
                        content:
                            '[Proxy Group]\n🚀 节点选择 = select, []AUTO, DIRECT\n\n[Rule]\nMATCH,🚀 节点选择',
                    },
                ],
            }),
        });

        const saveResp = await handleRuleTemplatesRequest(saveReq, env);
        const saveJson = await saveResp.json();
        expect(saveJson.success).toBe(true);
        expect(saveJson.data).toHaveLength(1);
        expect(storage.put).toHaveBeenCalledWith('misub_rule_templates_v1', expect.any(Array));

        const getResp = await handleRuleTemplatesRequest(
            new Request('https://example.com/api/rule_templates'),
            env
        );
        const getJson = await getResp.json();
        expect(getJson.success).toBe(true);
        expect(getJson.data[0].name).toBe('自定义规则模板 A');
    });

    it('resolves custom template source and renders clash yaml without remote fetch', async () => {
        const storageAdapter = createMemoryStorage({
            misub_rule_templates_v1: [
                {
                    id: 'tpl-a',
                    name: '本地模板',
                    type: 'ini',
                    content:
                        '[Proxy Group]\n🚀 节点选择 = select, []AUTO, DIRECT\n\n[Rule]\nMATCH,🚀 节点选择',
                },
            ],
        });
        global.fetch = vi.fn();

        const source = await resolveRuleTemplateSource(storageAdapter, {
            kind: 'custom',
            value: 'tpl-a',
        });
        expect(source.content).toContain('[Proxy Group]');

        const result = await ProcessorService.renderOutput({
            targetFormat: 'clash',
            combinedNodeList: NODE_LIST,
            subName: 'Demo',
            config: { UpdateInterval: 86400 },
            builtinOptions: { ruleLevel: 'none', enableUdp: true, skipCertVerify: false },
            templateSource: { kind: 'custom', value: 'tpl-a' },
            managedConfigUrl: 'https://example.com/sub',
            storageAdapter,
        });

        expect(fetch).not.toHaveBeenCalled();
        expect(result.contentType).toBe('application/x-yaml; charset=utf-8');
        const parsed = yaml.load(result.content);
        expect(parsed['proxy-groups'].some((group) => group.name === '🚀 节点选择')).toBe(true);
        expect(parsed.rules).toContain('MATCH,🚀 节点选择');
    });

    it('merges a remote Clash YAML base with a saved INI rule template', async () => {
        const baseTemplate = `
common_group: &common_group
  type: select
  proxies:
    - DIRECT
mixed-port: 7890
allow-lan: true
bind-address: '*'
ipv6: true
dns:
  enable: true
  nameserver:
    - https://dns.example/dns-query
proxies:
  - name: '🇨🇳 直连 | 双栈'
    type: direct
proxy-providers:
  provider1:
    type: http
    url: ''
    path: ./proxy_provider/provider1.yaml
proxy-groups:
  - name: '基础策略组'
    <<: *common_group
rules:
  - MATCH,基础策略组
rule-providers:
  BASE:
    type: http
    behavior: domain
    url: https://example.com/base.yaml
`;
        const storageAdapter = createMemoryStorage({
            misub_rule_templates_v1: [
                {
                    id: 'tpl-a',
                    name: '本地模板',
                    type: 'ini',
                    content: [
                        '[Proxy Group]',
                        '🚀 节点选择 = select, HK-01, DIRECT',
                        '',
                        '[Rule]',
                        'MATCH,🚀 节点选择',
                    ].join('\n'),
                },
            ],
        });
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response(baseTemplate, { status: 200 }))
        );

        const result = await ProcessorService.renderOutput({
            targetFormat: 'clash',
            combinedNodeList: NODE_LIST,
            subName: 'Demo',
            config: {
                UpdateInterval: 86400,
                clashBaseTemplateUrl: 'https://example.com/base.yaml',
            },
            builtinOptions: { ruleLevel: 'none', enableUdp: true, skipCertVerify: false },
            templateSource: { kind: 'custom', value: 'tpl-a' },
            managedConfigUrl: 'https://example.com/sub',
            storageAdapter,
        });

        const parsed = yaml.load(result.content);
        expect(result.contentType).toBe('application/x-yaml; charset=utf-8');
        expect(result.headers['X-MiSub-Template-Mode']).toBe('clash-yaml-ini-overlay');
        expect(parsed['mixed-port']).toBe(7890);
        expect(parsed['allow-lan']).toBe(true);
        expect(parsed['bind-address']).toBe('*');
        expect(parsed.ipv6).toBe(true);
        expect(parsed.dns.nameserver).toContain('https://dns.example/dns-query');
        expect(parsed.proxies.some((proxy) => proxy.name === '🇨🇳 直连 | 双栈')).toBe(true);
        expect(parsed.proxies.some((proxy) => proxy.name === '🇭🇰 HK-01')).toBe(true);
        expect(parsed['proxy-groups'].some((group) => group.name === '基础策略组')).toBe(true);
        expect(parsed['proxy-groups'].some((group) => group.name === '🚀 节点选择')).toBe(true);
        expect(parsed.rules).toContain('MATCH,🚀 节点选择');
        expect(parsed.rules).not.toContain('MATCH,基础策略组');
        expect(parsed['rule-providers'].BASE.url).toBe('https://example.com/base.yaml');
        expect(parsed['proxy-providers']).toBeUndefined();
    });

});
