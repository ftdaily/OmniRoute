import { CODEBUDDY_INTL_CONFIG } from "../constants/oauth";

/**
 * CodeBuddy International (codebuddy.ai) — custom device-auth flow.
 *
 *   1. POST stateUrl?platform=ide → { code: 0, data: { state, authUrl } }
 *   2. Open authUrl in the browser
 *   3. GET tokenUrl?state=<state> until { code: 0, data.accessToken } (11217 = pending)
 *
 * Mirrors the official CodeBuddy CLI: poll is GET with the state as a query
 * param, NOT POST/body. Differs from CN only in host, X-Domain, and platform.
 */
type CodeBuddyIntlConfig = typeof CODEBUDDY_INTL_CONFIG;

interface CodeBuddyDeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface CodeBuddyTokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in?: number;
}

interface CodeBuddyPollResult {
  ok: boolean;
  data: Record<string, unknown> | CodeBuddyTokens;
}

export const codebuddyIntl = {
  config: CODEBUDDY_INTL_CONFIG,
  flowType: "device_code" as const,

  requestDeviceCode: async (config: CodeBuddyIntlConfig): Promise<CodeBuddyDeviceCodeResponse> => {
    const stateUrl = `${config.stateUrl}?platform=${encodeURIComponent(config.platform)}`;
    const response = await fetch(stateUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": config.userAgent,
        "X-Requested-With": "XMLHttpRequest",
        "X-Domain": "codebuddy.ai",
        "X-No-Authorization": "true",
        "X-Product": "SaaS",
      },
      body: "{}",
    });
    const json = (await response.json().catch(() => ({}))) as {
      code?: number;
      data?: { state?: string; authUrl?: string };
    };
    if (!response.ok || json.code !== 0 || !json.data?.state || !json.data?.authUrl) {
      throw new Error(`codebuddy-intl: failed to request device code (status ${response.status})`);
    }
    return {
      device_code: json.data.state,
      user_code: json.data.state,
      verification_uri: json.data.authUrl,
      verification_uri_complete: json.data.authUrl,
      expires_in: 300,
      interval: (config.pollInterval ?? 5000) / 1000,
    };
  },

  pollForToken: async (
    config: CodeBuddyIntlConfig,
    deviceCode: string
  ): Promise<CodeBuddyPollResult> => {
    const url = `${config.tokenUrl}?state=${encodeURIComponent(deviceCode)}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": config.userAgent,
        "X-Requested-With": "XMLHttpRequest",
        "X-Domain": "codebuddy.ai",
        "X-No-Authorization": "true",
        "X-Product": "SaaS",
      },
    });
    if (!response.ok) {
      return { ok: false, data: { error: `http ${response.status}` } };
    }
    const json = (await response.json().catch(() => ({}))) as {
      code?: number;
      data?: CodeBuddyTokens & Record<string, unknown>;
    };
    if (json.code === 0 && json.data?.access_token) {
      return { ok: true, data: json.data as CodeBuddyTokens };
    }
    return { ok: false, data: json.data ?? {} };
  },

  buildAuthorizeUrl: (_config: CodeBuddyIntlConfig, device: CodeBuddyDeviceCodeResponse) =>
    device.verification_uri_complete,
};

export default codebuddyIntl;
