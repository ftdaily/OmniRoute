"use client";

/**
 * Agent Ports dashboard page — CRUD + status for per-agent localhost listeners.
 * Keys referenced by ID only (masked secret); key NAME shown from assigned id mapping.
 * Accessible labels, role=alert errors, responsive table, theme tokens, i18n-ready.
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";

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

  const keyName = useCallback(
    (id: string) => keys.find((k) => k.id === id)?.name ?? id,
    [keys],
  );

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

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const checkAvailability = useCallback(async () => {
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
      setCheck(assigned ? { kind: "taken", detail: "Port is already assigned to an agent endpoint" } : { kind: "free" });
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

  const statusStyle = (s: string) =>
    s === "running"
      ? "bg-emerald-500/15 text-emerald-500 border border-emerald-500/30"
      : s === "error"
        ? "bg-red-500/15 text-red-500 border border-red-500/30"
        : "bg-gray-500/15 text-text-muted border border-gray-500/30";

  const inputCls =
    "rounded-md border border-black/10 dark:border-white/10 bg-black/5 dark:bg-white/5 px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-1 focus:ring-blue-500";

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold text-text-main">{t("agentPorts")}</h1>
        <p className="text-sm text-text-muted">{t("agentPortsSubtitle")}</p>
      </div>

      {error && (
        <div role="alert" className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-500">
          {error}
        </div>
      )}

      <div className="rounded-xl border border-black/10 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.03] p-4">
        <h2 className="mb-3 font-medium text-text-main">{t("newPort")}</h2>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="agent-port-name" className="text-xs text-text-muted">
              {t("name")}
            </label>
            <input
              id="agent-port-name"
              className={inputCls}
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
            <input
              id="agent-port-port"
              className={`${inputCls} w-36`}
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
            <select
              id="agent-port-key"
              className={inputCls}
              value={apiKeyId}
              onChange={(e) => setApiKeyId(e.target.value)}
            >
              <option value="">{t("selectKey")}</option>
              {keys.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className="rounded-md border border-black/10 dark:border-white/10 px-3 py-2 text-sm text-text-main hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50"
            disabled={!port || check.kind === "checking"}
            onClick={checkAvailability}
          >
            {check.kind === "checking" ? t("checking") : t("checkAvailability")}
          </button>
          <button
            type="button"
            className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500 disabled:opacity-50"
            disabled={busy || !name.trim() || !port || !apiKeyId}
            onClick={create}
          >
            {t("create")}
          </button>
        </div>
        {check.kind === "free" && (
          <p className="mt-2 text-xs text-emerald-500">{t("portAppearsFree")}</p>
        )}
        {check.kind === "taken" && (
          <p role="alert" className="mt-2 text-xs text-amber-500">
            {check.detail} — {t("bindAuthoritative")}
          </p>
        )}
        {check.kind === "invalid" && (
          <p role="alert" className="mt-2 text-xs text-red-500">
            {check.detail}
          </p>
        )}
      </div>

      <div className="overflow-x-auto rounded-xl border border-black/10 dark:border-white/10">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-black/10 dark:border-white/10 bg-black/5 dark:bg-white/5 text-left">
              <th className="p-3 font-medium text-text-muted">{t("name")}</th>
              <th className="p-3 font-medium text-text-muted">{t("port")}</th>
              <th className="p-3 font-medium text-text-muted">{t("apiKey")}</th>
              <th className="p-3 font-medium text-text-muted">{t("baseUrl")}</th>
              <th className="p-3 font-medium text-text-muted">{t("status")}</th>
              <th className="p-3 font-medium text-text-muted">{t("actions")}</th>
            </tr>
          </thead>
          <tbody>
            {endpoints.length === 0 && (
              <tr>
                <td className="p-4 text-text-muted" colSpan={6}>
                  {t("empty")}
                </td>
              </tr>
            )}
            {endpoints.map((ep) => (
              <tr key={ep.id} className="border-b border-black/5 dark:border-white/5">
                <td className="p-3 font-medium text-text-main">{ep.name}</td>
                <td className="p-3 text-text-main">{ep.port}</td>
                <td className="p-3 text-text-main">
                  <span title={ep.apiKeyId}>{keyName(ep.apiKeyId)}</span>
                  <span className="ml-1 text-xs text-text-muted">({ep.apiKeyId.slice(0, 8)}…)</span>
                </td>
                <td className="p-3">
                  <code className="text-xs text-text-main">{ep.baseUrl}</code>
                  <button
                    type="button"
                    className="ml-2 text-xs text-blue-500 hover:underline"
                    onClick={() => copyBase(ep)}
                  >
                    {copied === ep.id ? t("copied") : t("copy")}
                  </button>
                </td>
                <td className="p-3" title={ep.statusDetail ?? undefined}>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${statusStyle(ep.status)}`}>
                    {ep.status}
                  </span>
                </td>
                <td className="space-x-2 p-3 whitespace-nowrap">
                  <button
                    type="button"
                    className="rounded border border-black/10 dark:border-white/10 px-2 py-1 text-xs text-text-main hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50"
                    disabled={busy}
                    onClick={() => act(ep.id, ep.status === "running" ? "stop" : "start")}
                  >
                    {ep.status === "running" ? t("stop") : t("start")}
                  </button>
                  <button
                    type="button"
                    className="rounded border border-black/10 dark:border-white/10 px-2 py-1 text-xs text-text-main hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50"
                    disabled={busy}
                    onClick={() => {
                      setEditingId(editingId === ep.id ? null : ep.id);
                      setEditPort("");
                      setEditApiKeyId("");
                    }}
                  >
                    {t("edit")}
                  </button>
                  <button
                    type="button"
                    className="rounded border border-red-500/30 px-2 py-1 text-xs text-red-500 hover:bg-red-500/10 disabled:opacity-50"
                    disabled={busy}
                    onClick={() => remove(ep.id)}
                  >
                    {t("delete")}
                  </button>
                  {editingId === ep.id && (
                    <span className="ml-2 inline-flex items-center gap-2 align-middle">
                      <input
                        aria-label={t("newPortValue")}
                        className={`${inputCls} w-28`}
                        placeholder={t("newPortValue")}
                        value={editPort}
                        inputMode="numeric"
                        onChange={(e) => setEditPort(e.target.value.replace(/[^0-9]/g, ""))}
                      />
                      <select
                        aria-label={t("reassignKey")}
                        className={inputCls}
                        value={editApiKeyId}
                        onChange={(e) => setEditApiKeyId(e.target.value)}
                      >
                        <option value="">{t("reassignKey")}</option>
                        {keys.map((k) => (
                          <option key={k.id} value={k.id}>
                            {k.name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="rounded bg-blue-600 px-2 py-1 text-xs text-white disabled:opacity-50"
                        disabled={busy || (!editPort && !editApiKeyId)}
                        onClick={() => saveEdit(ep.id)}
                      >
                        {t("save")}
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
