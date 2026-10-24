"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import Button from "@/shared/components/Button";
import Input from "@/shared/components/Input";
import { extractApiErrorMessage } from "@/shared/http/apiErrorMessage";
import { userMutatingHeaders, clearUserCsrfToken } from "@/lib/userPortalCsrf";

interface PortalModel {
  id: string;
  disabled: boolean;
}

interface PortalCombo {
  id: string;
  name: string;
  models: string[];
  enabled: boolean;
  revision: number;
}

/**
 * Scoped user dashboard (p9-owned, outside (dashboard) layout).
 * Model toggles are personal preferences enforced server-side via
 * expectedRevision 409; private combos are priority-only and wired as
 * user-combo/<uuid>. Logout clears all portal sessions.
 */
export default function UserPortalPage() {
  const t = useTranslations("userPortal");
  const router = useRouter();
  const [models, setModels] = useState<PortalModel[]>([]);
  const [revision, setRevision] = useState(0);
  const [combos, setCombos] = useState<PortalCombo[]>([]);
  const [combosEnabled, setCombosEnabled] = useState(false);
  const [comboName, setComboName] = useState("");
  const [comboModels, setComboModels] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingRevision, setEditingRevision] = useState(0);

  const comboWireId = (id: string) => (id.startsWith("user-combo/") ? id : `user-combo/${id}`);
  const [error, setError] = useState("");

  const baseUrl = () => (typeof window !== "undefined" ? window.location.origin : "");

  const loadAll = useCallback(async () => {
    try {
      const [meRes, modelsRes, prefsRes, combosRes] = await Promise.all([
        fetch(`${baseUrl()}/api/user/me`, { credentials: "same-origin" }),
        fetch(`${baseUrl()}/api/user/models`, { credentials: "same-origin" }),
        fetch(`${baseUrl()}/api/user/preferences`, { credentials: "same-origin" }),
        fetch(`${baseUrl()}/api/user/combos`, { credentials: "same-origin" }),
      ]);
      if ([meRes, modelsRes, prefsRes, combosRes].some((res) => res.status === 401)) {
        router.push("/user/login");
        return;
      }
      if (meRes.ok) {
        const me = (await meRes.json()) as { userCombosEnabled?: boolean };
        setCombosEnabled(me.userCombosEnabled === true);
      }
      if (modelsRes.ok && prefsRes.ok) {
        const catalog = (await modelsRes.json()) as { models?: PortalModel[] };
        const prefs = (await prefsRes.json()) as { disabledModels?: string[]; revision?: number };
        const disabled = new Set(prefs.disabledModels ?? []);
        setModels((catalog.models ?? []).map((m) => ({ id: m.id, disabled: m.disabled ?? disabled.has(m.id) })));
        setRevision(prefs.revision ?? 0);
      }
      if (combosRes.ok) {
        const data = (await combosRes.json()) as { combos?: PortalCombo[] };
        setCombos(data.combos ?? []);
      }
    } catch {
      setError(t("loadFailed"));
    }
  }, [router, t]);

  useEffect(() => {
    void Promise.resolve().then(() => loadAll());
  }, [loadAll]);

  async function toggleModel(modelId: string, disabled: boolean) {
    setError("");
    const nextDisabled = models.filter((m) => m.disabled).map((m) => m.id);
    if (disabled) {
      if (!nextDisabled.includes(modelId)) nextDisabled.push(modelId);
    } else {
      const idx = nextDisabled.indexOf(modelId);
      if (idx >= 0) nextDisabled.splice(idx, 1);
    }
    try {
      const res = await fetch(`${baseUrl()}/api/user/preferences`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: await userMutatingHeaders(),
        body: JSON.stringify({ disabledModels: nextDisabled, expectedRevision: revision }),
      });
      if (res.status === 409) {
        setError(t("staleRevision"));
        await loadAll();
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(extractApiErrorMessage(body, t("saveFailed")));
        return;
      }
      const saved = (await res.json()) as { disabledModels?: string[]; revision?: number };
      const disabledSet = new Set(saved.disabledModels ?? nextDisabled);
      setModels((prev) => prev.map((m) => ({ ...m, disabled: disabledSet.has(m.id) })));
      setRevision(saved.revision ?? revision + 1);
    } catch {
      setError(t("saveFailed"));
    }
  }

  async function createCombo(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const modelsList = comboModels
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      const res = await fetch(`${baseUrl()}/api/user/combos`, {
        method: "POST",
        credentials: "same-origin",
        headers: await userMutatingHeaders(),
        body: JSON.stringify({ name: comboName.trim(), models: modelsList }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(extractApiErrorMessage(body, t("comboCreateFailed")));
        return;
      }
      const created = (await res.json()) as PortalCombo;
      setCombos((prev) => [...prev, created]);
      setComboName("");
      setComboModels("");
    } catch {
      setError(t("comboCreateFailed"));
    }
  }

  async function saveComboEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingId) return;
    setError("");
    const modelsList = comboModels
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      const res = await fetch(`${baseUrl()}/api/user/combos/${encodeURIComponent(editingId)}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: await userMutatingHeaders(),
        body: JSON.stringify({ name: comboName.trim(), models: modelsList, expectedRevision: editingRevision }),
      });
      if (res.status === 409) {
        setError(t("staleRevision"));
        await loadAll();
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(extractApiErrorMessage(body, t("comboUpdateFailed")));
        return;
      }
      setEditingId(null);
      setComboName("");
      setComboModels("");
      await loadAll();
    } catch {
      setError(t("comboUpdateFailed"));
    }
  }

  async function toggleComboEnabled(c: PortalCombo) {
    setError("");
    try {
      const res = await fetch(`${baseUrl()}/api/user/combos/${encodeURIComponent(c.id)}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: await userMutatingHeaders(),
        body: JSON.stringify({ enabled: !c.enabled, expectedRevision: c.revision }),
      });
      if (res.status === 409) {
        setError(t("staleRevision"));
        await loadAll();
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(extractApiErrorMessage(body, t("comboUpdateFailed")));
        return;
      }
      await loadAll();
    } catch {
      setError(t("comboUpdateFailed"));
    }
  }

  async function deleteCombo(c: PortalCombo) {
    if (!window.confirm(t("comboDeleteConfirm"))) return;
    setError("");
    try {
      const res = await fetch(`${baseUrl()}/api/user/combos/${encodeURIComponent(c.id)}`, {
        method: "DELETE",
        credentials: "same-origin",
        headers: await userMutatingHeaders(),
        body: JSON.stringify({ expectedRevision: c.revision }),
      });
      if (res.status === 409) {
        setError(t("staleRevision"));
        await loadAll();
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(extractApiErrorMessage(body, t("comboDeleteFailed")));
        return;
      }
      if (editingId === c.id) {
        setEditingId(null);
        setComboName("");
        setComboModels("");
      }
      await loadAll();
    } catch {
      setError(t("comboDeleteFailed"));
    }
  }

  async function handleLogout() {
    try {
      await fetch(`${baseUrl()}/api/user/auth/logout`, {
        method: "POST",
        credentials: "same-origin",
        headers: await userMutatingHeaders(),
      });
    } finally {
      clearUserCsrfToken();
      router.push("/user/login");
    }
  }

  return (
    <main className="min-h-screen p-6 flex flex-col gap-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-text-main">{t("dashboardTitle")}</h1>
        <Button onClick={handleLogout}>{t("logoutAll")}</Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-300">
          {error}
        </p>
      ) : null}
      <section aria-label={t("modelsSection")} className="flex flex-col gap-2">
        <h2 className="text-base font-medium text-text-main">{t("modelsSection")}</h2>
        <ul className="flex flex-col gap-1">
          {models.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-3 text-sm">
              <span className="text-text-main break-all">{m.id}</span>
              <button
                type="button"
                role="switch"
                aria-checked={!m.disabled}
                aria-label={m.id}
                onClick={() => toggleModel(m.id, !m.disabled)}
                className="px-2.5 py-1.5 rounded-md text-xs font-semibold border border-border"
              >
                {m.disabled ? t("enable") : t("disable")}
              </button>
            </li>
          ))}
        </ul>
      </section>
      {combosEnabled ? (
        <section aria-label={t("combosSection")} className="flex flex-col gap-3">
          <h2 className="text-base font-medium text-text-main">{t("combosSection")}</h2>
          <ul className="flex flex-col gap-1">
            {combos.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-text-main break-all">
                  {c.name} <span className="text-text-muted">{comboWireId(c.id)}</span>
                </span>
                <span className="text-xs text-text-muted">{c.models.join(", ")}</span>
                <span className="flex gap-1 shrink-0">
                  <button
                    type="button"
                    aria-label={`${t("comboEditButton")}: ${c.name}`}
                    onClick={() => {
                      setEditingId(c.id);
                      setEditingRevision(c.revision);
                      setComboName(c.name);
                      setComboModels(c.models.join(", "));
                      setError("");
                    }}
                    className="px-2 py-1 rounded-md text-xs font-semibold border border-border"
                  >
                    {t("comboEditButton")}
                  </button>
                  <button
                    type="button"
                    aria-label={`${c.enabled ? t("comboDisableButton") : t("comboEnableButton")}: ${c.name}`}
                    onClick={() => toggleComboEnabled(c)}
                    className="px-2 py-1 rounded-md text-xs font-semibold border border-border"
                  >
                    {c.enabled ? t("comboDisableButton") : t("comboEnableButton")}
                  </button>
                  <button
                    type="button"
                    aria-label={`${t("comboDeleteButton")}: ${c.name}`}
                    onClick={() => deleteCombo(c)}
                    className="px-2 py-1 rounded-md text-xs font-semibold border border-border"
                  >
                    {t("comboDeleteButton")}
                  </button>
                </span>
              </li>
            ))}
          </ul>
          <form
            onSubmit={editingId ? saveComboEdit : createCombo}
            className="flex flex-col gap-2"
            aria-label={editingId ? t("comboEditTitle") : t("comboCreateTitle")}
          >
            <label htmlFor="user-combo-name" className="text-sm font-medium text-text-main">
              {t("comboNameLabel")}
            </label>
            <Input
              id="user-combo-name"
              value={comboName}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setComboName(e.target.value)}
              required
            />
            <label htmlFor="user-combo-models" className="text-sm font-medium text-text-main">
              {t("comboModelsLabel")}
            </label>
            <Input
              id="user-combo-models"
              value={comboModels}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setComboModels(e.target.value)}
              placeholder={t("comboModelsPlaceholder")}
              required
            />
            <Button type="submit">
              {editingId ? t("comboSaveButton") : t("comboCreateButton")}
            </Button>
            {editingId ? (
              <Button
                type="button"
                onClick={() => {
                  setEditingId(null);
                  setComboName("");
                  setComboModels("");
                }}
              >
                {t("comboCancelButton")}
              </Button>
            ) : null}
          </form>
        </section>
      ) : null}
    </main>
  );
}
