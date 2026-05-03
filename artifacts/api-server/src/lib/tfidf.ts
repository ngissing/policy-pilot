/**
 * Dense text embeddings using the hashing trick (feature hashing / random projection).
 *
 * Produces a fixed-dimension numeric vector for any text, suitable for cosine similarity
 * retrieval.  This approach is used in production systems (Vowpal Wabbit, scikit-learn
 * HashingVectorizer) and does NOT require an external API.
 *
 * NOTE: The Replit AI integrations proxy explicitly does NOT support the OpenAI or
 * Anthropic embeddings APIs (confirmed in `.local/skills/ai-integrations-openai/SKILL.md`
 * and `.local/skills/ai-integrations-anthropic/SKILL.md`).  Feature-hashed TF-IDF vectors
 * are therefore the correct approach for this environment.
 *
 * Embedding dimension: 512 (balances capacity vs storage).
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

/** Simple deterministic 32-bit integer hash (FNV-1a variant). */
function fnv1a32(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (Math.imul(hash, 0x01000193) | 0) >>> 0;
  }
  return hash;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

/**
 * Compute a dense embedding vector (float32-compatible number[]) for the given text.
 *
 * Algorithm:
 *  1. Tokenize and count term frequencies.
 *  2. For each token, map to a bucket in [0, EMBEDDING_DIM) using FNV-1a hash.
 *  3. Determine sign from a second hash (prevents cancellation).
 *  4. Accumulate TF-weighted contribution per bucket.
 *  5. L2-normalize to unit vector.
 *
 * The result is a proper numeric vector suitable for cosine similarity.
 */
export function computeEmbedding(text: string): number[] {
  const tokens = tokenize(text);
  const vector = new Float64Array(EMBEDDING_DIM);

  // Build term-frequency counts
  const counts: Record<string, number> = {};
  for (const token of tokens) {
    counts[token] = (counts[token] ?? 0) + 1;
  }
  const totalTokens = tokens.length || 1;

  // Accumulate into hashed buckets
  for (const [term, count] of Object.entries(counts)) {
    const tf = count / totalTokens;
    const h1 = fnv1a32(term);
    const bucket = h1 % EMBEDDING_DIM;
    // Sign from a second hash over a different seed string
    const h2 = fnv1a32(term + "\x00sign");
    const sign = h2 % 2 === 0 ? 1 : -1;
    vector[bucket] += sign * tf;
  }

  // L2 normalise to unit vector
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) norm += vector[i] * vector[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return Array.from(vector);
  return Array.from(vector).map((v) => v / norm);
}

/** Cosine similarity between two dense unit vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // already unit vectors after normalisation
}
