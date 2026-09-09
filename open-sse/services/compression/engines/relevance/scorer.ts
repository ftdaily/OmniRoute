import type { RelevanceConfig } from "../../types.ts";
import { DEFAULT_RELEVANCE_CONFIG } from "../../types.ts";

const BOILERPLATE_TOKENS = new Set([
  "please",
  "note",
  "important",
  "indeed",
  "certainly",
  "basically",
  "essentially",
  "obviously",
  "clearly",
  "simply",
  "just",
  "really",
  "actually",
  "honestly",
  "conclusion",
  "summary",
  "hope",
  "understand",
  "thing",
  "things",
  "something",
]);

function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  let start = -1;
  for (let i = 0; i <= lower.length; i++) {
    const ch = i < lower.length ? lower.charCodeAt(i) : -1;
    const isAlnum = ch !== -1 && ((ch >= 97 && ch <= 122) || (ch >= 48 && ch <= 57));
    if (isAlnum) {
      if (start === -1) start = i;
    } else {
      if (start !== -1) {
        tokens.push(lower.slice(start, i));
        start = -1;
      }
    }
  }
  return tokens;
}

function jaccard(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function boilerplateScore(tokens: string[]): number {
  if (tokens.length === 0) return 0;
  let count = 0;
  for (const t of tokens) {
    if (BOILERPLATE_TOKENS.has(t)) count++;
  }
  return count / tokens.length;
}

export function scoreSentences(sentences: string[], query: string, cfg: RelevanceConfig): number[] {
  if (sentences.length === 0) return [];
  if (!query || query.trim().length === 0) return sentences.map(() => 0);

  // scorer undefined (legacy persisted rows) === "jaccard": byte-identical old path.
  if (cfg.scorer === "bm25") return scoreSentencesBm25(sentences, query, cfg);

  const queryTokens = new Set(tokenize(query));

  return sentences.map((sentence) => {
    const sentTokens = tokenize(sentence);
    if (sentTokens.length === 0) return 0;
    const sentSet = new Set(sentTokens);
    const overlap = jaccard(sentSet, queryTokens);
    const boilerplate = boilerplateScore(sentTokens) * cfg.boilerplateWeight;
    return Math.max(0, overlap - boilerplate);
  });
}

/**
 * Dep-free BM25 scorer over the sentence set (corpus = sentences).
 * Raw BM25 scores are unbounded, so each sentence score is divided by the
 * corpus max (guarded: max<=0 → all zeros) to land in [0,1] like Jaccard —
 * the same overlapThreshold then acts as a relative cutoff in index.ts.
 * The shared boilerplate penalty applies after normalization, identically
 * to the Jaccard path.
 */
export function scoreSentencesBm25(
  sentences: string[],
  query: string,
  cfg: RelevanceConfig
): number[] {
  const k1 =
    typeof cfg.bm25K1 === "number" && Number.isFinite(cfg.bm25K1) && cfg.bm25K1 > 0
      ? cfg.bm25K1
      : DEFAULT_RELEVANCE_CONFIG.bm25K1!;
  const b =
    typeof cfg.bm25B === "number" && Number.isFinite(cfg.bm25B) && cfg.bm25B >= 0 && cfg.bm25B <= 1
      ? cfg.bm25B
      : DEFAULT_RELEVANCE_CONFIG.bm25B!;

  const docs = sentences.map(tokenize);
  const queryTerms = tokenize(query);
  const n = docs.length;
  if (n === 0 || queryTerms.length === 0) return sentences.map(() => 0);

  // Document frequency over unique terms per doc.
  const df = new Map<string, number>();
  const docLens = docs.map((tokens) => {
    for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
    return tokens.length;
  });
  const avgLen = docLens.reduce((a, c) => a + c, 0) / n || 1;

  // Term frequency per doc (only query terms matter, but count all once).
  const raw = docs.map((tokens, di) => {
    if (tokens.length === 0) return 0;
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const term of new Set(queryTerms)) {
      const f = tf.get(term) ?? 0;
      if (f === 0) continue;
      const docFreq = df.get(term) ?? 0;
      const idf = Math.log(1 + (n - docFreq + 0.5) / (docFreq + 0.5));
      const denom = f + k1 * (1 - b + (b * docLens[di]) / avgLen);
      score += idf * ((f * (k1 + 1)) / denom);
    }
    return score;
  });

  const max = Math.max(...raw);
  if (!(max > 0)) return sentences.map(() => 0);

  return sentences.map((sentence, i) => {
    const boilerplate = boilerplateScore(docs[i]) * cfg.boilerplateWeight;
    return Math.max(0, raw[i] / max - boilerplate);
  });
}
