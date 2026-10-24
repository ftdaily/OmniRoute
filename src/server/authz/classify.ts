import {
  isPublicApiRoute,
  isPublicReadonlyCorsRoute,
} from "../../shared/constants/publicApiRoutes";
import type { ClassificationReason, RouteClassification } from "./types";

const CLIENT_API_ALIAS_PREFIXES: ReadonlyArray<{ alias: string; canonical: string }> = [
  { alias: "/chat/completions", canonical: "/api/v1/chat/completions" },
  { alias: "/responses", canonical: "/api/v1/responses" },
  { alias: "/models", canonical: "/api/v1/models" },
];

function normalizePathname(rawPath: string): { path: string; reason?: ClassificationReason } {
  let path = rawPath || "/";
  if (!path.startsWith("/")) path = "/" + path;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

  // Client-API aliases are matched case-insensitively on the control segment.
  // Next's rewrite layer accepts `/V1/...`, `/CODEX`, etc. and routes them to
  // the client handler, so the classifier must recognize the same casing —
  // otherwise an uppercase alias falls through to the management fallback and
  // the request is treated as a different route class than it is actually
  // dispatched to (GHSA-jvqc-mp9f-q936). Only the leading control segment is
  // lowercased for detection; the original-case tail is preserved.
  const lower = path.toLowerCase();

  if (lower === "/codex" || lower.startsWith("/codex/")) {
    return { path: "/api/v1/responses", reason: "client_api_codex_alias" };
  }

  if (lower === "/v1/v1" || lower.startsWith("/v1/v1/")) {
    const tail = path.slice("/v1/v1".length) || "";
    return { path: "/api/v1" + tail, reason: "client_api_double_prefix" };
  }

  if (lower === "/v1beta" || lower.startsWith("/v1beta/")) {
    const tail = path.slice("/v1beta".length) || "";
    return { path: "/api/v1beta" + tail, reason: "client_api_alias" };
  }

  if (lower === "/v1" || lower.startsWith("/v1/")) {
    const tail = path.slice("/v1".length) || "";
    return { path: "/api/v1" + tail, reason: "client_api_alias" };
  }

  for (const { alias, canonical } of CLIENT_API_ALIAS_PREFIXES) {
    if (lower === alias) {
      return { path: canonical, reason: "client_api_alias" };
    }
    if (lower.startsWith(alias + "/")) {
      return { path: canonical + path.slice(alias.length), reason: "client_api_alias" };
    }
  }

  return { path };
}

