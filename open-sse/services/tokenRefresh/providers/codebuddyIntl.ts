// @ts-nocheck
// Extracted from open-sse/services/tokenRefresh.ts — see ../shared.ts for
// provenance notes. Mirrors the CN refresh path, swapping the host and
// X-Domain header for codebuddy.ai.
import { runWithProxyContext } from "../../../utils/proxyFetch.ts";
import type { RefreshLogger } from "../shared.ts";

/**
 * CodeBuddy International (codebuddy.ai) token refresh — POST
 * /v2/plugin/auth/token/refresh with the refresh token carried in the
 * X-Refresh-Token header, matching the official CodeBuddy CLI. Response:
 * { code: 0, data: <token> }.
 */
export async function refreshCodebuddyIntlToken(
  refreshToken: string,
  log: RefreshLogger,
  proxyConfig: unknown = null
) {
  if (!refreshToken) return null;
  const { CODEBUDDY_INTL_CONFIG } = await import("@/lib/oauth/constants/oauth");
  const oauth = CODEBUDDY_INTL_CONFIG;
  try {
    const response = await runWithProxyContext(proxyConfig, () =>
      fetch(oauth.refreshUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": oauth.userAgent,
          "X-Requested-With": "XMLHttpRequest",
          "X-Domain": "codebuddy.ai",
          "X-Refresh-Token": refreshToken,
          "X-Auth-Refresh-Source": "plugin",
          "X-Product": "SaaS",
        },
        body: "{}",
      })
    );

    if (!response.ok) {
      const errorText = await response.text();
      log?.error?.("TOKEN_REFRESH", "Failed to refresh CodeBuddy INTL token", {
        status: response.status,
        error: errorText,
      });
      return null;
    }

    const data = await response.json();
    if (data?.code !== 0 || !data?.data?.accessToken) {
      log?.error?.("TOKEN_REFRESH", "CodeBuddy INTL token refresh returned non-success", {
        code: data?.code,
      });
      return null;
    }

    return {
      accessToken: data.data.accessToken,
      refreshToken: data.data.refreshToken ?? refreshToken,
      expiresAt: data.data.expiresAt ?? null,
    };
  } catch (err) {
    log?.error?.("TOKEN_REFRESH", "CodeBuddy INTL token refresh threw", {
      message: err?.message,
    });
    return null;
  }
}
