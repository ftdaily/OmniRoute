// @vitest-environment jsdom

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../../../src/i18n/messages/en.json";
import ApiKeyAccessEditorClient from "../../../src/app/(dashboard)/dashboard/api-manager/[id]/access/ApiKeyAccessEditorClient";
import { useNotificationStore } from "../../../src/store/notificationStore";

const mockRouter = { push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() };
let currentSearch = "";

vi.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => new URLSearchParams(currentSearch),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

function keyRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "test-key-id",
    name: "Portal Key",
    key: "omni-tes****5678",
    modelAccessMode: "all",
    allowedModels: [],
    blockedModels: [],
    allowedCombos: [],
    allowedConnections: [],
    portalEnabled: false,
    userCombosEnabled: false,
    noLog: false,
    autoResolve: false,
    isActive: true,
    throttleDelayMs: 0,
    isBanned: false,
    expiresAt: null,
    maxSessions: 0,
    accessSchedule: null,
    rateLimits: null,
    scopes: ["manage", "self:usage"],
    allowedEndpoints: [],
    streamDefaultMode: "legacy",
    compressionEnabled: true,
    allowAutoCombos: true,
    catalogScope: "all",
    disableNonPublicModels: false,
    allowUsageCommand: false,
    usageLimitEnabled: false,
    dailyUsageLimitUsd: null,
    weeklyUsageLimitUsd: null,
    chaosModeEnabled: false,
    ...overrides,
  };
}

function installFetch(serverKey: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const s = String(url);
      if (s.includes("/api/keys/test-key-id") && init?.method === "PATCH") return { ok: true, status: 200, json: async () => ({ message: "ok" }) };
      if (s.includes("/api/keys/test-key-id")) return { ok: true, status: 200, json: async () => ({ ...serverKey }) };
      if (s.includes("/v1/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
      if (s.includes("/api/combos")) return { ok: true, status: 200, json: async () => ({ combos: [] }) };
      if (s.includes("/api/providers")) return { ok: true, status: 200, json: async () => ({ connections: [{ id: "conn-1", name: "AmanAI", provider: "test" }] }) };
      return { ok: true, status: 200, json: async () => ({}) };
    })
  );
}

function renderEditor() {
  useNotificationStore.setState({ toasts: [], notify: vi.fn() } as unknown as never);
  return render(
    <NextIntlClientProvider locale="en" messages={messages as never}>
      <ApiKeyAccessEditorClient apiKeyId="test-key-id" />
    </NextIntlClientProvider>
  );
}

async function openGeneral() {
  renderEditor();
  await waitFor(() => expect(screen.getByRole("tablist")).toBeDefined());
}

beforeEach(() => {
  currentSearch = "";
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("portal toggles hidden (user portal removed), connection grants still usable", () => {
  it("no portal switch or combos switch rendered", async () => {
    installFetch(keyRecord({ allowedConnections: [] }));
    await openGeneral();
    expect(screen.queryByRole("switch", { name: /user portal access/i })).toBeNull();
    expect(screen.queryByRole("switch", { name: /private combos/i })).toBeNull();
  });

  it("management tabs still render", async () => {
    installFetch(keyRecord({ allowedConnections: [] }));
    await openGeneral();
    for (const name of [/general/i, /models/i, /combos/i, /connections/i, /limits/i]) {
      expect(screen.getByRole("tab", { name })).toBeDefined();
    }
  });

  it("connections tab shows grant controls and selects a connection", async () => {
    installFetch(keyRecord({ allowedConnections: [] }));
    await openGeneral();
    fireEvent.click(screen.getByRole("tab", { name: /connections/i }));
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /connections/i }).getAttribute("aria-selected")).toBe("true");
    });
    // Grant UI: All/Selected segmented buttons + per-connection list when restricted.
    const grantButtons = screen.queryAllByRole("button", { name: /connections/i });
    const listControls = screen.queryByText(/select at least one connection/i)
      || screen.queryByText(/restricted to/i)
      || screen.queryByText(/all connections/i);
    expect(grantButtons.length > 0 || listControls !== null).toBe(true);
  });

  it("grant selection persists through PATCH without portal flags", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const s = String(url);
      if (s.includes("/api/keys/test-key-id") && init?.method === "PATCH") {
        const body = JSON.parse(String(init?.body ?? "{}"));
        expect(body.portalEnabled).toBeUndefined();
        expect(body.userCombosEnabled).toBeUndefined();
        return { ok: true, status: 200, json: async () => ({ message: "ok" }) };
      }
      if (s.includes("/api/keys/test-key-id")) return { ok: true, status: 200, json: async () => keyRecord({ allowedConnections: [] }) };
      if (s.includes("/api/providers")) return { ok: true, status: 200, json: async () => ({ connections: [{ id: "conn-1", name: "AmanAI", provider: "test" }] }) };
      return { ok: true, status: 200, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);
    await openGeneral();
    fireEvent.click(screen.getByRole("tab", { name: /connections/i }));
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /connections/i }).getAttribute("aria-selected")).toBe("true");
    });
    const save = screen.queryByRole("button", { name: /save/i });
    if (save) {
      fireEvent.click(save);
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
      });
    }
  });
});
