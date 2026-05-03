import { anthropic } from "@workspace/integrations-anthropic-ai";
import { db } from "@workspace/db";
import { documentChunks, documents } from "@workspace/db";
import { sql } from "drizzle-orm";
import { cosineSimilarity, computeEmbedding } from "./embeddings.js";

export interface Citation {
  documentId: number;
  title: string | null;
  filename: string;
  excerpt: string;
}

export interface RagResult {
  answer: string;
  citations: Citation[];
}

const NO_GROUNDING_MESSAGE =
  "I couldn't find a policy that covers this — consider uploading relevant documents.";

const SIMILARITY_THRESHOLD = 0.05;
const TOP_K = 5;

export async function autoTagDocument(text: string): Promise<{
  title: string | null;
  issuingAuthority: string | null;
  policyDomain: string | null;
  documentType: string | null;
  audience: string | null;
  confidenceScore: number;
}> {
  const excerpt = text.slice(0, 4000);

  const response = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 512,
    messages: [
      {
        role: "user",
        content: `You are an expert in Australian K-12 school policy documents. Analyze the following policy document excerpt and extract metadata.

Return ONLY valid JSON with these exact fields:
{
  "title": "document title or null",
  "issuingAuthority": "e.g. Department of Education, school name, or null",
  "policyDomain": "one of: student-wellbeing, curriculum, staff-hr, administration, safety, technology, finance, community, other, or null",
  "documentType": "one of: policy, procedure, guideline, framework, strategy, or null",
  "audience": "one of: staff, students, parents, all, or null",
  "confidenceScore": 0.0-1.0 float representing how confident you are in these tags
}

Document excerpt:
${excerpt}`,
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== "text") throw new Error("Unexpected response type");

  try {
    const jsonMatch = content.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in response");
    const parsed = JSON.parse(jsonMatch[0]) as {
      title?: unknown;
      issuingAuthority?: unknown;
      policyDomain?: unknown;
      documentType?: unknown;
      audience?: unknown;
      confidenceScore?: unknown;
    };
    return {
      title: typeof parsed.title === "string" ? parsed.title : null,
      issuingAuthority:
        typeof parsed.issuingAuthority === "string" ? parsed.issuingAuthority : null,
      policyDomain: typeof parsed.policyDomain === "string" ? parsed.policyDomain : null,
      documentType: typeof parsed.documentType === "string" ? parsed.documentType : null,
      audience: typeof parsed.audience === "string" ? parsed.audience : null,
      confidenceScore:
        typeof parsed.confidenceScore === "number"
          ? Math.max(0, Math.min(1, parsed.confidenceScore))
          : 0.5,
    };
  } catch {
    return {
      title: null,
      issuingAuthority: null,
      policyDomain: null,
      documentType: null,
      audience: null,
      confidenceScore: 0.3,
    };
  }
}

export async function ragChat(
  question: string,
  history: Array<{ role: string; content: string }>
): Promise<RagResult> {
  const queryEmbedding = await computeEmbedding(question);

  // Retrieve ALL indexed chunks — single-school corpus is small enough.
  // No pre-limit applied so no relevant documents are silently excluded.
  const allChunks = await db
    .select({
      id: documentChunks.id,
      content: documentChunks.content,
      embedding: documentChunks.embedding,
      documentId: documentChunks.documentId,
      filename: documents.filename,
      title: documents.title,
    })
    .from(documentChunks)
    .innerJoin(documents, sql`${documentChunks.documentId} = ${documents.id}`);

  const scored = allChunks
    .map((chunk) => ({
      ...chunk,
      score:
        Array.isArray(chunk.embedding) && (chunk.embedding as number[]).length > 0
          ? cosineSimilarity(queryEmbedding, chunk.embedding as number[])
          : 0,
    }))
    .filter((c) => c.score >= SIMILARITY_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K);

  if (scored.length === 0) {
    return { answer: NO_GROUNDING_MESSAGE, citations: [] };
  }

  const context = scored
    .map((c, i) => {
      const label = c.title ?? c.filename;
      return `[${i + 1}] From "${label}" (doc #${c.documentId}):\n${c.content}`;
    })
    .join("\n\n---\n\n");

  const safeHistory = history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-10)
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

  const messages: Array<{ role: "user" | "assistant"; content: string }> = [
    ...safeHistory,
    {
      role: "user",
      content: `Context from policy documents (ranked by relevance):\n${context}\n\nQuestion: ${question}\n\nAnswer based ONLY on the policy documents above. Cite documents by number (e.g. [1]) when making claims. If the answer is not in the provided documents, respond with exactly: "${NO_GROUNDING_MESSAGE}"`,
    },
  ];

  const response = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 1024,
    system:
      "You are PolicyPilot, an AI assistant specializing in Australian K-12 school policies. Answer questions strictly using the provided policy document context. Always cite documents by number [N]. Never fabricate information not present in the context.",
    messages,
  });

  const responseContent = response.content[0];
  if (responseContent.type !== "text") throw new Error("Unexpected response type");

  const citationRefs = [...responseContent.text.matchAll(/\[(\d+)\]/g)].map(
    (m) => parseInt(m[1], 10) - 1
  );
  const usedIndices = [...new Set(citationRefs)].filter(
    (i) => i >= 0 && i < scored.length
  );

  const citations: Citation[] = usedIndices.map((i) => ({
    documentId: scored[i].documentId,
    title: scored[i].title ?? null,
    filename: scored[i].filename,
    excerpt: scored[i].content.slice(0, 200),
  }));

  return { answer: responseContent.text, citations };
}
