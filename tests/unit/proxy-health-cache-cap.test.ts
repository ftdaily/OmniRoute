/**
 * Fork P2 (2.5): proxy health cache is bounded (cap 500). Probing more than
 * the cap worth of distinct proxies evicts the oldest entries, so a fleet
 * with churned proxy URLs cannot grow the map without bound.
 */
import test from "node:test";
import assert from "node:assert/strict";

const health = await import("../../src/lib/proxyHealth.ts");

test("proxyHealthCache: bounded at cap across distinct proxies", async () => {
  delete process.env.PROXY_SKIP_RECENTLY_FAILED;
  health.__setProxyHealthTcpCheckForTesting(async () => false);
  try {
    const N = 600;
    for (let i = 0; i < N; i++) {
      // Distinct URL per probe so each writes its own cache entry.
      await health.isProxyReachable(`http://10.7.0.99:${20000 + i}`);
    }
    const size = health.__proxyHealthCacheSizeForTesting();
    assert.ok(size <= 500, `cache holds ${size}, expected <= 500`);
    assert.ok(size > 0, "cache must retain recent entries");
    // Newest probe result is still served from cache.
    assert.equal(
      await health.isProxyReachable("http://10.7.0.99:20599"),
      false
    );
  } finally {
    health.__setProxyHealthTcpCheckForTesting(null);
  }
});
