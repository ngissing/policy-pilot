import { anthropic } from "@workspace/integrations-anthropic-ai";
import { db } from "@workspace/db";
import { documentChunks, documents } from "@workspace/db";
import { like, or, sql } from "drizzle-orm";

export interface Citation {
  documentId: number;
  filename: string;
  excerpt: string;
}

export interface RagResult {
  answer: string;
  citations: Citation[];
}

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
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      title: parsed.title ?? null,
      issuingAuthority: parsed.issuingAuthority ?? null,
      policyDomain: parsed.policyDomain ?? null,
      documentType: parsed.documentType ?? null,
      audience: parsed.audience ?? null,
      confidenceScore: typeof parsed.confidenceScore === "number"
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
  const searchTerms = question
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 5);

  const conditions = searchTerms.map((term) =>
    like(documentChunks.content, `%${term}%`)
  );

  const chunks = await db
    .select({
      id: documentChunks.id,
      content: documentChunks.content,
      documentId: documentChunks.documentId,
      filename: documents.filename,
    })
    .from(documentChunks)
    .innerJoin(documents, sql`${documentChunks.documentId} = ${documents.id}`)
    .where(conditions.length > 0 ? or(...conditions) : sql`1=1`)
    .limit(8);

  const context = chunks
    .map(
      (c, i) =>
        `[${i + 1}] From "${c.filename}" (doc #${c.documentId}):\n${c.content}`
    )
    .join("\n\n---\n\n");

  const messages: Array<{ role: "user" | "assistant"; content: string }> = [
    ...history
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    {
      role: "user",
      content: `Context from policy documents:\n${context}\n\nQuestion: ${question}\n\nAnswer based on the policy documents above. Cite documents by number (e.g. [1]) when referencing specific policies. If the answer isn't in the documents, say so clearly.`,
    },
  ];

  const response = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 1024,
    system:
      "You are PolicyPilot, an AI assistant specializing in Australian K-12 school policies. You answer questions by referencing specific policy documents and citing your sources. Be concise, accurate, and always cite documents when making claims.",
    messages,
  });

  const content = response.content[0];
  if (content.type !== "text") throw new Error("Unexpected response type");

  const citationRefs = [...content.text.matchAll(/\[(\d+)\]/g)].map(
    (m) => parseInt(m[1]) - 1
  );
  const usedIndices = [...new Set(citationRefs)].filter(
    (i) => i >= 0 && i < chunks.length
  );

  const citations: Citation[] = usedIndices.map((i) => ({
    documentId: chunks[i].documentId,
    filename: chunks[i].filename,
    excerpt: chunks[i].content.slice(0, 200),
  }));

  return { answer: content.text, citations };
}
