import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    buildSubscriptionNodeCacheKey,
    generateCombinedNodeList,
    isRealProxyNode,
    parseSubscriptionUserInfoHeader,
} from '../../functions/services/subscription-service.js';

function createMemoryStorage(initial = {}) {
    const prefix = 'node_cache_subscription_url_';
    const entries = Object.entries(initial).map(([key, value]) => {
        if (key.startsWith(prefix) && value && Array.isArray(value.nodes)) {
            return [
                key,
                {
                    ...value,
                    version: 2,
                    urlHash: key.slice(prefix.length),
                    updatedAt:
                        Number(value.updatedAt) ||
                        Date.parse(value.updatedAt) ||
                        Date.now() - 7 * 60 * 60 * 1000,
                    retryAfter: 0,
                    failureCount: 0,
                    metadata: value.metadata || {},
                },
            ];
        }
        return [key, value];
    });
    const store = new Map(entries);
    return {
        store,
        async get(key) {
            return store.has(key) ? store.get(key) : null;
        },
        async put(key, value) {
            store.set(key, value);
            return true;
        },
        async delete(key) {
            store.delete(key);
            return true;
        },
    };
}

describe('subscription protective node cache', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('识别真实代理节点，排除系统伪节点', () => {
        expect(isRealProxyNode('trojan://pass@example.com:443#HK')).toBe(true);
        expect(isRealProxyNode('vmess://eyJhZGQiOiJleGFtcGxlLmNvbSJ9')).toBe(true);
        expect(
            isRealProxyNode('trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#伪节点')
        ).toBe(false);
        expect(
            isRealProxyNode('vless://00000000-0000-0000-0000-000000000000@[::1]:443#伪节点')
        ).toBe(false);
        expect(isRealProxyNode('127.0.0.1:8080#剩余流量')).toBe(false);
        expect(isRealProxyNode('到期时间：2099-01-01')).toBe(false);
        expect(isRealProxyNode('')).toBe(false);
    });

    it('解析机场返回的 subscription-userinfo 响应头', () => {
        expect(
            parseSubscriptionUserInfoHeader('upload=1; download=2; total=100; expire=200')
        ).toEqual({
            upload: 1,
            download: 2,
            total: 100,
            expire: 200,
        });
        expect(parseSubscriptionUserInfoHeader('')).toBeNull();
    });

    it('首次拉取真实节点后写入按订阅 URL 共享的机场缓存', async () => {
        const storage = createMemoryStorage();
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response('trojan://pass@example.com:443#HK', { status: 200 }))
        );

        const result = await generateCombinedNodeList(
            { storage },
            { enableAccessLog: false, enableFlagEmoji: false },
            'ClashMeta',
            [
                {
                    id: 'sub-a',
                    name: '机场A',
                    url: 'https://example.com/sub',
                    enabled: true,
                    enableNodeCache: true,
                },
            ],
            '',
            { enableSubscriptions: false },
            false
        );

        const cache = await storage.get(
            buildSubscriptionNodeCacheKey({ id: 'sub-a', url: 'https://example.com/sub' })
        );
        expect(result.trim()).toBe('trojan://pass@example.com:443#HK');
        expect(cache.nodes).toEqual(['trojan://pass@example.com:443#HK']);
        expect(cache.nodeCount).toBe(1);
    });

    it('机场拉取失败时，使用该机场上次成功缓存', async () => {
        const storage = createMemoryStorage({
            [buildSubscriptionNodeCacheKey({ id: 'sub-a', url: 'https://example.com/sub' })]: {
                nodes: ['trojan://cached@example.com:443#Cached'],
                nodeCount: 1,
                updatedAt: '2026-01-01T00:00:00.000Z',
            },
        });
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response('Forbidden', { status: 403 }))
        );

        const result = await generateCombinedNodeList(
            { storage },
            { enableAccessLog: false, enableFlagEmoji: false },
            'ClashMeta',
            [
                {
                    id: 'sub-a',
                    name: '机场A',
                    url: 'https://example.com/sub',
                    enabled: true,
                    enableNodeCache: true,
                },
            ],
            '',
            { enableSubscriptions: false },
            false
        );

        expect(result.trim()).toBe('trojan://cached@example.com:443#Cached');
    });

    it('新结果只有伪节点不得覆盖旧缓存，并 fallback 旧缓存', async () => {
        const cacheKey = buildSubscriptionNodeCacheKey({
            id: 'sub-a',
            url: 'https://example.com/sub',
        });
        const storage = createMemoryStorage({
            [cacheKey]: {
                nodes: ['trojan://cached@example.com:443#Cached'],
                nodeCount: 1,
                updatedAt: '2026-01-01T00:00:00.000Z',
            },
        });
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response('127.0.0.1:8080#剩余流量', { status: 200 }))
        );

        const result = await generateCombinedNodeList(
            { storage },
            { enableAccessLog: false, enableFlagEmoji: false },
            'ClashMeta',
            [
                {
                    id: 'sub-a',
                    name: '机场A',
                    url: 'https://example.com/sub',
                    enabled: true,
                    enableNodeCache: true,
                },
            ],
            '',
            { enableSubscriptions: false },
            false
        );

        const cache = await storage.get(cacheKey);
        expect(result.trim()).toBe('trojan://cached@example.com:443#Cached');
        expect(cache.nodes).toEqual(['trojan://cached@example.com:443#Cached']);
    });

    it('外部拉取成功时，异步同步节点数和流量到前端订阅数据', async () => {
        const sub = {
            id: 'sub-a',
            name: '机场A',
            url: 'https://example.com/sub',
            enabled: true,
            enableNodeCache: true,
        };
        const storage = createMemoryStorage({
            misub_subscriptions_v1: [{ ...sub, nodeCount: 0, userInfo: null }],
        });
        const waitUntilPromises = [];
        vi.stubGlobal(
            'fetch',
            vi.fn(
                async () =>
                    new Response('trojan://pass@example.com:443#HK', {
                        status: 200,
                        headers: {
                            'subscription-userinfo': 'upload=1; download=2; total=100; expire=200',
                        },
                    })
            )
        );
        const context = {
            storage,
            waitUntil: (promise) => waitUntilPromises.push(promise),
        };

        const result = await generateCombinedNodeList(
            context,
            { enableAccessLog: false, enableFlagEmoji: false },
            'ClashMeta',
            [sub],
            '',
            { enableSubscriptions: false },
            false
        );

        expect(result.trim()).toBe('trojan://pass@example.com:443#HK');
        expect(waitUntilPromises).toHaveLength(1);
        expect(context.currentSubscriptionRuntimeInfo[sub.id].userInfo).toEqual({
            upload: 1,
            download: 2,
            total: 100,
            expire: 200,
        });

        await Promise.all(waitUntilPromises);

        const [updatedSub] = await storage.get('misub_subscriptions_v1');
        expect(updatedSub.nodeCount).toBe(1);
        expect(updatedSub.lastGoodNodeCount).toBeUndefined();
        expect(updatedSub.userInfo).toEqual({
            upload: 1,
            download: 2,
            total: 100,
            expire: 200,
        });
        expect(updatedSub.lastError).toBeNull();
        expect(typeof updatedSub.lastUpdate).toBe('string');
    });

    it('stores lastGoodNodeCount after a healthy user subscription refresh', async () => {
        const nodes = Array.from(
            { length: 12 },
            (_, index) => `trojan://pass${index}@node${index}.example.com:443#Node-${index}`
        ).join('\n');
        const sub = {
            id: 'sub-a',
            name: 'Airport A',
            url: 'https://example.com/sub',
            enabled: true,
        };
        const storage = createMemoryStorage({
            misub_subscriptions_v1: [{ ...sub, nodeCount: 0, userInfo: null }],
        });
        const waitUntilPromises = [];
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response(nodes, { status: 200 }))
        );

        await generateCombinedNodeList(
            { storage, waitUntil: (promise) => waitUntilPromises.push(promise) },
            { enableAccessLog: false, enableFlagEmoji: false },
            'ClashMeta',
            [sub],
            '',
            { enableSubscriptions: false },
            false
        );
        await Promise.all(waitUntilPromises);

        const [updatedSub] = await storage.get('misub_subscriptions_v1');
        expect(updatedSub.nodeCount).toBe(12);
        expect(updatedSub.lastGoodNodeCount).toBe(12);
    });

    it('旧 enableNodeCache=false 配置不再关闭统一机场缓存', async () => {
        const storage = createMemoryStorage({
            [buildSubscriptionNodeCacheKey({ id: 'sub-a', url: 'https://example.com/sub' })]: {
                nodes: ['trojan://cached@example.com:443#Cached'],
                nodeCount: 1,
                updatedAt: '2026-01-01T00:00:00.000Z',
            },
        });
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response('Forbidden', { status: 403 }))
        );

        const result = await generateCombinedNodeList(
            { storage },
            { enableAccessLog: false, enableFlagEmoji: false },
            'ClashMeta',
            [
                {
                    id: 'sub-a',
                    name: '机场A',
                    url: 'https://example.com/sub',
                    enabled: true,
                    enableNodeCache: false,
                },
            ],
            '',
            { enableSubscriptions: false },
            false
        );

        expect(result.trim()).toBe('trojan://cached@example.com:443#Cached');
    });

    it('异常缩水回退到机场旧缓存', async () => {
        const cacheKey = buildSubscriptionNodeCacheKey({
            id: 'sub-a',
            url: 'https://example.com/sub',
        });
        const cachedNodes = Array.from(
            { length: 156 },
            (_, index) => `trojan://cached${index}@node${index}.example.com:443#Cached-${index}`
        );
        const storage = createMemoryStorage({
            [cacheKey]: {
                nodes: cachedNodes,
                nodeCount: cachedNodes.length,
                updatedAt: '2026-01-01T00:00:00.000Z',
            },
        });
        vi.stubGlobal(
            'fetch',
            vi.fn(
                async () =>
                    new Response(
                        'vless://11111111-1111-1111-1111-111111111111@example.com:443#11111111-1111-1111-1111-111111111111',
                        { status: 200 }
                    )
            )
        );

        const result = await generateCombinedNodeList(
            { storage },
            { enableAccessLog: false, enableFlagEmoji: false },
            'ClashMeta',
            [
                {
                    id: 'sub-a',
                    name: 'Airport',
                    url: 'https://example.com/sub',
                    enabled: true,
                    enableNodeCache: true,
                },
            ],
            '',
            { enableSubscriptions: false },
            false
        );

        const cache = await storage.get(cacheKey);
        expect(result.trim().split('\n')).toHaveLength(cachedNodes.length);
        expect(cache.nodes).toEqual(cachedNodes);
        expect(cache.nodeCount).toBe(cachedNodes.length);
    });

    it('known historical node count rejects a partial refresh even without per-sub cache', async () => {
        const storage = createMemoryStorage();
        vi.stubGlobal(
            'fetch',
            vi.fn(
                async () =>
                    new Response(
                        'vless://11111111-1111-1111-1111-111111111111@example.com:443#11111111-1111-1111-1111-111111111111',
                        { status: 200 }
                    )
            )
        );

        const result = await generateCombinedNodeList(
            { storage },
            { enableAccessLog: false, enableFlagEmoji: false },
            'ClashMeta',
            [
                {
                    id: 'sub-a',
                    name: 'Airport',
                    url: 'https://example.com/sub',
                    enabled: true,
                    nodeCount: 156,
                    enableNodeCache: false,
                },
            ],
            '',
            { enableSubscriptions: false },
            false
        );

        expect(result.trim()).toBe('');
    });

    it('keeps lastGoodNodeCount when a user subscription request only sees one node', async () => {
        const storage = createMemoryStorage({
            misub_subscriptions_v1: [
                {
                    id: 'sub-a',
                    url: 'https://example.com/sub',
                    nodeCount: 1,
                    lastGoodNodeCount: 156,
                    userInfo: null,
                },
            ],
        });
        vi.stubGlobal(
            'fetch',
            vi.fn(
                async () =>
                    new Response(
                        'vless://11111111-1111-1111-1111-111111111111@example.com:443#11111111-1111-1111-1111-111111111111',
                        { status: 200 }
                    )
            )
        );
        const waitUntilPromises = [];
        const result = await generateCombinedNodeList(
            { storage, waitUntil: (promise) => waitUntilPromises.push(promise) },
            { enableAccessLog: false, enableFlagEmoji: false },
            'ClashMeta',
            [
                {
                    id: 'sub-a',
                    name: 'Airport',
                    url: 'https://example.com/sub',
                    enabled: true,
                    nodeCount: 1,
                    lastGoodNodeCount: 156,
                    enableNodeCache: false,
                },
            ],
            '',
            { enableSubscriptions: false },
            false
        );

        expect(result.trim()).toBe('');
        await Promise.all(waitUntilPromises);
        const [updated] = await storage.get('misub_subscriptions_v1');
        expect(updated.nodeCount).toBe(1);
        expect(updated.lastGoodNodeCount).toBe(156);
    });

    it('上游拉取失败时保留上一次成功的订阅运行信息', async () => {
        const sub = {
            id: 'sub-a',
            name: 'Airport A',
            url: 'https://example.com/sub',
            enabled: true,
            enableNodeCache: false,
            nodeCount: 86,
            userInfo: { upload: 1, download: 2, total: 100, expire: 200 },
        };
        const storage = createMemoryStorage({
            misub_subscriptions_v1: [{ ...sub }],
        });
        const waitUntilPromises = [];
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response('Forbidden', { status: 403 }))
        );
        const context = {
            storage,
            waitUntil: (promise) => waitUntilPromises.push(promise),
        };

        const result = await generateCombinedNodeList(
            context,
            { enableAccessLog: false, enableFlagEmoji: false },
            'ClashMeta',
            [sub],
            '',
            { enableSubscriptions: false },
            false
        );

        expect(result.trim()).toBe('');
        expect(context.currentSubscriptionRuntimeInfo?.[sub.id]).toBeUndefined();
        expect(waitUntilPromises).toHaveLength(0);

        const [updatedSub] = await storage.get('misub_subscriptions_v1');
        expect(updatedSub.nodeCount).toBe(86);
        expect(updatedSub.userInfo).toEqual(sub.userInfo);
    });
});
