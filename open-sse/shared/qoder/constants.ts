/**
 * Qoder API constants ported from 9router (which ported from CLIProxyAPIPlus
 * qoder-provider branch).
 *
 * Endpoint set:
 *   openapi.qoder.sh   - device flow + userinfo + quota usage
 *   api3.qoder.sh      - inference (chat) + model list, requires COSY signing
 *   api2.qoder.sh      - job-token (jt-...) traffic (api3 rejects jt- with 403)
 */

// Job-token (jt-...) exchange for PATs — plain JSON POST, NOT COSY-signed.
export const QODER_JOB_TOKEN_EXCHANGE_URL = "https://openapi.qoder.sh/api/v1/jobToken/exchange";
export const QODER_USERINFO_URL = "https://openapi.qoder.sh/api/v1/userinfo";

// Inference (COSY-signed)
export const QODER_CHAT_BASE = "https://api3.qoder.sh";
// Job-token (jt-...) traffic is rejected by api3 with "Login expired" (403);
// qodercli serves it from api2 instead.
export const QODER_CHAT_BASE_ALT = "https://api2.qoder.sh";

export const QODER_CHAT_SIG_PATH = "/api/v2/service/pro/sse/agent_chat_generation";
export const QODER_CHAT_URL = `${QODER_CHAT_BASE}/algo${QODER_CHAT_SIG_PATH}?FetchKeys=llm_model_result&AgentId=agent_common`;
export const QODER_CHAT_URL_ENCODED = `${QODER_CHAT_URL}&Encode=1`;

export const QODER_MODEL_LIST_URL = `${QODER_CHAT_BASE}/algo/api/v2/model/list`;

export const QODER_IDE_VERSION = "1.0.0";
export const QODER_CLIENT_TYPE = "5";
export const QODER_DATA_POLICY = "disagree";
export const QODER_LOGIN_VERSION = "v2";
export const QODER_MACHINE_OS = "x86_64_windows";
export const QODER_MACHINE_TYPE = "5";

// RSA public key for COSY encryption (extracted from Qoder IDE v0.9).
export const QODER_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;
