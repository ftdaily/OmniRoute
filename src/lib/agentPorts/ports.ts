/**
 * Agent Ports — port/name validation (pure helpers, no I/O).
 * Strict integers 1024..65535; port 0 and reserved ports rejected.
 */
const MIN_PORT = 1024;
const MAX_PORT = 65535;

export function validatePort(port: unknown, reserved?: Iterable<number>): number {
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < MIN_PORT ||
    port > MAX_PORT
  ) {
    throw new Error(
      `Invalid port ${String(port)}: must be an integer in ${MIN_PORT}..${MAX_PORT} (port 0 not allowed)`,
    );
  }
  if (reserved) {
    for (const r of reserved) {
      if (port === r) {
        throw new Error(`Port ${port} is reserved (main/aux listeners) and cannot be used`);
      }
    }
  }
  return port;
}

export function validateName(name: unknown): string {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error("Endpoint name is required");
  }
  const trimmed = name.trim();
  if (trimmed.length > 64) {
    throw new Error("Endpoint name must be at most 64 characters");
  }
  return trimmed;
}

/**
 * Deployment bind host for agent listeners. Default 127.0.0.1 (loopback).
 * ONLY "127.0.0.1" and "0.0.0.0" are allowed — bridge containers need
 * 0.0.0.0 so a host-loopback port publish can reach them; any other value
 * (interfaces, hostnames, garbage) fails closed at startup.
 */
const ALLOWED_BIND_HOSTS = new Set(["127.0.0.1", "0.0.0.0"]);

/**
 * Bind-host semantics (parent-fixed): env UNSET (undefined) or EMPTY STRING
 * → default 127.0.0.1 (an empty env var is treated as unset). A NON-EMPTY
 * value must be EXACTLY "127.0.0.1" or "0.0.0.0" — no trim, no padding,
 * no hostnames, no IPv6; anything else rejects (fail closed).
 */
export function resolveBindHost(env: Record<string, string | undefined> = process.env): string {
  const raw = env.AGENT_PORTS_BIND_HOST;
  if (raw === undefined || raw === "") return "127.0.0.1";
  if (!ALLOWED_BIND_HOSTS.has(raw)) {
    throw new Error(
      `AGENT_PORTS_BIND_HOST=${JSON.stringify(raw)} is not allowed: only "127.0.0.1" or "0.0.0.0" (default 127.0.0.1; unset/empty = default)`,
    );
  }
  return raw;
}
