import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { parseIniTemplate } from '../../functions/modules/subscription/template-parsers/ini-template-parser.js';
import { ProcessorService } from '../../functions/services/processor-service.js';

const TEMPLATE = readFileSync(
    new URL('../../docs/examples/provider-region-groups.ini', import.meta.url),
    'utf8'
);

const NODE_LIST = [
    'trojan://pass@1.1.1.1:443#%E8%89%AF%E5%BF%83%E4%BA%91%20%7C%20%F0%9F%87%AD%F0%9F%87%B0%20%E9%A6%99%E6%B8%AF01',
    'trojan://pass@2.2.2.2:443#%E8%89%AF%E5%BF%83%E4%BA%91%20%7C%20%F0%9F%87%AF%F0%9F%87%B5%20%E6%97%A5%E6%9C%AC01',
    'trojan://pass@3.3.3.3:443#AshCloud%20%7C%20%F0%9F%87%AD%F0%9F%87%B0%20%E9%A6%99%E6%B8%AF01',
    'trojan://pass@4.4.4.4:443#AshCloud%20%7C%20%F0%9F%87%AF%F0%9F%87%B5%20%E6%97%A5%E6%9C%AC01',
    'trojan://pass@5.5.5.5:443#AshCloud%20%7C%20%F0%9F%87%B2%F0%9F%87%B4%20%E6%BE%B3%E9%97%A801',
].join('\n');

const BASE_TEMPLATE = `
mixed-port: 7890
proxies:
  - name: '🇨🇳 直连 | 双栈'
    type: direct
proxy-groups:
  - name: 默认代理
    type: select
    proxies: [香港, 日本]
    icon: https://example.com/default.svg
  - name: 手动选择
    type: select
    include-all: true
    exclude-type: DIRECT
    proxies: []
  - name: Google
    type: select
    proxies: [香港]
  - name: AI
    type: select
    default-selected: 美国
    proxies: [美国]
  - name: Telegram
    type: select
    proxies: [香港]
  - name: Steam
    type: select
    proxies: [DIRECT]
  - name: 漏网之鱼
    type: select
    proxies: [默认代理, 直连]
  - name: 香港
    type: select
    include-all: true
    filter: '香港|HK'
    proxies: [香港-自动选择]
    icon: https://example.com/hk.svg
  - name: 香港-自动选择
    type: url-test
    include-all: true
    filter: '香港|HK'
    url: http://www.gstatic.com/generate_204
    interval: 300
  - name: 台湾
    type: select
    include-all: true
    filter: '台湾|TW'
    proxies: [台湾-自动选择]
  - name: 台湾-自动选择
    type: url-test
    include-all: true
    filter: '台湾|TW'
    url: http://www.gstatic.com/generate_204
    interval: 300
  - name: 美国
    type: select
    include-all: true
    filter: '美国|US'
    proxies: [美国-自动选择]
  - name: 美国-自动选择
    type: url-test
    include-all: true
    filter: '美国|US'
    url: http://www.gstatic.com/generate_204
    interval: 300
  - name: 日本
    type: select
    include-all: true
    filter: '日本|JP'
    proxies: [日本-自动选择]
  - name: 日本-自动选择
    type: url-test
    include-all: true
    filter: '日本|JP'
    url: http://www.gstatic.com/generate_204
    interval: 300
  - name: 新加坡
    type: select
    include-all: true
    filter: '新加坡|SG'
    proxies: [新加坡-自动选择]
  - name: 新加坡-自动选择
    type: url-test
    include-all: true
    filter: '新加坡|SG'
    url: http://www.gstatic.com/generate_204
    interval: 300
rules:
  - MATCH,默认代理
rule-providers:
  BASE:
    type: http
    behavior: domain
    url: https://example.com/base.yaml
    path: ./ruleset/base.yaml
`;

