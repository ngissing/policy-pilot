import type { Response } from "express";
import { all, one, run } from "./db.ts";
import { retrieve } from "./search.ts";
import type { Passage, Scope } from "./search.ts";
import { claude, answerModel, modelOptions, friendlyAiError, AiNotConfigured } from "./ai.ts";
import type { ModelId } from "./ai.ts";
import type { User } from "./auth.ts";

const MARKER = "FOLLOW-UPS:";

function systemPrompt(schoolId: number): string {
  const s = one<any>("SELECT name, school_type, suburb, region, about FROM schools WHERE id = ?", schoolId);
  const profile = [
    `School: ${s?.name ?? "a Victorian government school"}`,
    s?.school_type && `Type: ${s.school_type}`,
    s?.suburb && `Location: ${s.suburb}${s.region ? `, ${s.region}` : ""}`,
    s?.about && `About the school: ${s.about}`,
  ].filter(Boolean).join("\n");

  return `You are PolicyPilot, a policy assistant for leaders and staff in a Victorian government school. You answer questions using two kinds of numbered sources:
- Department sources: topics from the Victorian Department of Education's Policy and Advisory Library (PAL). These are binding on government schools.
- School sources: the school's own policies, procedures and plans.

How to answer:
- Lead with the direct answer in one or two sentences, then give the detail as short steps or bullets when that helps someone act on it.
- Base every statement on the sources. Put the source number in square brackets straight after each claim, like [2]. Never cite a number that is not in the sources.
- Make clear what is mandatory ("must", "required") versus guidance or recommended practice, using the source's own wording for obligations, timeframes and roles.
- If the school's document and PAL differ, or the school's document looks out of date against PAL, say so plainly and cite both. PAL takes precedence for government schools.
- If the sources don't answer the question, say that directly, say what they do cover, and suggest who to ask (for example a PAL contact listed in the source, the principal, or the regional office). Do not fill gaps from general knowledge.
- When you are interpreting rather than quoting, say so ("In practice this likely means…").
- Write in Australian English, in a calm, professional tone. No preamble, no closing pleasantries.

After the answer, write a line containing only "${MARKER}" followed by three short follow-up questions the person might ask next, each on its own line starting with "- ".

${profile}`;
}

export type AnswerLength = "short" | "normal" | "extended";

/** How many passages to read and how long to write, per answer-length setting. */
export const LENGTHS: Record<AnswerLength, { k: number; minK: number; instruction: string }> = {
  short: {
    k: 5,
    minK: 2,
    instruction: "Keep this short: the direct answer in two or three sentences, then at most four bullets covering only what someone must do. Leave out background.",
  },
  normal: {
    k: 7,
    minK: 3,
    instruction: "Give a focused answer someone can act on: the direct answer, then the key requirements or steps. Usually under 250 words.",
  },
  extended: {
    k: 10,
    minK: 5,
    instruction: "Give a thorough answer: cover each relevant requirement, exceptions, timeframes, who is responsible, and how related policies fit together. Use short headings when they help. Let the question set the length; don't pad.",
  },
};

export function userLength(userId: number): AnswerLength {
  const v = one<{ answer_length: string }>("SELECT answer_length FROM users WHERE id = ?", userId)?.answer_length;
  return v === "short" || v === "extended" ? v : "normal";
}

/** The request body for one answer — shared by chat and the model comparison in Settings. */
export function buildAnswerRequest(
  model: ModelId,
  schoolId: number,
  question: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  passages: Passage[],
  length: AnswerLength
) {
  return {
    ...modelOptions(model),
    max_tokens: 16000,
    output_config: { effort: "medium" as const },
    cache_control: { type: "ephemeral" as const },
    system: systemPrompt(schoolId),
    messages: [
      ...history.map((m) => ({ role: m.role, content: m.content })),
      {
        role: "user" as const,
        // The length instruction goes last so the system prompt stays identical (and cacheable) for everyone.
        content: `<sources>\n${formatSources(passages)}\n</sources>\n\nQuestion: ${question}\n\n${LENGTHS[length].instruction}`,
      },
    ],
  };
}

export function splitFollowups(full: string): { body: string; followups: string[] } {
  const at = full.indexOf(MARKER);
  return {
    body: (at >= 0 ? full.slice(0, at) : full).trimEnd(),
    followups:
      at >= 0
        ? full.slice(at + MARKER.length).split("\n").map((l) => l.replace(/^\s*[-•*]\s*/, "").trim()).filter(Boolean).slice(0, 3)
        : [],
  };
}

