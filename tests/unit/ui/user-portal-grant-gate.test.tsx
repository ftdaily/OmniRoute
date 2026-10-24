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

describe("portal toggle grant gate", () => {
  it("no grant: enable blocked, helper + go-to-connections present", async () => {
    installFetch(keyRecord({ allowedConnections: [] }));
    await openGeneral();
    const portalSwitch = await screen.findByRole("switch", { name: /user portal access/i });
    expect(portalSwitch.getAttribute("aria-checked")).toBe("false");
    expect((portalSwitch as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Open Connections, turn off Allow all connections/i)).toBeDefined();
    expect(screen.getByRole("button", { name: /go to connections/i })).toBeDefined();
  });

  it("no grant: action opens connections tab", async () => {
    installFetch(keyRecord({ allowedConnections: [] }));
    await openGeneral();
    fireEvent.click(screen.getByRole("button", { name: /go to connections/i }));
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /connections/i }).getAttribute("aria-selected")).toBe("true");
    });
  });

  it("with grant: enable works via shared Toggle onChange", async () => {
    installFetch(keyRecord({ allowedConnections: ["conn-1"] }));
    await openGeneral();
    const portalSwitch = await screen.findByRole("switch", { name: /user portal access/i });
    expect((portalSwitch as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(portalSwitch);
    await waitFor(() => {
      expect(portalSwitch.getAttribute("aria-checked")).toBe("true");
    });
  });

  it("enabled + grant removed: OFF still works", async () => {
    installFetch(keyRecord({ allowedConnections: [], portalEnabled: true }));
    await openGeneral();
    const portalSwitch = await screen.findByRole("switch", { name: /user portal access/i });
    expect(portalSwitch.getAttribute("aria-checked")).toBe("true");
    expect((portalSwitch as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(portalSwitch);
    await waitFor(() => {
      expect(portalSwitch.getAttribute("aria-checked")).toBe("false");
    });
  });
});
