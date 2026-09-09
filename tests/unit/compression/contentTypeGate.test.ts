/**
 * TDD for the content-type gate (stacked-loop skip decisions).
 * Run: node --import tsx/esm --test tests/unit/compression/contentTypeGate.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  contentTypeOfBody,
  shouldSkipEngineForContentType,
} from "../../../open-sse/services/compression/contentTypeGate.ts";
import { applyStackedCompression } from "../../../open-sse/services/compression/strategySelector.ts";

const ON = { enabled: true } as const;
const OFF = { enabled: false } as const;

describe("contentTypeOfBody", () => {
  it("classifies joined message text", () => {
    const r = contentTypeOfBody({
      messages: [{ role: "user", content: '{"a": 1}' }],
    });
    assert.equal(r.contentType, "json");
  });

  it("handles array content parts and empty bodies", () => {
    const r = contentTypeOfBody({
      messages: [{ role: "user", content: [{ type: "text", text: "plain prose here" }] }],
    });
    assert.equal(r.contentType, "text");
    assert.equal(contentTypeOfBody({}).contentType, "text");
    assert.equal(contentTypeOfBody({ messages: "nope" }).contentType, "text");
  });
});

describe("shouldSkipEngineForContentType", () => {
  it("never skips when gate is off/absent", () => {
    assert.equal(shouldSkipEngineForContentType("caveman", "json", 0.95, undefined), false);
    assert.equal(shouldSkipEngineForContentType("caveman", "json", 0.95, OFF), false);
  });

  it("never skips below the confidence threshold", () => {
    assert.equal(shouldSkipEngineForContentType("caveman", "json", 0.5, ON), false);
    assert.equal(
      shouldSkipEngineForContentType("caveman", "json", 0.69, ON),
      false
    );
  });

  it("skips non-applicable engines at high confidence", () => {
    assert.equal(shouldSkipEngineForContentType("caveman", "json", 0.9, ON), true);
    assert.equal(shouldSkipEngineForContentType("rtk", "json", 0.9, ON), true);
    assert.equal(shouldSkipEngineForContentType("ionizer", "json", 0.9, ON), false);
  });

  it("honors a custom confidenceThreshold", () => {
    const cfg = { enabled: true, confidenceThreshold: 0.95 } as const;
    assert.equal(shouldSkipEngineForContentType("caveman", "json", 0.9, cfg), false);
    assert.equal(shouldSkipEngineForContentType("caveman", "json", 0.96, cfg), true);
  });

  it("unknown engines fail open", () => {
    assert.equal(
      shouldSkipEngineForContentType("some-future-engine", "json", 0.95, ON),
      false
    );
  });
});

describe("gate-off byte-identical", () => {
  it("applyStackedCompression without the gate matches legacy output", () => {
    const body = () => ({
      messages: [{ role: "user", content: "hello   world\n\n\ntest" }],
    });
    const a = applyStackedCompression(body(), [{ engine: "lite" }], {});
    const b = applyStackedCompression(body(), [{ engine: "lite" }], {
      contentTypeRouter: { enabled: false },
    });
    assert.equal(
      JSON.stringify(a.body),
      JSON.stringify(b.body),
      "gate-off run must equal legacy run"
    );
  });

  it("gate-on json body skips caveman with a validation warning", () => {
    const body = {
      messages: [{ role: "user", content: '{"rows": [1,2,3], "ok": true}' }],
    };
    const res = applyStackedCompression(body, [{ engine: "caveman" }], {
      contentTypeRouter: { enabled: true },
    });
    assert.ok(
      (res.stats?.validationWarnings ?? []).some((w) =>
        w.includes("skipped (content-type json)")
      ),
      "expected a content-type skip warning"
    );
  });
});
