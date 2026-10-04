/**
 * Agent Ports — management API (dashboard-admin guarded, reuses existing guard).
 * GET  /api/agent-ports         → list endpoints (masked key fields ONLY)
 * POST /api/agent-ports         → create + start by default (ACTUAL bind authoritative; occupied → 409); enabled:false saves stopped
 * POST /api/agent-ports/[id]    → update fields / start / stop via {action}
 * DELETE /api/agent-ports/[id]  → delete (stops listener first)
 * GET  /api/agent-ports/status  → runtime status incl. ACTUAL bind re-check
 *
 * NOTE: route guards ride the EXISTING authz pipeline (management policy),
 * so admin auth is enforced upstream by next middleware — not by the listener.
 */
import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  listEndpoints,
  createEndpoint,
  getEndpoint,
  setEndpointStatus,
} from "@/lib/agentPorts/store";
import {
  reservedAgentPortSet,
  listRunningListeners,
  toPublicEndpoint,
  startAgentListener,
} from "@/lib/agentPorts/supervisor";
import { validatePort } from "@/lib/agentPorts/ports";

export const dynamic = "force-dynamic";

function toPublic(ep: Awaited<ReturnType<typeof listEndpoints>>[number]) {
  // C5: single mapping source — error status preserved, keys referenced by ID only
  return toPublicEndpoint(ep, listRunningListeners().some((l) => l.id === ep.id && l.status === "running"));
}

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const endpoints = await listEndpoints();
  return NextResponse.json({ endpoints: endpoints.map(toPublic) });
}

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  try {
    const body = (await request.json()) as {
      name?: unknown;
      port?: unknown;
      apiKeyId?: unknown;
      enabled?: unknown;
    };
    if (typeof body.apiKeyId !== "string" || !body.apiKeyId.trim()) {
      return NextResponse.json({ error: "apiKeyId is required" }, { status: 400 });
    }
    // C4: strict boolean for enabled (no truthy strings/numbers)
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
    }
    // C6: the assigned key row must EXIST before insert (fail fast, clear error)
    const { getApiKeyById } = await import("@/lib/db/apiKeys");
    const keyRow = await getApiKeyById(body.apiKeyId.trim());
    if (!keyRow) {
      return NextResponse.json({ error: `API key ${body.apiKeyId.trim()} does not exist` }, { status: 400 });
    }
    // validate against reserved ports BEFORE insert (actual-bind conflict still authoritative below)
    validatePort(body.port as number, reservedAgentPortSet());
    const desiredEnabled = body.enabled ?? true; // default: create AND start
    const id = await createEndpoint({
      name: String(body.name ?? ""),
      port: body.port as number,
      apiKeyId: body.apiKeyId.trim(),
      enabled: desiredEnabled,
    });

    if (desiredEnabled) {
      // ACTUAL BIND at create time: occupied port surfaces here as 409 (never a false 201).
      // The row persists with status=error (documented, visible) so the operator can fix it.
      try {
        await startAgentListener(id);
      } catch (startErr) {
        const sMsg = startErr instanceof Error ? startErr.message : String(startErr);
        await setEndpointStatus(
          id,
          "error",
          /EADDRINUSE/.test(sMsg) ? `${sMsg} (port occupied at create)` : sMsg,
        );
        const status = /EADDRINUSE/i.test(sMsg) ? 409 : 422;
        return NextResponse.json(
          { error: sMsg, endpoint: toPublic((await getEndpoint(id))!) },
          { status },
        );
      }
    }
    const ep = await getEndpoint(id);
    return NextResponse.json({ endpoint: ep ? toPublic(ep) : null }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = /Invalid port|reserved|name|required|does not exist|must be a boolean/i.test(msg)
      ? 400
      : /already assigned|EADDRINUSE/i.test(msg)
        ? 409
        : 400;
    return NextResponse.json({ error: msg }, { status });
  }
}
