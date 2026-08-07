/**
 * AI provider abstraction — routes generation requests to either Anthropic (cloud)
 * or an Ollama-compatible local server (offline), based on app settings.
 *
 * Use `getAiProvider()` to get the active provider at request time.
 * Use `getProviderSettings()` when you need school context or the provider name
 * without constructing a full provider object.
 */

import { anthropic } from "@workspace/integrations-anthropic-ai";
import { db } from "@workspace/db";
import { appSettings } from "@workspace/db";

export interface AiMessage {
  role: "user" | "assistant";
  content: string;
}

export interface StreamOptions {
  maxTokens?: number;
  onToken: (token: string) => void;
}

export interface AiProvider {
  /** "cloud" = Anthropic, "offline" = Ollama */
  name: "cloud" | "offline";
  /** Non-streaming generation — returns the full text. */
  generateText(
    system: string,
    messages: AiMessage[],
    maxTokens?: number
  ): Promise<string>;
  /** Streaming generation — calls onToken for each chunk, returns full text. */
  streamText(
    system: string,
    messages: AiMessage[],
    options: StreamOptions
  ): Promise<string>;
}

// ─── Anthropic (cloud) ─────────────────────────────────────────────────────────

function buildAnthropicProvider(): AiProvider {
  return {
    name: "cloud",

    async generateText(system, messages, maxTokens = 8192) {
      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: maxTokens,
        system,
        messages: messages as Parameters<typeof anthropic.messages.create>[0]["messages"],
      });
      const block = response.content[0];
      return block?.type === "text" ? block.text : "";
    },

    async streamText(system, messages, { maxTokens = 8192, onToken }) {
      let full = "";
      const stream = anthropic.messages.stream({
        model: "claude-haiku-4-5",
        max_tokens: maxTokens,
        system,
        messages: messages as Parameters<typeof anthropic.messages.create>[0]["messages"],
      });
      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          onToken(event.delta.text);
          full += event.delta.text;
        }
      }
      return full;
    },
  };
}

// ─── Ollama (offline, OpenAI-compatible API) ───────────────────────────────────

function buildOllamaProvider(baseUrl: string, model: string): AiProvider {
  const base = baseUrl.replace(/\/$/, "");

  return {
    name: "offline",

    async generateText(system, messages, maxTokens = 2048) {
      const allMessages = [{ role: "system", content: system }, ...messages];
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: allMessages,
          max_tokens: maxTokens,
          stream: false,
        }),
      });
      if (!res.ok) {
        throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
      }
      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      return data.choices?.[0]?.message?.content ?? "";
    },

    async streamText(system, messages, { maxTokens = 2048, onToken }) {
      const allMessages = [{ role: "system", content: system }, ...messages];
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: allMessages,
          max_tokens: maxTokens,
          stream: true,
        }),
      });
      if (!res.ok) {
        throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
      }
      if (!res.body) throw new Error("Ollama returned no response body");

      let full = "";
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          const payload = trimmed.slice(6);
          if (payload === "[DONE]") continue;
          try {
            const chunk = JSON.parse(payload) as {
              choices?: { delta?: { content?: string } }[];
            };
            const text = chunk.choices?.[0]?.delta?.content;
            if (text) {
              onToken(text);
              full += text;
            }
          } catch {
            // ignore malformed chunks
          }
        }
      }
      return full;
    },
  };
}

// ─── Factory ───────────────────────────────────────────────────────────────────

/** Returns the active AI provider based on current app settings. */
export async function getAiProvider(): Promise<AiProvider> {
  const [settings] = await db.select().from(appSettings).limit(1);
  if (settings?.aiProvider === "offline") {
    const baseUrl = settings.ollamaBaseUrl ?? "http://localhost:11434";
    const model = settings.ollamaModel ?? "llama3.2";
    return buildOllamaProvider(baseUrl, model);
  }
  return buildAnthropicProvider();
}

/** Snapshot of provider + school profile, without constructing a provider object. */
export async function getProviderSettings() {
  const [settings] = await db.select().from(appSettings).limit(1);
  return {
    aiProvider: (settings?.aiProvider ?? "cloud") as "cloud" | "offline",
    schoolName: settings?.schoolName ?? null,
    schoolType: settings?.schoolType ?? null,
    schoolState: settings?.schoolState ?? null,
    studentCount: settings?.studentCount ?? null,
    schoolValues: settings?.schoolValues ?? null,
    principalName: settings?.principalName ?? null,
    learningFrameworks: settings?.learningFrameworks ?? null,
  };
}
