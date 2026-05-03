const STOP_WORDS = new Set([
  "a","an","the","and","or","but","in","on","at","to","for","of","with",
  "by","from","as","is","was","are","were","be","been","being","have","has",
  "had","do","does","did","will","would","could","should","may","might","shall",
  "this","that","these","those","it","its","i","you","he","she","we","they",
  "not","no","so","if","then","than","when","where","who","what","which","how",
  "all","any","each","every","both","few","more","most","other","some","such",
  "into","through","during","before","after","above","below","up","down","out",
  "off","over","under","again","further","there","here","about","against","between",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

export function computeTermFrequency(tokens: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const token of tokens) {
    counts[token] = (counts[token] ?? 0) + 1;
  }
  const len = tokens.length || 1;
  const tf: Record<string, number> = {};
  for (const term in counts) {
    tf[term] = counts[term] / len;
  }
  return tf;
}

export function computeEmbedding(text: string): Record<string, number> {
  const tokens = tokenize(text);
  return computeTermFrequency(tokens);
}

export function cosineSimilarity(
  a: Record<string, number>,
  b: Record<string, number>
): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (const term in a) {
    const va = a[term] ?? 0;
    dot += va * (b[term] ?? 0);
    normA += va * va;
  }
  for (const term in b) {
    const vb = b[term] ?? 0;
    normB += vb * vb;
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
