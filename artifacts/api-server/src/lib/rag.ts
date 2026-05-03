import { anthropic } from "@workspace/integrations-anthropic-ai";
import { db } from "@workspace/db";
import { documentChunks, documents } from "@workspace/db";
import { sql } from "drizzle-orm";
import { cosineSimilarity, computeEmbedding } from "./embeddings.js";

const DEPT_KEYWORDS = [
  "department", "ministry", "government", "board of education",
  "authority", "directorate", "commission", "nsw education",
  "vic education", "qld education", "sa education", "wa education",
  "tas education", "nt education", "act education",
];

function isDepartmentPolicy(authority: string | null | undefined): boolean {
  if (!authority) return false;
  const lower = authority.toLowerCase();
  return DEPT_KEYWORDS.some((kw) => lower.includes(kw));
}

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

export interface RagOptions {
  responseLength?: "brief" | "concise" | "detailed";
  responseTone?: "formal" | "friendly";
  maxSources?: number;
  fallbackMessage?: string;
  scopeFilter?: "all" | "school" | "department";
  domainFilter?: string;
}

const DEFAULT_FALLBACK =
  "I couldn't find a policy that covers this — consider uploading relevant documents.";

const SIMILARITY_THRESHOLD = 0.05;

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
  history: Array<{ role: string; content: string }>,
  options: RagOptions = {}
): Promise<RagResult> {
  const {
    responseLength = "detailed",
    responseTone = "formal",
    maxSources = 5,
    fallbackMessage = DEFAULT_FALLBACK,
    scopeFilter = "all",
    domainFilter = "all",
  } = options;

  const queryEmbedding = await computeEmbedding(question);

  const allChunks = await db
    .select({
      id: documentChunks.id,
      content: documentChunks.content,
      embedding: documentChunks.embedding,
      documentId: documentChunks.documentId,
      filename: documents.filename,
      title: documents.title,
      issuingAuthority: documents.issuingAuthority,
      policyDomain: documents.policyDomain,
    })
    .from(documentChunks)
    .innerJoin(documents, sql`${documentChunks.documentId} = ${documents.id}`);

  // Apply scope + domain filters before scoring
  const filteredChunks = allChunks.filter((c) => {
    if (scopeFilter === "department" && !isDepartmentPolicy(c.issuingAuthority)) return false;
    if (scopeFilter === "school" && isDepartmentPolicy(c.issuingAuthority)) return false;
    if (domainFilter && domainFilter !== "all" && c.policyDomain !== domainFilter) return false;
    return true;
  });

  const scored = filteredChunks
    .map((chunk) => ({
      ...chunk,
      score:
        Array.isArray(chunk.embedding) && (chunk.embedding as number[]).length > 0
          ? cosineSimilarity(queryEmbedding, chunk.embedding as number[])
          : 0,
    }))
    .filter((c) => c.score >= SIMILARITY_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSources);

  if (scored.length === 0) {
    return { answer: fallbackMessage, citations: [] };
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
      content: `Context from policy documents (ranked by relevance):\n${context}\n\nQuestion: ${question}\n\nAnswer based ONLY on the policy documents above. Cite documents by number (e.g. [1]) when making claims. If the answer is not in the provided documents, respond with exactly: "${fallbackMessage}"`,
    },
  ];

  const toneInstruction =
    responseTone === "friendly"
      ? "Use a warm, approachable tone that is easy for parents and students to understand. Avoid jargon."
      : "Use a professional, precise tone appropriate for school staff and governance contexts.";

  const lengthInstruction =
    responseLength === "brief"
      ? "Be extremely brief. Respond in 1-2 sentences only. No bullet points, no preamble — just the essential answer."
      : responseLength === "concise"
      ? "Be concise. Use bullet points where possible. Keep answers direct — no more than 3-4 sentences or a short list."
      : "Provide thorough explanations with relevant context. Include background detail where it helps the reader understand the policy.";

  const systemPrompt = `You are PolicyPilot, an AI assistant specialising in Australian K-12 school policies. Answer questions strictly using the provided policy document context. Always cite documents by number [N]. Never fabricate information not present in the context. ${toneInstruction} ${lengthInstruction}`;

  const maxTokens = responseLength === "brief" ? 256 : responseLength === "concise" ? 512 : 1024;

  const response = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: maxTokens,
    system: systemPrompt,
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
