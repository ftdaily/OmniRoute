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
