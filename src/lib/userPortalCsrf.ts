"use client";

/**
 * Own CSRF helper for the scoped user portal (p9-owned).
 * Fetches the user-scoped token and returns headers for mutating requests.
 * Cookie is HttpOnly — this helper only carries the CSRF header value,
 * never the raw router API key.
 */

const CSRF_HEADER = "x-omniroute-user-csrf";

let cachedToken: string | null = null;

function baseUrl(): string {
  return typeof window !== "undefined" ? window.location.origin : "";
}

export async function getUserCsrfToken(forceRefresh = false): Promise<string> {
  if (cachedToken && !forceRefresh) return cachedToken;
  const res = await fetch(`${baseUrl()}/api/user/auth/csrf`, {
    credentials: "same-origin",
  });
  if (!res.ok) throw new Error(`CSRF fetch failed: ${res.status}`);
  const data = (await res.json()) as { token?: string };
  if (!data.token) throw new Error("CSRF token missing");
  cachedToken = data.token;
  return cachedToken;
}

export function clearUserCsrfToken(): void {
  cachedToken = null;
}

/** Headers for mutating /api/user/* requests (same-origin cookie + own CSRF). */
export async function userMutatingHeaders(
  extra: Record<string, string> = {}
): Promise<Record<string, string>> {
  const token = await getUserCsrfToken();
  return { "Content-Type": "application/json", [CSRF_HEADER]: token, ...extra };
}

export const USER_CSRF_HEADER = CSRF_HEADER;
