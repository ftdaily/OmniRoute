/**
 * Agent Ports — per-endpoint management: update / start / stop / delete.
 * Guard: existing management auth (upstream authz pipeline). Runtime conflict
 * (EADDRINUSE/EACCES) surfaces from the ACTUAL bind inside startAgentListener.
 *
 * Change control (C1-C4, C7): ALL mutations go through applyEndpointMutation —
 * serialized per endpoint id, validated strictly BEFORE any apply, and the
 * desired enabled flag follows the action (start⇒enabled=1, stop⇒enabled=0).
 */
import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getEndpoint, deleteEndpoint } from "@/lib/agentPorts/store";
import {
  stopAgentListener,
  applyEndpointMutation,
  toPublicEndpoint,
  StartBlockedError,
  listRunningListeners,
} from "@/lib/agentPorts/supervisor";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

function toPublicWithRuntime(ep: NonNullable<Awaited<ReturnType<typeof getEndpoint>>>) {
  return toPublicEndpoint(ep, listRunningListeners().some((l) => l.id === ep.id && l.status === "running"));
}

function errorStatus(err: unknown): number {
  const msg = err instanceof Error ? err.message : String(err);
  if (/not found/i.test(msg)) return 404;
  if (err instanceof StartBlockedError) return 422; // key gate: create/fix assignment first
  if (/EADDRINUSE|EACCES/i.test(msg)) return 409; // actual bind conflict
  if (/Invalid port|reserved|must be a boolean|must be a string|must be a non-empty|already assigned|already has a running/i.test(msg)) return 400;
  return 400;
}

function errorBody(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return { error: msg };
}

export async function PATCH(request: Request, ctx: Ctx) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const { id } = await ctx.params;
  try {
    const body = (await request.json()) as Record<string, unknown>;

    // Strict action enum (C4): unknown actions rejected, never silently ignored
    if (body.action !== undefined && body.action !== "start" && body.action !== "stop") {
      return NextResponse.json({ error: `Unknown action ${JSON.stringify(body.action)}; expected "start" | "stop"` }, { status: 400 });
    }

    // C1: desired state follows the action; C2/C3: fields validated inside the
    // serialized mutation — action + fields compose into ONE payload.
    const mutation: Record<string, unknown> = { ...body };
    delete mutation.action;
    if (body.action === "start") mutation.enabled = true;
    if (body.action === "stop") mutation.enabled = false;

    const hasFields = Object.keys(mutation).length > 0;
    if (hasFields) {
      const ep = await applyEndpointMutation(id, mutation);
      return NextResponse.json({ endpoint: toPublicWithRuntime(ep) });
    }

    const ep = await getEndpoint(id);
    if (!ep) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ endpoint: toPublicWithRuntime(ep) });
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}

export async function DELETE(request: Request, ctx: Ctx) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const { id } = await ctx.params;
  await stopAgentListener(id);
  await deleteEndpoint(id);
  return NextResponse.json({ ok: true });
}

export async function GET(request: Request, ctx: Ctx) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const { id } = await ctx.params;
  const ep = await getEndpoint(id);
  if (!ep) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ endpoint: toPublicWithRuntime(ep) });
}
