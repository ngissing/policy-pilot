/**
 * Policy Drafter routes
 *
 * POST /api/draft/generate  — SSE stream of a policy draft grounded in the library
 * POST /api/draft/save      — Save a completed draft as a pending document
 */

import { Router } from "express";
import { pool, db } from "@workspace/db";
import { documents, documentChunks, appSettings } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth.js";
import { computeEmbedding } from "../lib/embeddings.js";
import { getAiProvider, getProviderSettings } from "../lib/aiProvider.js";
import { chunkText } from "../lib/fileParser.js";
import { logger } from "../lib/logger.js";

const router = Router();
router.use(requireAuth);

const SIMILARITY_THRESHOLD = 0.25;
const MAX_CONTEXT_CHUNKS = 10;

// ─── Helpers ───────────────────────────────────────────────────────────────────

interface ContextChunk {
  documentId: number;
  title: string | null;
  filename: string;
  content: string;
  similarity: number;
}

async function fetchDraftContext(topic: string): Promise<ContextChunk[]> {
  const embedding = await computeEmbedding(topic);
  const embeddingLiteral = `[${embedding.join(",")}]`;

  const { rows } = await pool.query<{
    document_id: number;
    title: string | null;
    filename: string;
    content: string;
    similarity: number;
  }>(
    `SELECT
       dc.document_id,
       d.title,
       d.filename,
       dc.content,
       1 - (dc.embedding <=> $1::vector) AS similarity
     FROM document_chunks dc
     INNER JOIN documents d ON dc.document_id = d.id
     WHERE dc.embedding IS NOT NULL
       AND 1 - (dc.embedding <=> $1::vector) >= $2
       AND d.status != 'rejected'
     ORDER BY dc.embedding <=> $1::vector
     LIMIT $3`,
    [embeddingLiteral, SIMILARITY_THRESHOLD, MAX_CONTEXT_CHUNKS]
  );

  // Keep best chunk per document
  const seen = new Map<number, ContextChunk>();
  for (const row of rows) {
    const existing = seen.get(row.document_id);
    if (!existing || row.similarity > existing.similarity) {
      seen.set(row.document_id, {
        documentId: row.document_id,
        title: row.title,
        filename: row.filename,
        content: row.content,
        similarity: row.similarity,
      });
    }
  }
  return [...seen.values()];
}

function buildSchoolContextBlock(
  settings: Awaited<ReturnType<typeof getProviderSettings>>
): string {
  const lines: string[] = [];
  if (settings.schoolName)       lines.push(`School name: ${settings.schoolName}`);
  if (settings.schoolType)       lines.push(`School type: ${settings.schoolType}`);
  if (settings.schoolState)      lines.push(`State/territory: ${settings.schoolState}`);
  if (settings.studentCount)     lines.push(`Student enrolment: ~${settings.studentCount}`);
  if (settings.principalName)    lines.push(`Principal: ${settings.principalName}`);
  if (settings.schoolValues)     lines.push(`School values/motto: ${settings.schoolValues}`);
  if (settings.learningFrameworks) lines.push(`Learning frameworks: ${settings.learningFrameworks}`);
  return lines.join("\n");
}

// ─── POST /generate ────────────────────────────────────────────────────────────

