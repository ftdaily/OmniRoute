import test from "node:test";
import assert from "node:assert/strict";
import { scoreSentences } from "../../../open-sse/services/compression/engines/relevance/scorer.ts";
import {
  resolveRelevanceConfig,
  validateRelevanceConfig,
} from "../../../open-sse/services/compression/engines/relevance/configSchema.ts";

const DEFAULT_CFG = {
  enabled: false,
  overlapThreshold: 0.1,
  budgetPercent: 0.5,
  boilerplateWeight: 0.5,
};

test("relevant sentence scores higher than irrelevant sentence", () => {
  const sentences = [
    "The quick brown fox jumps over the lazy dog",
    "How do I configure the database connection?",
  ];
  const query = "configure database connection settings";
  const scores = scoreSentences(sentences, query, DEFAULT_CFG);
  assert.equal(scores.length, 2);
  assert.ok(scores[1] > scores[0], `expected scores[1]=${scores[1]} > scores[0]=${scores[0]}`);
});

test("boilerplate sentences are penalized relative to content sentences", () => {
  const sentences = [
    "Please note that this is very important information.",
    "Use db.connect() with host and port parameters.",
  ];
  const query = "connect database host port";
  const scores = scoreSentences(sentences, query, DEFAULT_CFG);
  assert.equal(scores.length, 2);
  assert.ok(
    scores[1] > scores[0],
    `content sentence (${scores[1]}) should score higher than boilerplate (${scores[0]})`
  );
});

test("ReDoS-safe: query with special regex characters does not throw", () => {
  const sentences = ["Some normal sentence here.", "Another sentence with content."];
  const maliciousQuery = "((a+)+)$ [.*+?^=!:${}()|[\\]/\\\\] test+++";
  assert.doesNotThrow(() => {
    const scores = scoreSentences(sentences, maliciousQuery, DEFAULT_CFG);
    assert.equal(scores.length, 2);
  });
});

test("empty query returns array of zeros with same length as sentences", () => {
  const sentences = ["First sentence.", "Second sentence.", "Third sentence."];
  const scores = scoreSentences(sentences, "", DEFAULT_CFG);
  assert.equal(scores.length, 3);
  assert.ok(
    scores.every((s) => s === 0),
    `all scores should be 0, got: ${scores}`
  );
});

test("empty sentences array returns empty array", () => {
  const scores = scoreSentences([], "some query", DEFAULT_CFG);
  assert.deepEqual(scores, []);
});

test("single sentence returns array of length 1", () => {
  const scores = scoreSentences(["Only one sentence."], "query text", DEFAULT_CFG);
  assert.equal(scores.length, 1);
  assert.ok(typeof scores[0] === "number");
});

test("identical query and sentence tokens produce high score", () => {
  const sentences = ["configure database connection", "unrelated random words"];
  const query = "configure database connection";
  const scores = scoreSentences(sentences, query, DEFAULT_CFG);
  assert.ok(scores[0] > 0.5, `exact match should score above 0.5, got ${scores[0]}`);
  assert.ok(scores[0] > scores[1]);
});

test("legacy config without scorer behaves as jaccard (compat)", () => {
  const sentences = [
    "The quick brown fox jumps over the lazy dog",
    "How do I configure the database connection?",
  ];
  const query = "configure database connection settings";
  const legacy = scoreSentences(sentences, query, DEFAULT_CFG);
  const explicit = scoreSentences(sentences, query, { ...DEFAULT_CFG, scorer: "jaccard" });
  assert.deepEqual(explicit, legacy);
});

test("bm25 ranks the relevant sentence first and stays in 0..1", () => {
  const sentences = [
    "The quick brown fox jumps over the lazy dog",
    "How do I configure the database connection?",
  ];
  const query = "configure database connection settings";
  const scores = scoreSentences(sentences, query, { ...DEFAULT_CFG, scorer: "bm25" });
  assert.equal(scores.length, 2);
  assert.ok(scores[1] > scores[0], `expected bm25 scores[1]=${scores[1]} > scores[0]=${scores[0]}`);
  assert.ok(
    scores.every((s) => s >= 0 && s <= 1),
    `bm25 scores must be normalized, got ${scores}`
  );
});

test("bm25 empty query returns zeros", () => {
  const scores = scoreSentences(["First.", "Second."], "", { ...DEFAULT_CFG, scorer: "bm25" });
  assert.deepEqual(scores, [0, 0]);
});

test("resolveRelevanceConfig defaults scorer to jaccard with standard k1/b", () => {
  const cfg = resolveRelevanceConfig({});
  assert.equal(cfg.scorer, "jaccard");
  assert.equal(cfg.bm25K1, 1.2);
  assert.equal(cfg.bm25B, 0.75);
});

test("validateRelevanceConfig accepts bm25 and rejects bad scorer/bounds", () => {
  assert.ok(validateRelevanceConfig({ scorer: "bm25", bm25K1: 1.2, bm25B: 0.75 }).valid);
  assert.ok(!validateRelevanceConfig({ scorer: "tfidf" }).valid);
  assert.ok(!validateRelevanceConfig({ bm25K1: -1 }).valid);
  assert.ok(!validateRelevanceConfig({ bm25B: 2 }).valid);
});
