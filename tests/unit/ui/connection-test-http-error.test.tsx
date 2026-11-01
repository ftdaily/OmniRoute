// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const translate = vi.hoisted(() => (key: string) => key);
vi.mock("next-intl", () => ({ useTranslations: () => translate }));
vi.mock("../../../src/shared/components/Button", () => ({
  default: ({ children, loading, ...props }: any) => <button {...props}>{children}</button>,
}));
vi.mock("../../../src/shared/components/Modal", () => ({
  default: ({ isOpen, children }: any) => isOpen && <div>{children}</div>,
  TALL_MODAL_PROPS: {},
}));
vi.mock("../../../src/shared/components/Select", () => ({ default: () => null }));
const { default: ConnectionTestButton } =
  await import("../../../src/shared/components/ConnectionTestButton");

afterEach(() => vi.unstubAllGlobals());

it.each([
  [
    () => new Response("<html>Bad Gateway</html>", { status: 502, statusText: "Bad Gateway" }),
    "HTTP 502 Bad Gateway",
  ],
  [() => new Response("", { status: 503 }), "HTTP 503"],
  [
    () => Response.json({ error: { message: "Provider failed" } }, { status: 400 }),
    "Provider failed",
  ],
  [() => Response.json({ error: "Not authorized" }, { status: 401 }), "Not authorized"],
  [() => Response.json({ modelId: "", prompt: "Hello" }), null],
  [
    () => Response.json({ error: { message: "Too many requests" } }, { status: 429 }),
    "Too many requests",
  ],
  [
    () =>
      new Response("{bad json", { status: 200, headers: { "content-type": "application/json" } }),
    "EXPECTED_PARSE_ERROR",
  ],
])("displays response errors, preserving JSON behavior", async (response, message) => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.includes("/models?") ? Response.json({ models: [] }) : response()
    )
  );
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ConnectionTestButton connectionId="account-a" />));
    await act(async () => container.querySelector("button")!.click());
    const shown = container.querySelector('[role="alert"]')?.textContent ?? null;
    if (message === "EXPECTED_PARSE_ERROR") {
      expect(shown).toBeTruthy();
      expect(shown).not.toContain("{bad json");
    } else {
      expect(shown).toBe(message);
    }
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