router.post("/generate", async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const topic = typeof body.topic === "string" ? body.topic.trim() : "";
  if (!topic) {
    res.status(400).json({ error: "topic is required" });
    return;
  }
  const additionalContext =
    typeof body.additionalContext === "string" ? body.additionalContext.trim() : "";
  const useSchoolContext = body.useSchoolContext === true;

  try {
    const providerSettings = await getProviderSettings();

    // School-specific drafting is only permitted when using the offline model,
    // because the school profile may contain sensitive / personally identifiable data
    // that should not be sent to a cloud API.
    if (useSchoolContext && providerSettings.aiProvider !== "offline") {
      res.status(403).json({
        error:
          "School-specific drafting requires the offline AI provider. " +
          "Switch to Offline in Settings → AI Provider.",
        code: "REQUIRES_OFFLINE",
      });
      return;
    }

    // Retrieve relevant context from the policy library
    const contextChunks = await fetchDraftContext(topic);

    const ragBlock =
      contextChunks.length > 0
        ? contextChunks
            .map((c) => `[${c.title ?? c.filename}]\n${c.content}`)
            .join("\n\n---\n\n")
        : "No directly relevant policies found in the library — draft from best practice.";

    const schoolBlock = useSchoolContext
      ? buildSchoolContextBlock(providerSettings)
      : "";

    const systemPrompt = [
      "You are an expert Australian K-12 school policy writer.",
      "Draft a professional, complete policy document in Markdown format.",
      schoolBlock
        ? `\n## SCHOOL CONTEXT\n${schoolBlock}`
        : "",
      `\n## RELEVANT EXISTING POLICIES (for reference and alignment)\n${ragBlock}`,
      "\n## INSTRUCTIONS",
      "- Write the full policy — no placeholder text.",
      "- Use these sections: Purpose, Scope, Policy Statement, Procedures, Responsibilities, Related Policies, Review Date.",
      "- Align with Australian education legislation and the relevant state/territory curriculum authority.",
      "- Use clear, direct language appropriate for school staff.",
      "- Format dates as DD Month YYYY. Set Review Date to one year from today.",
    ]
      .filter(Boolean)
      .join("\n");

    const userMessage = [
      `Draft a school policy on the following topic: ${topic}`,
      additionalContext ? `\nAdditional context:\n${additionalContext}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    // SSE setup
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Metadata event (topic, provider, sources found)
    send("meta", {
      topic,
      useSchoolContext,
      provider: providerSettings.aiProvider,
      sources: contextChunks.map((c) => c.title ?? c.filename),
    });

    const provider = await getAiProvider();
    let fullText = "";

    await provider.streamText(systemPrompt, [{ role: "user", content: userMessage }], {
      maxTokens: 4096,
      onToken: (token) => {
        send("token", { text: token });
        fullText += token;
      },
    });

    send("done", { text: fullText });
    res.end();
  } catch (err) {
    logger.error(err, "Error generating policy draft");
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to generate draft" });
    } else {
      try {
        res.write(
          `event: error\ndata: ${JSON.stringify({ error: "Generation failed" })}\n\n`
        );
      } catch {}
      res.end();
    }
  }
});

// ─── POST /save ────────────────────────────────────────────────────────────────

router.post("/save", async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const content = typeof body.content === "string" ? body.content.trim() : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!content || !title) {
    res.status(400).json({ error: "content and title are required" });
    return;
  }

  try {
    const filename = `${title.slice(0, 80).replace(/[^a-zA-Z0-9 _-]/g, "")}.md`;

    const [doc] = await db
      .insert(documents)
      .values({
        filename,
        fileType: "md",
        rawText: content,
        title,
        status: "pending",
        documentType: "policy",
      })
      .returning();

    // Chunk and embed asynchronously — do not block the response
    setImmediate(async () => {
      try {
        const chunks = chunkText(content);
        if (chunks.length > 0) {
          const { computeEmbedding } = await import("../lib/embeddings.js");
          const embeddings = await Promise.all(chunks.map((c) => computeEmbedding(c)));
          await db.insert(documentChunks).values(
            chunks.map((c, i) => ({
              documentId: doc.id,
              content: c,
              embedding: embeddings[i],
              chunkIndex: i,
            }))
          );
        }
      } catch (err) {
        logger.warn({ docId: doc.id, err }, "Failed to chunk/embed saved draft");
      }
    });

    res.status(201).json({ id: doc.id, filename, status: doc.status });
  } catch (err) {
    logger.error(err, "Error saving draft document");
    res.status(500).json({ error: "Failed to save draft" });
  }
});

export default router;
