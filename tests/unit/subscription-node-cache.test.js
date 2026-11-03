import { describe, expect, it, vi } from 'vitest';
import {
    buildSubscriptionNodeCacheKey,
    DEFAULT_SUBSCRIPTION_CACHE_TTL_MS,
    getOrFetchSubscriptionNodes,
} from '../../functions/services/subscription-node-cache-service.js';

function createMemoryStorage(initial = {}) {
    const store = new Map(Object.entries(initial));
    return {
        store,
        async get(key) {
            return store.has(key) ? store.get(key) : null;
        },
        async put(key, value) {
            store.set(key, value);
            return true;
        },
    };
}

describe('subscription-node-cache-service', () => {
    it('uses the subscription URL as the shared cache identity', () => {
        const first = { id: 'sub-a', url: 'https://airport.example.com/sub?token=secret' };
        const second = { id: 'sub-b', url: 'https://airport.example.com/sub?token=secret' };

        expect(buildSubscriptionNodeCacheKey(first)).toBe(
            buildSubscriptionNodeCacheKey(second)
        );
    });

    it('reuses a successful airport refresh for the next six hours', async () => {
        const storage = createMemoryStorage();
        const subscription = { id: 'sub-a', url: 'https://airport.example.com/sub' };
        const fetchNodes = vi.fn(async () => ({
            nodes: ['trojan://pass@example.com:443#HK'],
            metadata: { userInfo: { upload: 1, download: 2, total: 100 } },
        }));

        const first = await getOrFetchSubscriptionNodes({
            storage,
            subscription,
            fetchNodes,
        });
        const second = await getOrFetchSubscriptionNodes({
            storage,
            subscription,
            fetchNodes,
        });

        expect(first.fromCache).toBe(false);
        expect(first.cacheStatus).toBe('MISS');
        expect(second.fromCache).toBe(true);
        expect(second.cacheStatus).toBe('HIT');
        expect(second.nodes).toEqual(['trojan://pass@example.com:443#HK']);
        expect(second.metadata.userInfo).toEqual({ upload: 1, download: 2, total: 100 });
        expect(fetchNodes).toHaveBeenCalledTimes(1);
        expect(DEFAULT_SUBSCRIPTION_CACHE_TTL_MS).toBe(6 * 60 * 60 * 1000);
    });

    it('refreshes a stale cache after six hours', async () => {
        const storage = createMemoryStorage();
        const subscription = { url: 'https://airport.example.com/sub' };
        const first = await getOrFetchSubscriptionNodes({
            storage,
            subscription,
            fetchNodes: async () => ({ nodes: ['trojan://old@example.com:443#Old'] }),
        });
        const key = buildSubscriptionNodeCacheKey(subscription);
        const cached = await storage.get(key);
        await storage.put(key, {
            ...cached,
            updatedAt: Date.now() - DEFAULT_SUBSCRIPTION_CACHE_TTL_MS - 1,
        });

        const fetchNodes = vi.fn(async () => ({
            nodes: ['trojan://new@example.com:443#New'],
        }));
        const refreshed = await getOrFetchSubscriptionNodes({
            storage,
            subscription,
            fetchNodes,
        });

        expect(first.nodes).toEqual(['trojan://old@example.com:443#Old']);
        expect(refreshed.fromCache).toBe(false);
        expect(refreshed.cacheStatus).toBe('REFRESHED');
        expect(refreshed.nodes).toEqual(['trojan://new@example.com:443#New']);
        expect(fetchNodes).toHaveBeenCalledTimes(1);
    });

    it('bypasses a fresh cache only when forceRefresh is true', async () => {
        const storage = createMemoryStorage();
        const subscription = { url: 'https://airport.example.com/sub' };
        await getOrFetchSubscriptionNodes({
            storage,
            subscription,
            fetchNodes: async () => ({ nodes: ['trojan://old@example.com:443#Old'] }),
        });

        const fetchNodes = vi.fn(async () => ({
            nodes: ['trojan://forced@example.com:443#Forced'],
        }));
        const refreshed = await getOrFetchSubscriptionNodes({
            storage,
            subscription,
            fetchNodes,
            forceRefresh: true,
        });

        expect(refreshed.fromCache).toBe(false);
        expect(refreshed.nodes).toEqual(['trojan://forced@example.com:443#Forced']);
        expect(fetchNodes).toHaveBeenCalledTimes(1);
    });

    it('keeps the last successful nodes and applies backoff after HTTP 429', async () => {
        const storage = createMemoryStorage();
        const subscription = { url: 'https://airport.example.com/sub' };
        await getOrFetchSubscriptionNodes({
            storage,
            subscription,
            fetchNodes: async () => ({ nodes: ['trojan://cached@example.com:443#Cached'] }),
        });
        const key = buildSubscriptionNodeCacheKey(subscription);
        const cached = await storage.get(key);
        await storage.put(key, {
            ...cached,
            updatedAt: Date.now() - DEFAULT_SUBSCRIPTION_CACHE_TTL_MS - 1,
        });

        const fetchNodes = vi.fn(async () => {
            const error = new Error('HTTP 429: Too Many Requests');
            error.status = 429;
            throw error;
        });

        const failedRefresh = await getOrFetchSubscriptionNodes({
            storage,
            subscription,
            fetchNodes,
        });
        const nextRequest = await getOrFetchSubscriptionNodes({
            storage,
            subscription,
            fetchNodes,
        });

        expect(failedRefresh.nodes).toEqual(['trojan://cached@example.com:443#Cached']);
        expect(failedRefresh.cacheStatus).toBe('STALE');
        expect(nextRequest.nodes).toEqual(['trojan://cached@example.com:443#Cached']);
        expect(nextRequest.cacheStatus).toBe('COOLDOWN');
        expect(fetchNodes).toHaveBeenCalledTimes(1);
    });

    it('coalesces concurrent requests for the same airport in one Worker isolate', async () => {
        const storage = createMemoryStorage();
        const subscription = { url: 'https://airport.example.com/sub' };
        let resolveFetch;
        const fetchNodes = vi.fn(
            () =>
                new Promise((resolve) => {
                    resolveFetch = resolve;
                })
        );

        const firstPromise = getOrFetchSubscriptionNodes({
            storage,
            subscription,
            fetchNodes,
        });
        const secondPromise = getOrFetchSubscriptionNodes({
            storage,
            subscription,
            fetchNodes,
        });

        await Promise.resolve();
        resolveFetch({ nodes: ['trojan://shared@example.com:443#Shared'] });
        const [first, second] = await Promise.all([firstPromise, secondPromise]);

        expect(fetchNodes).toHaveBeenCalledTimes(1);
        expect(first.nodes).toEqual(second.nodes);
    });
});