export function classifyRoute(rawPath: string, method: string = "GET"): RouteClassification {
  const { path: normalizedPath, reason: aliasReason } = normalizePathname(rawPath);

  if (normalizedPath === "/" || normalizedPath === "") {
    return {
      routeClass: "MANAGEMENT",
      reason: "root_redirect",
      normalizedPath: "/",
    };
  }

  if (normalizedPath === "/dashboard/onboarding") {
    return {
      routeClass: "PUBLIC",
      reason: "setup_wizard",
      normalizedPath,
    };
  }

  // Public, ticket-gated device-flow connect pages (e.g. /connect/codex/{token}).
  // Anyone with the shared link completes the provider login in their own browser.
  if (normalizedPath === "/connect" || normalizedPath.startsWith("/connect/")) {
    return {
      routeClass: "PUBLIC",
      reason: "public_connect_page",
      normalizedPath,
    };
  }

  if (normalizedPath.startsWith("/dashboard")) {
    return {
      routeClass: "MANAGEMENT",
      reason: "dashboard_prefix",
      normalizedPath,
    };
  }

  if (normalizedPath === "/api/v1" || normalizedPath.startsWith("/api/v1/")) {
    return {
      routeClass: "CLIENT_API",
      reason: aliasReason ?? "client_api_v1",
      normalizedPath,
    };
  }

  if (normalizedPath === "/api/v1beta" || normalizedPath.startsWith("/api/v1beta/")) {
    return {
      routeClass: "CLIENT_API",
      reason: aliasReason ?? "client_api_v1",
      normalizedPath,
    };
  }

  if (normalizedPath.startsWith("/api/")) {
    if (isClassifiedAsPublic(normalizedPath, method)) {
      // The user-portal login bootstrap is PUBLIC-path but carries its own
      // USER semantics: the PUBLIC policy only lets this exact login path
      // through; the handler still enforces origin + rate guard + key match.
      if (
        pathMatchesUserLogin(normalizedPath) &&
        String(method).toUpperCase() === "POST"
      ) {
        return {
          routeClass: "USER",
          reason: "user_portal_login",
          normalizedPath,
        };
      }
      return {
        routeClass: "PUBLIC",
        reason: matchesReadonlyPublic(normalizedPath, method)
          ? "public_readonly_prefix"
          : "public_prefix",
        normalizedPath,
      };
    }

    // Scoped user portal: narrow explicit USER class (NOT a subtree wildcard).
    // Unknown /api/user/* paths fall through to MANAGEMENT below — never
    // anonymous. Every USER route enforces requireUserSession in-handler.
    if (isUserPortalPath(normalizedPath)) {
      return {
        routeClass: "USER",
        reason: "user_portal",
        normalizedPath,
      };
    }

    return {
      routeClass: "MANAGEMENT",
      reason: "management_api",
      normalizedPath,
    };
  }

  return {
    routeClass: "MANAGEMENT",
    reason: "fallback_management",
    normalizedPath,
  };
}

function matchesReadonlyPublic(path: string, method: string): boolean {
  // Exact match, not startsWith: a prefix here would hand the CORS origin
  // relaxation to every adjacent path too (GHSA-74g9-q8f6-793h).
  return isPublicReadonlyCorsRoute(path, method);
}

function isClassifiedAsPublic(path: string, method: string): boolean {
  return isPublicApiRoute(path, method);
}

/** Exact user-portal login path (trailing-slash tolerant). Case/encoding exact. */
function pathMatchesUserLogin(path: string): boolean {
  return path === "/api/user/auth/login" || path === "/api/user/auth/login/";
}

/**
 * Narrow explicit USER allowlist — known owned paths only, NOT a subtree
 * wildcard. Unknown /api/user/* paths fall through to MANAGEMENT.
 */
const USER_PORTAL_EXACT_PATHS: ReadonlyArray<{ path: string; methods: ReadonlySet<string> }> = [
  { path: "/api/user/auth/login", methods: new Set(["POST", "OPTIONS"]) },
  { path: "/api/user/auth/logout", methods: new Set(["POST", "OPTIONS"]) },
  { path: "/api/user/auth/session", methods: new Set(["GET", "HEAD", "OPTIONS"]) },
  { path: "/api/user/auth/csrf", methods: new Set(["GET", "HEAD", "OPTIONS"]) },
  { path: "/api/user/me", methods: new Set(["GET", "HEAD", "OPTIONS"]) },
  { path: "/api/user/models", methods: new Set(["GET", "HEAD", "OPTIONS"]) },
  { path: "/api/user/preferences", methods: new Set(["GET", "HEAD", "OPTIONS", "PATCH"]) },
  { path: "/api/user/combos", methods: new Set(["GET", "HEAD", "OPTIONS", "POST"]) },
];

function isUserPortalPath(path: string): boolean {
  for (const { path: known } of USER_PORTAL_EXACT_PATHS) {
    if (path === known || path === `${known}/`) return true;
  }
  // Combo item route: /api/user/combos/<uuid> only — no deeper nesting.
  if (path === "/api/user/combos" || path.startsWith("/api/user/combos/")) {
    const tail = path.slice("/api/user/combos/".length).replace(/\/$/, "");
    if (tail && !tail.includes("/") && tail.length <= 64) return true;
  }
  return false;
}
