/**
 * 单机场订阅缓存。
 *
 * 节点缓存按订阅 URL 共享，避免同一机场被多个订阅组、Token 或预览入口重复拉取。
 * 缓存数据保存未应用订阅组转换的节点 URL，转换规则始终在读取后执行。
 */

import { isSuspiciousNodeCountDrop } from './node-cache-service.js';

export const DEFAULT_SUBSCRIPTION_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const CACHE_KEY_PREFIX = 'node_cache_subscription_url_';
const CACHE_VERSION = 2;
const REFRESH_LEASE_MS = 2 * 60 * 1000;
const FAILURE_BACKOFF_BASE_MS = 5 * 60 * 1000;
const FAILURE_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;
const inFlightRefreshes = new Map();

function hashSubscriptionUrl(url) {
    const value = String(url || '').trim();
    let hashA = 0x811c9dc5;
    let hashB = 0x9e3779b9;

    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        hashA = Math.imul(hashA ^ code, 0x01000193) >>> 0;
        hashB = Math.imul(hashB ^ (code + index), 0x85ebca6b) >>> 0;
    }

    return `${hashA.toString(36)}${hashB.toString(36)}`;
}

export function buildSubscriptionNodeCacheKey(subscription = {}) {
    const url = typeof subscription.url === 'string' ? subscription.url.trim() : '';
    return url ? `${CACHE_KEY_PREFIX}${hashSubscriptionUrl(url)}` : '';
}

function normalizeNodes(nodes) {
    if (!Array.isArray(nodes)) return [];
    return nodes
        .filter((node) => typeof node === 'string')
        .map((node) => node.trim())
        .filter(Boolean);
}

function normalizeMetadata(metadata = {}) {
    const normalized = {};
    if (metadata?.userInfo && typeof metadata.userInfo === 'object') {
        normalized.userInfo = metadata.userInfo;
    }
    if (typeof metadata?.detectedName === 'string' && metadata.detectedName.trim()) {
        normalized.detectedName = metadata.detectedName.trim();
    }
    return normalized;
}

function normalizeCacheEntry(entry, subscription) {
    const urlHash = hashSubscriptionUrl(subscription?.url);
    if (
        !entry ||
        entry.version !== CACHE_VERSION ||
        entry.urlHash !== urlHash ||
        !Array.isArray(entry.nodes)
    ) {
        return null;
    }

    return {
        ...entry,
        nodes: normalizeNodes(entry.nodes),
        nodeCount: Number(entry.nodeCount) || normalizeNodes(entry.nodes).length,
        updatedAt: Number(entry.updatedAt) || 0,
        retryAfter: Number(entry.retryAfter) || 0,
        failureCount: Number(entry.failureCount) || 0,
        metadata: normalizeMetadata(entry.metadata),
    };
}

export async function readSubscriptionNodeCache(storage, subscription) {
    const key = buildSubscriptionNodeCacheKey(subscription);
    if (!key || typeof storage?.get !== 'function') return null;

    try {
        return normalizeCacheEntry(await storage.get(key), subscription);
    } catch (error) {
        console.warn('[SubscriptionCache] Failed to read cache:', error?.message || error);
        return null;
    }
}

export async function saveSubscriptionNodeCache(storage, subscription, nodes, metadata = {}) {
    const key = buildSubscriptionNodeCacheKey(subscription);
    const urlHash = hashSubscriptionUrl(subscription?.url);
    const validNodes = normalizeNodes(nodes);
    if (!key || !validNodes.length || typeof storage?.put !== 'function') return false;

    try {
        const existing = await readSubscriptionNodeCache(storage, subscription);
        if (isSuspiciousNodeCountDrop(existing?.nodeCount, validNodes.length)) {
            console.warn(
                `[SubscriptionCache] Refusing suspicious node-count drop for ${key} (${existing.nodeCount} -> ${validNodes.length})`
            );
            return false;
        }

        const now = Date.now();
        await storage.put(key, {
            version: CACHE_VERSION,
            urlHash,
            nodes: validNodes,
            nodeCount: validNodes.length,
            updatedAt: now,
            lastAttemptAt: now,
            failureCount: 0,
            retryAfter: 0,
            metadata: normalizeMetadata(metadata),
        });
        return true;
    } catch (error) {
        console.warn('[SubscriptionCache] Failed to write cache:', error?.message || error);
        return false;
    }
}

