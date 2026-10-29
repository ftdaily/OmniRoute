"use client";

/**
 * Agent Ports dashboard page — CRUD + status for per-agent localhost listeners.
 * Keys referenced by ID only (masked secret); key NAME shown from assigned id mapping.
 * Accessible labels, role=alert errors, responsive table, theme tokens, i18n-ready.
 */
import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { DataTableShell } from "@omniroute/ui-kit/data-table-shell";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@omniroute/ui-kit/table";
import Badge from "@/shared/components/Badge";
import Button from "@/shared/components/Button";
import Input from "@/shared/components/Input";
import { Select } from "@/shared/components";

type EndpointPublic = {
  id: string;
  name: string;
  port: number;
  apiKeyId: string;
  enabled: boolean;
  status: string;
  statusDetail: string | null;
  baseUrl: string;
  createdAt: string;
  updatedAt: string;
};

type ApiKeyOption = { id: string; name: string };

type CheckState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "free" }
  | { kind: "taken"; detail: string }
  | { kind: "invalid"; detail: string };

export default function AgentPortsPage() {
  const t = useTranslations("agentPorts");
  const [endpoints, setEndpoints] = useState<EndpointPublic[]>([]);
  const [keys, setKeys] = useState<ApiKeyOption[]>([]);
  const [name, setName] = useState("");
  const [port, setPort] = useState("");
  const [apiKeyId, setApiKeyId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [check, setCheck] = useState<CheckState>({ kind: "idle" });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editPort, setEditPort] = useState("");
  const [editApiKeyId, setEditApiKeyId] = useState("");

  const keyName = useCallback((id: string) => keys.find((k) => k.id === id)?.name ?? id, [keys]);

  const refresh = useCallback(async () => {
    try {
      const [epRes, keyRes] = await Promise.all([
        fetch("/api/agent-ports"),
        fetch("/api/keys?limit=1000"),
      ]);
      if (epRes.ok) {
        const data = (await epRes.json()) as { endpoints?: EndpointPublic[] };
        setEndpoints(data.endpoints ?? []);
      } else {
        setError(`Failed to load agent ports (${epRes.status})`);
      }
      if (keyRes.ok) {
        const data = (await keyRes.json()) as { keys?: ApiKeyOption[] };
        setKeys(data.keys ?? []);
      } else {
        setError(`Failed to load API keys (${keyRes.status})`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error while loading");
    }
  }, []);

  // Mount-time load via lazy initializer state (no setState-in-effect):
  // refresh stays the shared handler for all mutations below.
  const [didInitialLoad] = useState(() => {
    void refresh();
    return true;
  });
  void didInitialLoad;

  const _checkAvailability = useCallback(async () => {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1024 || p > 65535) {
      setCheck({ kind: "invalid", detail: "Port must be an integer 1024–65535" });
      return;
    }
    setCheck({ kind: "checking" });
    try {
      const res = await fetch(`/api/agent-ports/status`);
      if (!res.ok) {
        setCheck({ kind: "invalid", detail: `Check failed (${res.status})` });
        return;
      }
      const data = (await res.json()) as { endpoints: Array<{ port: number }> };
      const assigned = data.endpoints?.some((e) => e.port === p);
      // informational only — the ACTUAL bind at start remains authoritative
      setCheck(
        assigned
          ? { kind: "taken", detail: "Port is already assigned to an agent endpoint" }
          : { kind: "free" }
      );
    } catch (err) {
      setCheck({ kind: "invalid", detail: err instanceof Error ? err.message : "Check failed" });
    }
  }, [port]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/agent-ports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, port: Number(port), apiKeyId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? `Failed to create (${res.status})`);
      } else {
        setName("");
        setPort("");
        setApiKeyId("");
        setCheck({ kind: "idle" });
        await refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error during create");
    } finally {
      setBusy(false);
    }
  };

  const act = async (id: string, action: "start" | "stop") => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/agent-ports/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? `Failed to ${action} (${res.status})`);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {};
      if (editPort) payload.port = Number(editPort);
      if (editApiKeyId) payload.apiKeyId = editApiKeyId;
      const res = await fetch(`/api/agent-ports/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? `Failed to update (${res.status})`);
      } else {
        setEditingId(null);
        setEditPort("");
        setEditApiKeyId("");
        await refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/agent-ports/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? `Failed to delete (${res.status})`);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  };

  const copyBase = async (ep: EndpointPublic) => {
    try {
      await navigator.clipboard.writeText(ep.baseUrl);
      setCopied(ep.id);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setError("Clipboard unavailable — copy manually: " + ep.baseUrl);
    }
  };

  const statusTone = (s: string): "success" | "error" | "default" =>
    s === "running" ? "success" : s === "error" ? "error" : "default";

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold text-text-main">{t("agentPorts")}</h1>
        <p className="text-sm text-text-muted">{t("agentPortsSubtitle")}</p>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-error/30 bg-error-bg p-3 text-sm text-error"
        >
          {error}
        </div>
      )}

      <div className="rounded-xl border border-border bg-bg-subtle p-4">
        <h2 className="mb-3 font-medium text-text-main">{t("newPort")}</h2>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="agent-port-name" className="text-xs text-text-muted">
              {t("name")}
            </label>
            <Input
              id="agent-port-name"
              placeholder="claude-code"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={64}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="agent-port-port" className="text-xs text-text-muted">
              {t("port")}
            </label>
            <Input
              id="agent-port-port"
              className="w-36"
              placeholder="1024–65535"
              value={port}
              inputMode="numeric"
              onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ""))}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="agent-port-key" className="text-xs text-text-muted">
              {t("apiKey")}
            </label>
            <Select
              id="agent-port-key"
              value={apiKeyId}
              onChange={(e) => setApiKeyId(e.target.value)}
            >
              <option value="">{t("selectKey")}</option>
              {keys.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                </option>
              ))}
            </Select>
          </div>
          <Button type="button" variant="secondary" disabled={busy} onClick={() => void create()}>
            {t("create")}
          </Button>
        </div>
        {check.kind === "free" && (
          <p className="mt-2 text-xs text-success">{t("portAppearsFree")}</p>
        )}
        {check.kind === "taken" && (
          <p role="alert" className="mt-2 text-xs text-warning">
            {check.detail} — {t("bindAuthoritative")}
          </p>
        )}
        {check.kind === "invalid" && (
          <p role="alert" className="mt-2 text-xs text-error">
            {check.detail}
          </p>
        )}
      </div>

      <DataTableShell loading={false} loadingLabel={t("name")}>
        <Table className="text-sm">
          <TableHeader>
            <TableRow>
              <TableHead>{t("name")}</TableHead>
              <TableHead>{t("port")}</TableHead>
              <TableHead>{t("apiKey")}</TableHead>
              <TableHead>{t("baseUrl")}</TableHead>
              <TableHead>{t("status")}</TableHead>
              <TableHead>{t("actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {endpoints.length === 0 && (
              <TableRow>
                <TableCell colSpan={6}>{t("empty")}</TableCell>
              </TableRow>
            )}
            {endpoints.map((ep) => (
              <TableRow key={ep.id}>
                <TableCell className="font-medium">{ep.name}</TableCell>
                <TableCell>{ep.port}</TableCell>
                <TableCell>
                  <span title={ep.apiKeyId}>{keyName(ep.apiKeyId)}</span>
                  <span className="ml-1 text-xs text-text-muted">({ep.apiKeyId.slice(0, 8)}…)</span>
                </TableCell>
                <TableCell>
                  <code className="text-xs text-text-main">{ep.baseUrl}</code>
                  {/* kit-exception: inline copy-link beside the URL value; the kit Button is a
                      pill control and CopyButton carries its own copied state */}
                  <button
                    type="button"
                    className="ml-2 text-xs text-primary hover:underline"
                    onClick={() => copyBase(ep)}
                  >
                    {copied === ep.id ? t("copied") : t("copy")}
                  </button>
                </TableCell>
                <TableCell title={ep.statusDetail ?? undefined}>
                  <Badge size="sm" variant={statusTone(ep.status)}>
                    {ep.status}
                  </Badge>
                </TableCell>
                <TableCell className="space-x-2 whitespace-nowrap">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => act(ep.id, ep.status === "running" ? "stop" : "start")}
                  >
                    {ep.status === "running" ? t("stop") : t("start")}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setEditingId(editingId === ep.id ? null : ep.id);
                      setEditPort("");
                      setEditApiKeyId("");
                    }}
                  >
                    {t("edit")}
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    disabled={busy}
                    onClick={() => remove(ep.id)}
                  >
                    {t("delete")}
                  </Button>
                  {editingId === ep.id && (
                    <span className="ml-2 inline-flex items-center gap-2 align-middle">
                      <Input
                        aria-label={t("newPortValue")}
                        className="w-28"
                        placeholder={t("newPortValue")}
                        value={editPort}
                        inputMode="numeric"
                        onChange={(e) => setEditPort(e.target.value.replace(/[^0-9]/g, ""))}
                      />
                      <Select
                        aria-label={t("reassignKey")}
                        value={editApiKeyId}
                        onChange={(e) => setEditApiKeyId(e.target.value)}
                      >
                        <option value="">{t("reassignKey")}</option>
                        {keys.map((k) => (
                          <option key={k.id} value={k.id}>
                            {k.name}
                          </option>
                        ))}
                      </Select>
                      <Button
                        type="button"
                        size="sm"
                        disabled={busy || (!editPort && !editApiKeyId)}
                        onClick={() => saveEdit(ep.id)}
                      >
                        {t("save")}
                      </Button>
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DataTableShell>
    </div>
  );
}
