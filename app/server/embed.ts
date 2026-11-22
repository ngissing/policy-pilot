import path from "node:path";
import { pipeline, env } from "@huggingface/transformers";
import type { FeatureExtractionPipeline } from "@huggingface/transformers";
import { DATA_DIR, all } from "./db.ts";

env.cacheDir = path.join(DATA_DIR, "models");
const MODEL = "Xenova/all-MiniLM-L6-v2";
export const DIMS = 384;

let loading: Promise<FeatureExtractionPipeline> | null = null;
function model() {
  loading ??= pipeline("feature-extraction", MODEL, { dtype: "fp32" }) as Promise<FeatureExtractionPipeline>;
  return loading;
}

export async function embed(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const pipe = await model();
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += 16) {
    const batch = texts.slice(i, i + 16).map((t) => t.slice(0, 2000));
    const res = await pipe(batch, { pooling: "mean", normalize: true });
    const data = res.data as Float32Array;
    for (let j = 0; j < batch.length; j++) out.push(data.slice(j * DIMS, (j + 1) * DIMS));
  }
  return out;
}

export const toBlob = (v: Float32Array) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
const fromBlob = (b: Uint8Array) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

// ─── In-memory vector index ──────────────────────────────────────────────────
// A few hundred PAL topics plus each school's documents is tens of thousands of
// chunks at most, so an exact scan is fast and needs no extra infrastructure.

interface Entry { id: number; docId: number; schoolId: number | null; vec: Float32Array }
const index = new Map<number, Entry>();

export function loadIndex() {
  const rows = all<{ id: number; document_id: number; school_id: number | null; embedding: Uint8Array }>(
    "SELECT id, document_id, school_id, embedding FROM chunks WHERE embedding IS NOT NULL"
  );
  index.clear();
  for (const r of rows) index.set(r.id, { id: r.id, docId: r.document_id, schoolId: r.school_id, vec: fromBlob(r.embedding) });
  return index.size;
}

export function indexAdd(id: number, docId: number, schoolId: number | null, vec: Float32Array) {
  index.set(id, { id, docId, schoolId, vec });
}

export function indexRemoveDoc(docId: number) {
  for (const [id, e] of index) if (e.docId === docId) index.delete(id);
}

export function vectorSearch(
  query: Float32Array,
  filter: (e: { docId: number; schoolId: number | null }) => boolean,
  k: number
): Array<{ id: number; docId: number; score: number }> {
  const top: Array<{ id: number; docId: number; score: number }> = [];
  for (const e of index.values()) {
    if (!filter(e)) continue;
    let s = 0;
    const v = e.vec;
    for (let i = 0; i < DIMS; i++) s += v[i] * query[i];
    if (top.length < k) {
      top.push({ id: e.id, docId: e.docId, score: s });
      if (top.length === k) top.sort((a, b) => b.score - a.score);
    } else if (s > top[k - 1].score) {
      top[k - 1] = { id: e.id, docId: e.docId, score: s };
      top.sort((a, b) => b.score - a.score);
    }
  }
  return top.sort((a, b) => b.score - a.score);
}