function getRetryAfterTimestamp(error, now) {
    const raw = error?.retryAfter;
    if (raw !== undefined && raw !== null && raw !== '') {
        const seconds = Number(raw);
        if (Number.isFinite(seconds) && seconds >= 0) {
            return now + seconds * 1000;
        }
        const date = Date.parse(String(raw));
        if (Number.isFinite(date)) return Math.max(now, date);
    }

    const failureCount = Math.max(1, Number(error?.failureCount) || 1);
    const backoff = Math.min(
        FAILURE_BACKOFF_MAX_MS,
        FAILURE_BACKOFF_BASE_MS * 2 ** Math.min(failureCount - 1, 10)
    );

    // 429/403 通常代表机场侧限流或访问策略拒绝，不应在短时间内反复尝试。
    if (Number(error?.status) === 429 || Number(error?.status) === 403) {
        return now + Math.max(backoff, 60 * 60 * 1000);
    }

    if (error?.code === 'SUSPICIOUS_NODE_COUNT_DROP') {
        return now + Math.max(backoff, 60 * 60 * 1000);
    }

    return now + backoff;
}

async function recordRefreshFailure(storage, subscription, cached, error) {
    const key = buildSubscriptionNodeCacheKey(subscription);
    if (!key || typeof storage?.put !== 'function') return 0;

    const now = Date.now();
    const failureCount = (Number(cached?.failureCount) || 0) + 1;
    const retryAfter = getRetryAfterTimestamp({ ...error, failureCount }, now);

    try {
        await storage.put(key, {
            version: CACHE_VERSION,
            urlHash: hashSubscriptionUrl(subscription?.url),
            nodes: cached?.nodes || [],
            nodeCount: Number(cached?.nodeCount) || 0,
            updatedAt: Number(cached?.updatedAt) || 0,
            lastAttemptAt: now,
            failureCount,
            retryAfter,
            metadata: normalizeMetadata(cached?.metadata),
            lastError: {
                status: Number(error?.status) || null,
                message: String(error?.message || 'Subscription refresh failed').slice(0, 240),
            },
        });
    } catch (storageError) {
        console.warn(
            '[SubscriptionCache] Failed to persist refresh backoff:',
            storageError?.message || storageError
        );
    }

    return retryAfter;
}

function createResult(entry, cacheStatus, extra = {}) {
    return {
        nodes: entry?.nodes || [],
        metadata: entry?.metadata || {},
        nodeCount: Number(entry?.nodeCount) || 0,
        fromCache: true,
        cacheStatus,
        ...extra,
    };
}

function createRefreshToken() {
    try {
        return crypto.randomUUID();
    } catch {
        return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
}

async function waitForCache(storage, subscription, previousUpdatedAt, timeoutMs = 18000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const current = await readSubscriptionNodeCache(storage, subscription);
        if (
            current?.nodes?.length &&
            Number(current.updatedAt) > Number(previousUpdatedAt || 0)
        ) {
            return current;
        }
    }
    return null;
}

/**
 * 获取单机场节点缓存；缓存不存在或达到 6 小时刷新间隔时才调用 fetchNodes。
 *
 * D1 可提供跨 Worker 实例的原子租约。KV-only 部署使用 Isolate 内 in-flight 合并，
 * 但 KV 的最终一致性决定了它不能提供严格的跨地域互斥保证。
 */
