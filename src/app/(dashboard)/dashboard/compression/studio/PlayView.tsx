"use client";
import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { usePreviewCompression, type Lane, type PreviewBatch } from "@/hooks/usePreviewCompression";
import {
  detectContentType,
  pipelineFullyGated,
} from "@omniroute/open-sse/services/compression/contentTypeRouter";
import { WaterfallInspector } from "./WaterfallInspector";
import { DiffPane } from "./DiffPane";
import { EncoderComparisonTable } from "./EncoderComparisonTable";
import { PlaygroundInput, LANE_ENGINES } from "./PlaygroundInput";
import { RiskGateBadge } from "./RiskGateBadge";
import { QuantumLockBadge } from "./QuantumLockBadge";
import { SaliencyHeatmap } from "./SaliencyHeatmap";
export interface PlayViewProps {
  text: string;
  onText: (t: string) => void;
  laneEngines?: readonly string[];
}

function laneStatus(l: Lane, t: ReturnType<typeof useTranslations>): string {
  const rejected = l.run?.steps?.find((s) => s.rejected);
  if (rejected) return `⚠ ${t("laneRejected", { reason: rejected.rejectReason ?? "" })}`;
  return l.error ? `⚠ ${t("error")}` : l.run ? `−${l.run.savingsPercent}%` : "—";
}

function resolveActiveDiff(batch: PreviewBatch | null, selectedLane: string | null) {
  const run = batch?.lanes.find((l) => l.engine === selectedLane)?.run ?? null;
  return run?.diff ?? batch?.combined?.diff ?? null;
}

function LaneList({ lanes, onSelect }: { lanes: Lane[]; onSelect: (e: string) => void }) {
  const t = useTranslations("compressionStudio");
  return (
    <>
      {lanes.map((l) => (
        <button
          key={l.engine}
          data-testid="play-lane"
          onClick={() => onSelect(l.engine)}
          className="flex w-full items-center justify-between border-b py-1 text-left font-mono text-xs"
        >
          <span>{l.engine}</span>
          <span>{laneStatus(l, t)}</span>
        </button>
      ))}
    </>
  );
}

export function PlayView({ text, onText, laneEngines = LANE_ENGINES }: PlayViewProps) {
  const t = useTranslations("compressionStudio");
  const [active, setActive] = useState<string[]>(["rtk", "caveman"]);
  const [fuzzyDedup, setFuzzyDedup] = useState(false);
  const [selectedLane, setSelectedLane] = useState<string | null>(null);
  const [fidelityGate, setFidelityGate] = useState(false);
  const [riskGate, setRiskGate] = useState(false);
  const [quantumLock, setQuantumLock] = useState(false);
  const [contentTypeRouter, setContentTypeRouter] = useState(false);
  const [heatmapMode, setHeatmapMode] = useState<"ultra" | "universal" | false>(false);
  const { batch, loading, run } = usePreviewCompression();
  const messages = [{ role: "user", content: text }];
  const toggle = (e: string) =>
    setActive((a) => (a.includes(e) ? a.filter((x) => x !== e) : [...a, e]));
  const toggleHeatmap = () =>
    setHeatmapMode((m) => {
      if (!m) return "ultra";
      if (m === "ultra") return "universal";
      return false;
    });
  const onRun = () =>
    run({
      messages,
      laneEngines: [...laneEngines],
      activeEngines: orderByStack(active, laneEngines),
      fidelityGate,
      fuzzyDedup,
      riskGate,
      quantumLock,
      contentTypeRouter,
      ...(heatmapMode ? { heatmap: heatmapMode } : {}),
    });
  const activeDiff = resolveActiveDiff(batch, selectedLane);
  // Client-side pre-flight: when the router is on and the pasted text classifies
  // confidently into a type none of the active engines handles, the run would
  // skip every engine — warn instead of producing a confusing no-op.
  const fullyGated = useMemo(() => {
    if (!contentTypeRouter) return null;
    const detected = detectContentType(text);
    if (detected.confidence < 0.7) return null;
    const engines = orderByStack(active, laneEngines);
    return pipelineFullyGated(detected.contentType, engines) ? detected.contentType : null;
  }, [contentTypeRouter, text, active, laneEngines]);
  return (
    <div className="flex h-full gap-3">
      <div className="w-[260px] shrink-0">
        <PlaygroundInput
          text={text}
          onText={onText}
          active={active}
          onToggleActive={toggle}
          onRun={onRun}
          loading={loading}
          fidelityGate={fidelityGate}
          onToggleFidelity={() => setFidelityGate((v) => !v)}
          fuzzyDedup={fuzzyDedup}
          onToggleFuzzy={() => setFuzzyDedup((v) => !v)}
          riskGate={riskGate}
          onToggleRisk={() => setRiskGate((v) => !v)}
          quantumLock={quantumLock}
          onToggleQuantum={() => setQuantumLock((v) => !v)}
          contentTypeRouter={contentTypeRouter}
          onToggleContentType={() => setContentTypeRouter((v) => !v)}
          heatmap={heatmapMode}
          onToggleHeatmap={toggleHeatmap}
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-auto">
        {fullyGated ? (
          <div data-testid="content-type-warning" className="text-xs text-amber-700">
            {t("contentTypeNoEngine", { contentType: fullyGated })}
          </div>
        ) : null}
        {batch?.combined && (
          <section data-testid="play-combined">
            <header className="text-xs font-semibold">
              {t("combinedFlow")} — {active.join(" → ")}{" "}
              <QuantumLockBadge stats={batch.combined.quantumLock} />
            </header>
            <WaterfallInspector run={batch.combined} />
            <RiskGateBadge stats={batch?.riskGate ?? null} />
            {batch?.contentType ? (
              <div data-testid="content-type-badge" className="text-xs text-slate-500">
                {batch.contentType.type} ({Math.round(batch.contentType.confidence * 100)}%)
              </div>
            ) : null}
          </section>
        )}
        <section>
          <header className="text-xs font-semibold">{t("eachLayer")}</header>
          <LaneList lanes={batch?.lanes ?? []} onSelect={setSelectedLane} />
        </section>
        {(() => {
          const cmp =
            batch?.lanes.find((l) => l.engine === "headroom")?.run?.encoderComparison ??
            batch?.combined?.encoderComparison ??
            null;
          return cmp ? <EncoderComparisonTable comparison={cmp} /> : null;
        })()}
        {activeDiff && (
          <section>
            <header className="text-xs font-semibold">
              {t("diff")} — {selectedLane ?? t("combined")}
            </header>
            <DiffPane segments={activeDiff} preservedBlocks={[]} />
          </section>
        )}
        {batch?.heatmap && (
          <section data-testid="play-heatmap">
            <header className="text-xs font-semibold">
              {t("saliencyHeatmap")} — {batch.heatmap.mode}
            </header>
            <SaliencyHeatmap heatmap={batch.heatmap} />
          </section>
        )}
      </div>
    </div>
  );
}
function orderByStack(active: string[], order: readonly string[]): string[] {
  return order.filter((e) => active.includes(e));
}
