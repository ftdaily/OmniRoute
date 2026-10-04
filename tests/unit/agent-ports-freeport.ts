/**
 * Test helper: dynamically allocate a FREE port (bind 0 → read → close).
 * No fixed 2097x ports (Beta runtime owns those). Retry on rare races.
 */
import { createServer, type AddressInfo } from "node:http";
import { once } from "node:events";

export async function getFreePort(retries = 3): Promise<number> {
  for (let i = 0; i < retries; i++) {
    const srv = createServer();
    try {
      srv.listen(0, "127.0.0.1");
      await once(srv, "listening");
      const port = (srv.address() as AddressInfo).port;
      await new Promise<void>((r) => srv.close(() => r()));
      // probe: ensure nothing else grabbed it in the gap
      const probe = createServer();
      try {
        probe.listen(port, "127.0.0.1");
        await once(probe, "listening");
        await new Promise<void>((r) => probe.close(() => r()));
        return port;
      } catch {
        // lost race — retry
      }
    } catch {
      // retry
    }
  }
  throw new Error("getFreePort: exhausted retries");
}