export async function getOrFetchSubscriptionNodes({
    storage,
    lockStorage = storage,
    subscription,
    fetchNodes,
    forceRefresh = false,
    knownNodeCount = 0,
    validateFetched,
}) {
    if (typeof fetchNodes !== 'function') {
        throw new TypeError('fetchNodes must be a function');
    }

    if (typeof storage?.get !== 'function' || typeof storage?.put !== 'function') {
        const fetched = await fetchNodes();
        const nodes = normalizeNodes(Array.isArray(fetched) ? fetched : fetched?.nodes);
        return {
            nodes,
            metadata: normalizeMetadata(fetched?.metadata),
            nodeCount: nodes.length,
            fromCache: false,
            cacheStatus: 'BYPASS',
        };
    }

    const key = buildSubscriptionNodeCacheKey(subscription);
    if (!key) {
        const fetched = await fetchNodes();
        const nodes = normalizeNodes(Array.isArray(fetched) ? fetched : fetched?.nodes);
        return {
            nodes,
            metadata: normalizeMetadata(fetched?.metadata),
            nodeCount: nodes.length,
            fromCache: false,
            cacheStatus: 'BYPASS',
        };
    }

    const cached = await readSubscriptionNodeCache(storage, subscription);
    const now = Date.now();
    const hasCachedNodes = Boolean(cached?.nodes?.length);
    const cacheAge = cached?.updatedAt ? now - cached.updatedAt : Number.POSITIVE_INFINITY;

    if (!forceRefresh && hasCachedNodes && cacheAge < DEFAULT_SUBSCRIPTION_CACHE_TTL_MS) {
        return createResult(cached, 'HIT');
    }

    if (!forceRefresh && cached?.retryAfter > now) {
        return createResult(cached, 'COOLDOWN', {
            error: cached?.lastError?.message || null,
            retryAfter: cached.retryAfter,
        });
    }

    const existingPromise = inFlightRefreshes.get(key);
    if (existingPromise) return existingPromise;

    const refreshPromise = (async () => {
        let leaseToken = null;
        let leaseAcquired = false;
        const leaseNow = Date.now();

        if (typeof lockStorage?.acquireSubscriptionCacheLease === 'function') {
            leaseToken = createRefreshToken();
            try {
                const lease = await lockStorage.acquireSubscriptionCacheLease(
                    key,
                    leaseToken,
                    leaseNow + REFRESH_LEASE_MS,
                    leaseNow,
                    forceRefresh
                );
                leaseAcquired = Boolean(lease?.acquired);

                if (!leaseAcquired) {
                    const latestCache = await readSubscriptionNodeCache(storage, subscription);
                    if (latestCache?.nodes?.length) {
                        return createResult(latestCache, 'REFRESHING', {
                            retryAfter: Number(lease?.nextRefreshAt) || 0,
                        });
                    }

                    if (Number(lease?.leaseUntil) > Date.now()) {
                        const refreshed = await waitForCache(
                            storage,
                            subscription,
                            cached?.updatedAt || 0
                        );
                        if (refreshed) return createResult(refreshed, 'REFRESHED');
                        throw new Error('该机场正在由其他请求刷新，请稍后重试');
                    }

                    if (!forceRefresh && Number(lease?.nextRefreshAt) > Date.now()) {
                        return createResult(latestCache, 'COOLDOWN', {
                            retryAfter: Number(lease.nextRefreshAt),
                        });
                    }
                }
            } catch (error) {
                if (error?.message?.includes('正在由其他请求刷新')) throw error;
                console.warn(
                    '[SubscriptionCache] Distributed refresh lease unavailable:',
                    error?.message || error
                );
            }
        }

        try {
            const fetched = await fetchNodes();
            const fetchedNodes = normalizeNodes(
                Array.isArray(fetched) ? fetched : fetched?.nodes
            );
            if (!fetchedNodes.length) {
                const error = new Error('上游没有返回有效节点，保留机场上次成功缓存');
                error.code = 'EMPTY_SUBSCRIPTION_RESULT';
                throw error;
            }

            const previousCount = Math.max(
                Number(knownNodeCount) || 0,
                Number(cached?.nodeCount) || 0
            );
            if (isSuspiciousNodeCountDrop(previousCount, fetchedNodes.length)) {
                const error = new Error(
                    `机场节点数量异常缩水（${previousCount} -> ${fetchedNodes.length}），保留旧缓存`
                );
                error.code = 'SUSPICIOUS_NODE_COUNT_DROP';
                throw error;
            }

            if (
                typeof validateFetched === 'function' &&
                !(await validateFetched(fetchedNodes, cached))
            ) {
                const error = new Error('新节点结果未通过完整性校验，保留旧缓存');
                error.code = 'SUSPICIOUS_NODE_COUNT_DROP';
                throw error;
            }

            const saved = await saveSubscriptionNodeCache(
                storage,
                subscription,
                fetchedNodes,
                fetched?.metadata
            );
            if (!saved) {
                const error = new Error('新节点结果未能安全写入缓存，保留旧缓存');
                error.code = 'SUSPICIOUS_NODE_COUNT_DROP';
                throw error;
            }

            const updated = await readSubscriptionNodeCache(storage, subscription);
            if (leaseAcquired) {
                await lockStorage.completeSubscriptionCacheLease(
                    key,
                    leaseToken,
                    Date.now() + DEFAULT_SUBSCRIPTION_CACHE_TTL_MS
                );
            }

            return {
                nodes: updated?.nodes || fetchedNodes,
                metadata: updated?.metadata || normalizeMetadata(fetched?.metadata),
                nodeCount: updated?.nodeCount || fetchedNodes.length,
                fromCache: false,
                cacheStatus: cached?.nodes?.length ? 'REFRESHED' : 'MISS',
            };
        } catch (error) {
            const retryAfter = await recordRefreshFailure(storage, subscription, cached, error);
            if (leaseAcquired) {
                try {
                    await lockStorage.completeSubscriptionCacheLease(key, leaseToken, retryAfter);
                } catch (leaseError) {
                    console.warn(
                        '[SubscriptionCache] Failed to release refresh lease:',
                        leaseError?.message || leaseError
                    );
                }
            }

            if (hasCachedNodes) {
                return createResult(cached, 'STALE', {
                    error: error?.message || 'Subscription refresh failed',
                    retryAfter,
                });
            }
            throw error;
        } finally {
            if (leaseAcquired && typeof lockStorage?.releaseSubscriptionCacheLease === 'function') {
                try {
                    await lockStorage.releaseSubscriptionCacheLease(key, leaseToken);
                } catch (error) {
                    console.warn(
                        '[SubscriptionCache] Failed to release refresh lease:',
                        error?.message || error
                    );
                }
            }
        }
    })();

    inFlightRefreshes.set(key, refreshPromise);
    try {
        return await refreshPromise;
    } finally {
        if (inFlightRefreshes.get(key) === refreshPromise) {
            inFlightRefreshes.delete(key);
        }
    }
}
