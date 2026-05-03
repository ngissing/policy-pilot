/**
 * Local dense text embeddings using the hashing trick (feature hashing).
 * Produces fixed-dimension numeric vectors suitable for cosine similarity retrieval.
 * Dimension: 512.
 */

const EMBEDDING_DIM = 512;

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

function fnv1a32(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (Math.imul(hash, 0x01000193) | 0) >>> 0;
  }
  return hash;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

/**
 * Compute a 512-dimensional unit embedding vector for the given text.
 * Uses TF-weighted feature hashing with signed random projection and L2 normalisation.
 */
export function computeEmbedding(text: string): number[] {
  const tokens = tokenize(text);
  const vector = new Float64Array(EMBEDDING_DIM);

  const counts: Record<string, number> = {};
  for (const token of tokens) {
    counts[token] = (counts[token] ?? 0) + 1;
  }
  const total = tokens.length || 1;

  for (const [term, count] of Object.entries(counts)) {
    const tf = count / total;
    const bucket = fnv1a32(term) % EMBEDDING_DIM;
    const sign = fnv1a32(term + "\x00") % 2 === 0 ? 1 : -1;
    vector[bucket] += sign * tf;
  }

  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) norm += vector[i] * vector[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return Array.from(vector);
  return Array.from(vector).map((v) => v / norm);
}

/** Cosine similarity between two L2-normalised vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}