function createMemoryStorage(initial = {}) {
    const data = new Map(Object.entries(initial));
    return {
        get: vi.fn(async (key) => (data.has(key) ? data.get(key) : null)),
        put: vi.fn(async (key, value) => {
            data.set(key, value);
            return true;
        }),
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe('机场与机场-地区 INI 模板', () => {
    it('parses append groups and typed group options', () => {
        const model = parseIniTemplate(TEMPLATE, { targetFormat: 'clash' });
        const appendDefault = model.groups.find(
            (group) => group.name === '默认代理' && group.mergeMode === 'append'
        );
        const autoJapan = model.groups.find((group) => group.name === 'AshCloud-日本-自动选择');

        expect(appendDefault.members).toContain('AshCloud');
        expect(appendDefault.members).toContain('AshCloud-日本');
        expect(autoJapan.options).toMatchObject({
            'include-all': true,
            interval: 300,
            tolerance: 50,
        });
        expect(autoJapan.filters[0]).toContain('(?i)^AshCloud');
        expect(autoJapan.filters[0]).toContain('JP');
    });

    it(
        'creates source/region groups and appends them without replacing base group settings or rules',
        async () => {
            const storageAdapter = createMemoryStorage({
                misub_rule_templates_v1: [
                    {
                        id: 'provider-region',
                        name: '机场与地区分组',
                        type: 'ini',
                        content: TEMPLATE,
                        enabled: true,
                    },
                ],
            });
    
            vi.stubGlobal(
                'fetch',
                vi.fn(async () => new Response(BASE_TEMPLATE, { status: 200 }))
            );
    
            const result = await ProcessorService.renderOutput({
                targetFormat: 'clash',
                combinedNodeList: NODE_LIST,
                subName: 'Provider Region Test',
                config: {
                    UpdateInterval: 86400,
                    clashBaseTemplateUrl: 'https://example.com/base.yaml',
                },
                builtinOptions: {
                    ruleLevel: 'std',
                    enableUdp: true,
                    skipCertVerify: false,
                },
                templateSource: { kind: 'custom', value: 'provider-region' },
                managedConfigUrl: 'https://example.com/sub?target=clash',
                storageAdapter,
            });
    
            const parsed = yaml.load(result.content);
            const groups = new Map(parsed['proxy-groups'].map((group) => [group.name, group]));
            const defaultGroup = groups.get('默认代理');
            const aiGroup = groups.get('AI');
            const hkGroup = groups.get('香港');
            const hkAutoGroup = groups.get('香港-自动选择');
    
            expect(parsed.proxies.map((proxy) => proxy.name)).toEqual(
                expect.arrayContaining([
                    '🇨🇳 直连 | 双栈',
                    '良心云 | 🇭🇰 香港01',
                    '良心云 | 🇯🇵 日本01',
                    'AshCloud | 🇭🇰 香港01',
                    'AshCloud | 🇯🇵 日本01',
                    'AshCloud | 🇲🇴 澳门01',
                ])
            );
    
            expect(defaultGroup.proxies).toEqual(
                expect.arrayContaining([
                    '香港',
                    '日本',
                    '良心云',
                    'AshCloud',
                    '良心云-日本',
                    'AshCloud-澳门',
                ])
            );
            expect(defaultGroup.icon).toBe('https://example.com/default.svg');
            expect(aiGroup['default-selected']).toBe('美国');
            expect(aiGroup.proxies).toEqual(
                expect.arrayContaining(['美国', 'AshCloud', 'AshCloud-日本', '良心云-日本'])
            );
            expect(hkGroup.icon).toBe('https://example.com/hk.svg');
            expect(hkGroup.filter).toBe('香港|HK');
            expect(hkGroup.proxies).toEqual(
                expect.arrayContaining(['香港-自动选择', '良心云-香港', 'AshCloud-香港'])
            );
            expect(hkAutoGroup.type).toBe('url-test');
            expect(hkAutoGroup.filter).toBe('香港|HK');
            expect(hkAutoGroup.proxies).toEqual(
                expect.arrayContaining(['良心云-香港', 'AshCloud-香港'])
            );
            expect(groups.has('良心云-日本')).toBe(true);
            expect(groups.has('AshCloud-澳门')).toBe(true);
            expect(groups.has('良心云-澳门')).toBe(false);
            expect(parsed.rules).toEqual(['MATCH,默认代理']);
            expect(parsed['rule-providers'].BASE.url).toBe('https://example.com/base.yaml');
            expect(parsed['proxy-groups'].some((group) => group.name === '🌐 DNS 出口')).toBe(false);
            }
    );
});
