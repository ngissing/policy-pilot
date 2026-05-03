import { pipeline, env } from "@huggingface/transformers";
import type { FeatureExtractionPipeline } from "@huggingface/transformers";

env.cacheDir = "/tmp/hf-models";
env.allowLocalModels = false;

const MODEL = "Xenova/all-MiniLM-L6-v2";

let _pipe: FeatureExtractionPipeline | null = null;
let _loading: Promise<FeatureExtractionPipeline> | null = null;

async function getEmbeddingPipeline(): Promise<FeatureExtractionPipeline> {
  if (_pipe) return _pipe;
  if (_loading) return _loading;
  _loading = pipeline("feature-extraction", MODEL, { dtype: "fp32" }).then(
    (p) => {
      _pipe = p as FeatureExtractionPipeline;
      _loading = null;
      return _pipe;
    }
  );
  return _loading;
}

export async function warmupEmbeddings(): Promise<void> {
  await getEmbeddingPipeline();
}

export async function computeEmbedding(text: string): Promise<number[]> {
  const pipe = await getEmbeddingPipeline();
  const output = await pipe(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}
