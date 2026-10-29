"use client";

import { useMemo, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { getI18nOrFallback } from "./comboPageHelpers";
import {
  describeComboStepTestResult,
  getComboStepTestKey,
  getComboStepTestSnapshot,
  resolveComboStepTestTarget,
  runComboStepTest,
  subscribeComboStepTests,
} from "./comboStepTest";
import Icon from "@/shared/components/Icon";

const STATE_STYLES = {
  idle: { icon: "science", tone: "text-text-muted border-transparent" },
  running: { icon: "progress_activity", tone: "text-text-muted border-transparent" },
  ok: { icon: "check_circle", tone: "text-success border-success/40" },
  error: { icon: "cancel", tone: "text-error border-error/40" },
} as const;

/** Per-step Test button for the combo modal model list (one probe per click). */
export default function ComboStepTestButton({ entry }: { entry: unknown }) {
  const t = useTranslations("combos");
  const target = useMemo(() => resolveComboStepTestTarget(entry), [entry]);
  const key = target ? getComboStepTestKey(target) : null;
  const snapshot = useSyncExternalStore(
    subscribeComboStepTests,
    () => (key ? getComboStepTestSnapshot(key) : undefined),
    () => undefined
  );

  const state = snapshot?.state ?? "idle";
  const style = STATE_STYLES[state];
  const title = !target
    ? getI18nOrFallback(t, "testStepNotTestable", "Only single-model steps can be tested")
    : snapshot?.state === "running"
      ? getI18nOrFallback(t, "testStepRunning", "Testing…")
      : snapshot
        ? describeComboStepTestResult(snapshot)
        : getI18nOrFallback(t, "testStep", "Test this model");

  return (
    // kit-exception: icon-only step probe (spinner while running); the kit Button is a
    // labelled pill control, this is a status glyph not an action label
    <button
      type="button"
      onClick={() => target && void runComboStepTest(target)}
      disabled={!target || state === "running"}
      className={`p-0.5 rounded border transition-colors ${style.tone} ${
        target ? "hover:text-primary hover:bg-bg-subtle" : "opacity-30 cursor-not-allowed"
      }`}
      title={title}
      aria-label={title}
    >
      <Icon
        name={style.icon as never}
        size={12}
        className={state === "running" ? "animate-spin" : ""}
      />
    </button>
  );
}
