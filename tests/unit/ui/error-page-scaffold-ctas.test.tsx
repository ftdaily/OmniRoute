// @vitest-environment jsdom
import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import fs from "node:fs";
import path from "node:path";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

const { default: ErrorPageScaffold } = await import("@/shared/components/ErrorPageScaffold");

afterEach(() => cleanup());

// #18068: the two CTAs were hand-styled links (`px-6 py-3 rounded-lg bg-primary …`); they are
// kit buttons now, rendered as links through `buttonVariants`.
describe("ErrorPageScaffold CTAs", () => {
  it("renders the primary and secondary actions as kit button links", () => {
    const { getByRole } = render(
      <ErrorPageScaffold
        code="404"
        title="Not found"
        description="Gone"
        primaryAction={{ href: "/dashboard", label: "Dashboard" }}
        secondaryAction={{ href: "/status", label: "Status" }}
      />
    );
    const primary = getByRole("link", { name: "Dashboard" });
    const secondary = getByRole("link", { name: "Status" });
    expect(primary.getAttribute("href")).toBe("/dashboard");
    expect(secondary.getAttribute("href")).toBe("/status");
    expect(primary.className).toContain("ci-button--default");
    expect(primary.className).toContain("ci-button--size-lg");
    expect(secondary.className).toContain("ci-button--outline");
    expect(secondary.className).toContain("ci-button--size-lg");
    for (const link of [primary, secondary]) {
      expect(link.className).not.toMatch(/\b(bg-primary|px-6|py-3|rounded-lg)\b/);
    }
  });

  it("stays a client component so kit buttonVariants() never runs on the server", () => {
    // RSC error on /400../503: "Attempted to call buttonVariants() from the server
    // but buttonVariants is on the client" (#19388 scaffold called a "use client"
    // export from a server component). All props are serializable, so "use client"
    // is the correct smallest fix.
    const sourcePath = path.resolve(
      import.meta.dirname,
      "../../../src/shared/components/ErrorPageScaffold.tsx"
    );
    const firstLine = fs.readFileSync(sourcePath, "utf8").split("\n")[0].trim();
    expect(firstLine).toBe('"use client";');
  });

  it("falls back to the dashboard and status actions", () => {
    const { getByRole } = render(<ErrorPageScaffold code="500" title="Oops" description="x" />);
    expect(getByRole("link", { name: "goToDashboard" }).className).toContain("ci-button");
    expect(getByRole("link", { name: "checkSystemStatus" }).className).toContain("ci-button");
  });
});
