import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OUTPUT_STYLE_CATALOG,
  OUTPUT_STYLE_IDS,
  outputStyleLanguages,
  outputStyleMeta,
  type OutputStyle,
} from "../../../open-sse/services/compression/outputStyles/catalog.ts";

test("catalog seeds terse-prose, less-code, ponytail, terse-cjk with all three levels", () => {
  for (const id of ["terse-prose", "less-code", "ponytail", "terse-cjk"]) {
    const meta = outputStyleMeta(id);
    assert.ok(meta, `${id} present`);
    assert.equal(typeof meta.label, "string");
    for (const level of ["lite", "full", "ultra"] as const) {
      assert.equal(typeof meta.levels[level], "string");
      assert.ok(meta.levels[level].length > 0, `${id}.${level} non-empty`);
    }
  }
});

test("OUTPUT_STYLE_IDS lists every catalog id in catalog (declaration) order", () => {
  assert.deepEqual(OUTPUT_STYLE_IDS, Object.keys(OUTPUT_STYLE_CATALOG));
});

test("terse-cjk carries a locale gate of zh", () => {
  assert.equal(outputStyleMeta("terse-cjk").locale, "zh");
  assert.equal(outputStyleMeta("terse-prose").locale, undefined);
});

test("extensibility: one entry added to the catalog is enumerated with no other change", () => {
  const probe: OutputStyle = {
    id: "__probe__",
    label: "Probe",
    levels: { lite: "L", full: "F", ultra: "U" },
  };
  const extended = { ...OUTPUT_STYLE_CATALOG, [probe.id]: probe };
  const ids = Object.keys(extended);
  assert.ok(ids.includes("__probe__"));
  // Adding a style adds exactly one id; no plumbing edited.
  assert.equal(ids.length, OUTPUT_STYLE_IDS.length + 1);
});

test("less-code full/ultra carry the upstream output-cap and debt-marker clauses", () => {
  // Gaps backported from DietrichGebert/ponytail skills/ponytail/SKILL.md:
  // the "Output" cap (code first + ≤3 short lines; an explanation longer than
  // the code gets deleted) and the `ponytail:` debt-marker convention
  // (`ponytail: <ceiling>, <upgrade path>`).
  const less = outputStyleMeta("less-code");
  assert.ok(
    /three short lines|≤3 lines/i.test(less.levels.full),
    "less-code.full carries the output cap"
  );
  assert.ok(
    /≤3 lines|delete it/i.test(less.levels.ultra),
    "less-code.ultra carries the output cap"
  );
  assert.ok(
    less.levels.full.includes("ponytail:"),
    "less-code.full carries the debt-marker convention"
  );
  assert.ok(
    less.levels.ultra.includes("ponytail:"),
    "less-code.ultra carries the debt-marker convention"
  );
});

test("less-code explicitly-requested explanations are exempt from the cap (en)", () => {
  // Upstream: "Explanation the user explicitly asked for ... is not debt, give
  // it in full." Without this, the cap tells the model to delete even requested docs.
  const less = outputStyleMeta("less-code");
  assert.ok(
    /explicitly asked/i.test(less.levels.full),
    "less-code.full exempts explicitly-requested explanations"
  );
  assert.ok(
    /explicitly asked/i.test(less.levels.ultra),
    "less-code.ultra exempts explicitly-requested explanations"
  );
});

test("less-code i18n full/ultra carry cap + debt-marker + requested-explanation exemption", () => {
  // Per-locale semantic parity: each language must carry the same three clauses
  // using its own words (cap count, `ponytail:` marker is universal, exemption).
  // Locales share `ponytail:` as the marker; the exemption is matched by
  // language-specific "explicit(ly)" stems (e.g. explicitamente, ausdrücklich).
  const exemptionByLang: Record<string, RegExp> = {
    "pt-BR": /explicitamente/i,
    vi: /yêu cầu/i,
    ja: /明示的/i,
    id: /eksplisit/i,
    es: /explícitamente/i,
    de: /ausdrücklich/i,
    fr: /explicitement/i,
    it: /esplicitamente/i,
    ru: /явно/i,
    zh: /明确/,
  };
  const capByLang: Record<string, RegExp> = {
    "pt-BR": /três linhas curtas|até 3 linhas/i,
    vi: /ba dòng ngắn|3 dòng/i,
    ja: /3行/,
    id: /tiga baris|maks 3 baris/i,
    es: /tres líneas|3 líneas/i,
    de: /drei kurze Zeilen|max\. 3 Zeilen/i,
    fr: /trois lignes|3 lignes max/i,
    it: /tre righe|max 3 righe/i,
    ru: /три короткие строки|макс\. 3 строки/i,
    zh: /三行|3 行/,
  };
  const i18n = outputStyleMeta("less-code").i18n ?? {};
  for (const [lang, exemption] of Object.entries(exemptionByLang)) {
    for (const level of ["full", "ultra"] as const) {
      const text = i18n[lang]?.[level] ?? "";
      assert.ok(
        text.includes("ponytail:"),
        `less-code.i18n["${lang}"].${level} carries the debt-marker convention`
      );
      assert.ok(
        capByLang[lang].test(text),
        `less-code.i18n["${lang}"].${level} carries the output cap`
      );
      assert.ok(
        exemption.test(text),
        `less-code.i18n["${lang}"].${level} exempts explicitly-requested explanations`
      );
    }
  }
});

test("less-code lite stays a one-liner (no cap/marker clauses)", () => {
  const lite = outputStyleMeta("less-code").levels.lite;
  assert.ok(!lite.includes("ponytail:"), "lite keeps no debt-marker clause");
  assert.ok(!/three short lines|≤3 lines/i.test(lite), "lite keeps no output-cap clause");
});

test("every level instruction is deterministic (no Date/Math.random tokens)", () => {
  for (const id of OUTPUT_STYLE_IDS) {
    const meta = outputStyleMeta(id);
    for (const level of ["lite", "full", "ultra"] as const) {
      assert.doesNotMatch(meta.levels[level], /Date\.now|Math\.random|\$\{/);
    }
  }
});

test("outputStyleLanguages returns the sorted union of i18n keys, locales and en", () => {
  const langs = outputStyleLanguages();
  assert.ok(langs.includes("en"));
  assert.ok(langs.includes("vi"));
  assert.ok(langs.includes("zh"));
  assert.deepEqual(langs, [...langs].sort());
  assert.equal(new Set(langs).size, langs.length);
});
