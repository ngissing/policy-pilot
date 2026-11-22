import Anthropic from "@anthropic-ai/sdk";
import { getSetting } from "./db.ts";

/** Models the platform owner can choose between, with list prices in US$ per million tokens. */
export const MODELS = {
  "claude-opus-5-5": { label: "Claude Opus 5.5", input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { label: "Claude Sonnet 5.5", input: 2, output: 10, cacheRead: 0.1 },
  "claude-haiku-5-5": { label: "Claude Haiku 5.5", input: 0.1, output: 0.5, cacheRead: 0.01 },
} as const;
export type ModelId = keyof typeof MODELS;
const DEFAULT_MODEL: ModelId = "claude-opus-5-5";

const isModel = (m: unknown): m is ModelId => typeof m === "string" && m in MODELS;

/** Model for answering questions. */
export function answerModel(): ModelId {
  const m = getSetting("model_answers") ?? process.env.POLICYPILOT_MODEL;
  return isModel(m) ? m : DEFAULT_MODEL;
}

/** Model for reading documents: tags, categories and plain-English briefings. */
export function processingModel(): ModelId {
  const m = getSetting("model_processing") ?? process.env.POLICYPILOT_PROCESSING_MODEL ?? process.env.POLICYPILOT_MODEL;
  return isModel(m) ? m : DEFAULT_MODEL;
}

export { isModel };

/**
 * Per-model request options. Opus and Sonnet opt in to server-side fallback so a declined request is
 * retried on a fallback model; Haiku has no server-side fallback, so it is sent without it.
 */
export function modelOptions(model: ModelId) {
  return model === "claude-haiku-5-5"
    ? { model }
    : { model, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const };
}

export function estimateCost(model: ModelId, usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }) {
  const p = MODELS[model];
  return (
    (usage.input_tokens * p.input +
      (usage.cache_creation_input_tokens ?? 0) * p.input * 1.25 +
      (usage.cache_read_input_tokens ?? 0) * p.cacheRead +
      usage.output_tokens * p.output) /
    1_000_000
  );
}

let cached: { key: string; client: Anthropic } | null = null;

export function apiKey(): string | null {
  return getSetting("anthropic_api_key") || process.env.ANTHROPIC_API_KEY || null;
}

export function aiReady(): boolean {
  return !!apiKey();
}

/** Returns a client, or null when no key has been configured yet. */
export function claude(): Anthropic | null {
  const key = apiKey();
  if (!key) return null;
  if (cached?.key !== key) {
    cached = {
      key,
      // Pin the base URL so an unrelated ANTHROPIC_BASE_URL in the shell can't redirect traffic.
      client: new Anthropic({
        apiKey: key,
        baseURL: process.env.POLICYPILOT_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
      }),
    };
  }
  return cached.client;
}

export class AiNotConfigured extends Error {
  constructor() {
    super("AI isn't set up yet. The platform owner can add an Anthropic API key in Settings.");
  }
}

/** One structured-output call on the document-processing model. Returns parsed JSON matching `schema`. */
export async function structured<T>(opts: {
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  effort?: "low" | "medium" | "high";
  maxTokens?: number;
}): Promise<T> {
  const client = claude();
  if (!client) throw new AiNotConfigured();
  const stream = client.beta.messages.stream({
    ...modelOptions(processingModel()),
    max_tokens: opts.maxTokens ?? 16000,
    system: opts.system,
    output_config: { effort: opts.effort ?? "low", format: { type: "json_schema", schema: opts.schema } },
    messages: [{ role: "user", content: opts.prompt }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") throw new Error("The AI declined to process this document.");
  const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  return JSON.parse(text) as T;
}

export function friendlyAiError(err: unknown): string {
  if (err instanceof AiNotConfigured) return err.message;
  if (err instanceof Anthropic.AuthenticationError) return "The Anthropic API key was rejected. Check it in Settings.";
  if (err instanceof Anthropic.RateLimitError) return "The AI service is busy right now. Try again in a minute.";
  if (err instanceof Anthropic.APIError) return `The AI service returned an error (${err.status ?? "network"}).`;
  return err instanceof Error ? err.message : String(err);
}
