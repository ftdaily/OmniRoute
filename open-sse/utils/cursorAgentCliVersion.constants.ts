/**
 * Pure, client-safe exports from cursorAgentCliVersion.
 *
 * The full module (`./cursorAgentCliVersion.ts`) imports node:fs/os/path and
 * is server-only — it can't enter a "use client" import graph. The constant
 * and the pure validator/formatter below are safe to import from anywhere.
 *
 * Keep this file's import surface empty of Node built-ins; it must remain
 * tree-shake-friendly so webpack can include just `CURSOR_AGENT_CLI_VERSION`
 * in client bundles without dragging fs/os/path along.
 */

/**
 * Pinned Agent CLI build id used when no local install is found (typical
 * headless OmniRoute). Bump when refreshing Cursor CLI impersonation.
 */
export const CURSOR_AGENT_CLI_VERSION = "2026.07.08-0c04a8a";

/** Matches dated Cursor Agent CLI builds like "2026.07.08-0c04a8a". */
export const VERSION_ID_RE = /^\d{4}\.\d{2}\.\d{2}-[0-9a-f]+$/;

export function isCursorAgentCliVersionId(value: string): boolean {
  return VERSION_ID_RE.test(value);
}

export function formatCursorAgentClientVersion(id: string): string {
  return `cli-${id}`;
}
