"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import Button from "@/shared/components/Button";
import Input from "@/shared/components/Input";
import { extractApiErrorMessage } from "@/shared/http/apiErrorMessage";

/**
 * Scoped user-portal login (p9-owned, outside (dashboard) layout).
 * Posts the router API key once; the server sets an HttpOnly session cookie.
 * The raw key is cleared from state after submit and never persisted.
 */
export default function UserLoginPage() {
  const t = useTranslations("userPortal");
  const router = useRouter();
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const submittedKey = apiKey;
    setApiKey("");
    setError("");
    setLoading(true);
    try {
      const baseUrl = typeof window !== "undefined" ? window.location.origin : "";
      const res = await fetch(`${baseUrl}/api/user/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ apiKey: submittedKey }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(extractApiErrorMessage(body, t("loginFailed")));
        setLoading(false);
        return;
      }
      router.push("/user");
    } catch {
      setError(t("loginNetworkError"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <form
        onSubmit={handleSubmit}
        aria-label={t("loginTitle")}
        className="w-full max-w-sm flex flex-col gap-4 p-6 rounded-lg border border-border bg-surface/40"
      >
        <h1 className="text-lg font-semibold text-text-main">{t("loginTitle")}</h1>
        <p className="text-sm text-text-muted">{t("loginDescription")}</p>
        <label htmlFor="user-portal-api-key" className="text-sm font-medium text-text-main">
          {t("apiKeyLabel")}
        </label>
        <Input
          id="user-portal-api-key"
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setApiKey(e.target.value)}
          placeholder={t("apiKeyPlaceholder")}
          required
        />
        {error ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-300">
            {error}
          </p>
        ) : null}
        <Button type="submit" disabled={loading || apiKey.length === 0}>
          {loading ? t("loggingIn") : t("loginButton")}
        </Button>
      </form>
    </main>
  );
}
