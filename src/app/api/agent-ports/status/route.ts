/**
 * GET /api/agent-ports/status — runtime status for ALL endpoints with an
 * ACTUAL bind re-check (listener map is the truth; DB is desired state).
 */
import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { listEndpoints } from "@/lib/agentPorts/store";
import { listRunningListeners } from "@/lib/agentPorts/supervisor";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const endpoints = await listEndpoints();
  const running = listRunningListeners();
  return NextResponse.json({
    endpoints: endpoints.map((ep) => {
      const r = running.find((l) => l.id === ep.id);
      return {
        id: ep.id,
        port: ep.port,
        desired: ep.enabled ? "started" : "stopped",
        actual: r ? r.status : "stopped",
        statusDetail: ep.statusDetail,
      };
    }),
  });
}
