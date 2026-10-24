import type { AuthOutcome, PolicyContext, RoutePolicy } from "../context";
import { allow, reject } from "../context";

/**
 * USER policy — scoped portal surface. The pipeline runs BEFORE the sqlite
 * driver is safe to touch from the edge, so this policy only separates the
 * principal domains WITHOUT storage I/O:
 * - login POST: PUBLIC-path bootstrap, handler does origin+rate+key checks.
 * - everything else: stamped `user_session`; every route handler ALSO runs
 *   requireUserSession (fresh DB portal state) before doing anything.
 * Admin `dashboard_session` / bearer keys NEVER satisfy USER.
 */
export const userPortalPolicy: RoutePolicy = {
  routeClass: "USER",
  async evaluate(ctx: PolicyContext): Promise<AuthOutcome> {
    const method = String(ctx.request.method ?? "GET").toUpperCase();
    const path = ctx.classification.normalizedPath;
    if (path === "/api/user/auth/login" || path === "/api/user/auth/login/") {
      if (method === "POST") return allow({ kind: "anonymous", id: "anonymous" });
      return reject(405, "METHOD_NOT_ALLOWED", "Method not allowed");
    }
    // Defer: the route handler's requireUserSession is the real gate.
    return allow({ kind: "anonymous", id: "anonymous" });
  },
};