function formatSources(passages: Passage[]): string {
  return passages
    .map((p, i) => {
      const who = p.isSchool ? "School document" : "Department (PAL)";
      const when = p.reviewed ? ` — last updated ${p.reviewed}` : "";
      return `<source n="${i + 1}">\n${who}: ${p.title}${p.section ? ` › ${p.section}` : ""}${when}\n\n${p.text}\n</source>`;
    })
    .join("\n\n");
}

export interface SourceOut {
  n: number;
  documentId: number;
  title: string;
  section: string;
  excerpt: string;
  isSchool: boolean;
  url: string | null;
  reviewed: string | null;
}

export function toSourceOut(passages: Passage[]): SourceOut[] {
  return passages.map((p, i) => ({
    n: i + 1,
    documentId: p.documentId,
    title: p.title,
    section: p.section,
    excerpt: p.text.slice(0, 1400),
    isSchool: p.isSchool,
    url: p.url,
    reviewed: p.reviewed,
  }));
}

function sse(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Answer one question in a conversation, streaming Server-Sent Events to the client. */
export async function answer(res: Response, user: User, conversationId: number, question: string) {
  const convo = one<any>("SELECT * FROM conversations WHERE id = ? AND user_id = ?", conversationId, user.id);
  if (!convo) {
    res.status(404).json({ error: "Conversation not found." });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const history = all<{ role: "user" | "assistant"; content: string }>(
    "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 8",
    conversationId
  ).reverse();
  // A retry of an unanswered question shouldn't store it twice.
  const lastStored = one<{ role: string; content: string }>("SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1", conversationId);
  if (lastStored?.role === "user" && lastStored.content === question) history.pop();
  else run("INSERT INTO messages(conversation_id, role, content) VALUES (?, 'user', ?)", conversationId, question);
  // The API needs the conversation to open with a user turn.
  while (history.length && history[0].role !== "user") history.shift();
  run("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?", conversationId);

  try {
    // Follow-ups like "what about excursions?" need the previous question to retrieve well.
    const lastQuestion = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
    const searchText = question.length < 80 && lastQuestion ? `${question}\n${lastQuestion}` : question;

    const length = userLength(user.id);
    sse(res, "status", { message: "Searching policies…" });
    const passages = await retrieve(searchText, {
      schoolId: user.school_id,
      scope: convo.scope as Scope,
      documentId: convo.document_id,
      k: LENGTHS[length].k,
      minK: LENGTHS[length].minK,
    });
    const sources = toSourceOut(passages);
    sse(res, "sources", sources);

    if (!passages.length) {
      const text =
        convo.scope === "school"
          ? "I couldn't find anything about this in your school's documents. Try asking across all policies, or add the relevant document in Add documents."
          : "I couldn't find anything about this in the policy library. Try rephrasing with the words a policy would use, or check that the PAL library has been loaded in Settings.";
      sse(res, "text", { delta: text });
      const id = Number(run("INSERT INTO messages(conversation_id, role, content, sources) VALUES (?, 'assistant', ?, '[]')", conversationId, text).lastInsertRowid);
      sse(res, "done", { messageId: id, followups: [] });
      return res.end();
    }

    const client = claude();
    if (!client) throw new AiNotConfigured();
    sse(res, "status", { message: `Reading ${new Set(passages.map((p) => p.documentId)).size} documents…` });

    const stream = client.beta.messages.stream(buildAnswerRequest(answerModel(), user.school_id, question, history, passages, length));

    let full = "";
    let sent = 0;
    let markerAt = -1;
    stream.on("text", (delta) => {
      full += delta;
      if (markerAt < 0) markerAt = full.indexOf(MARKER);
      // Hold back a few characters in case the follow-up marker is arriving in pieces.
      const until = markerAt >= 0 ? markerAt : Math.max(sent, full.length - MARKER.length);
      if (until > sent) {
        sse(res, "text", { delta: full.slice(sent, until) });
        sent = until;
      }
    });
    req_abort(res, () => stream.abort());
    const final = await stream.finalMessage();

    if (final.stop_reason === "refusal" && !full.trim()) {
      full = "I can't help with that request. Try rephrasing it as a question about school policy.";
    }
    const { body, followups } = splitFollowups(full);
    if (body.length > sent) sse(res, "text", { delta: body.slice(sent) });

    const id = Number(
      run(
        "INSERT INTO messages(conversation_id, role, content, sources, followups) VALUES (?, 'assistant', ?, ?, ?)",
        conversationId, body, JSON.stringify(sources), JSON.stringify(followups)
      ).lastInsertRowid
    );
    sse(res, "done", { messageId: id, followups });
  } catch (err) {
    sse(res, "error", { message: friendlyAiError(err) });
  }
  res.end();
}

function req_abort(res: Response, onClose: () => void) {
  res.on("close", () => {
    if (!res.writableFinished) onClose();
  });
}
