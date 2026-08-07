import { anthropic } from "@workspace/integrations-anthropic-ai";
import { db, pool } from "@workspace/db";
import { documentChunks, documents, wikiPages } from "@workspace/db";
import { sql } from "drizzle-orm";
import { computeEmbedding } from "./embeddings.js";

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
  sourceUrl?: string | null;
  sourceType?: "wiki" | "chunk";
  wikiSection?: string;
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

const SIMILARITY_THRESHOLD = 0.3;
const WIKI_SIMILARITY_THRESHOLD = 0.25;

// ─── Internal types ────────────────────────────────────────────────────────

interface ChunkRow {
  id: number;
  content: string;
  document_id: number;
  filename: string;
  title: string | null;
  issuing_authority: string | null;
  policy_domain: string | null;
  source_url: string | null;
  similarity: number;
}

interface WikiRow {
  id: number;
  wiki_page_id: number;
  document_id: number;
  heading: string;
  content: string;
  title: string;
  summary: string | null;
  filename: string;
  issuing_authority: string | null;
  source_url: string | null;
  similarity: number;
}

interface PreparedRagContext {
  /** True when no relevant documents were found — callers should return fallbackMessage directly. */
  isEmpty: boolean;
  scoredChunks: ChunkRow[];
  scoredWiki: WikiRow[];
  systemPrompt: string;
  claudeMessages: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens: number;
  fallbackMessage: string;
}

// ─── Shared context building ────────────────────────────────────────────────

async function prepareRagContext(
  question: string,
  history: Array<{ role: string; content: string }>,
  options: RagOptions
): Promise<PreparedRagContext> {
  const {
    responseLength = "detailed",
    responseTone = "formal",
    maxSources = 5,
    fallbackMessage = DEFAULT_FALLBACK,
    scopeFilter = "all",
    domainFilter = "all",
  } = options;

  const queryEmbedding = await computeEmbedding(question);
  const embeddingLiteral = `[${queryEmbedding.join(",")}]`;

  const domainCondition =
    domainFilter && domainFilter !== "all" ? `AND d.policy_domain = $4` : "";

  const chunkParams: unknown[] = [embeddingLiteral, SIMILARITY_THRESHOLD, maxSources * 4];
  if (domainFilter && domainFilter !== "all") chunkParams.push(domainFilter);

  const [chunkResult, wikiResult] = await Promise.all([
    pool.query<ChunkRow>(
      `
      SELECT
        dc.id,
        dc.content,
        dc.document_id,
        d.filename,
        d.title,
        d.issuing_authority,
        d.policy_domain,
        d.source_url,
        1 - (dc.embedding <=> $1::vector) AS similarity
      FROM document_chunks dc
      INNER JOIN documents d ON dc.document_id = d.id
      WHERE dc.embedding IS NOT NULL
        AND 1 - (dc.embedding <=> $1::vector) >= $2
        AND d.status != 'rejected'
        ${domainCondition}
      ORDER BY dc.embedding <=> $1::vector
      LIMIT $3
      `,
      chunkParams
    ),
    pool.query<WikiRow>(
      `
      SELECT
        ws.id,
        ws.wiki_page_id,
        ws.document_id,
        ws.heading,
        ws.content,
        wp.title,
        wp.summary,
        d.filename,
        d.issuing_authority,
        d.source_url,
        1 - (ws.embedding <=> $1::vector) AS similarity
      FROM wiki_sections ws
      INNER JOIN wiki_pages wp ON ws.wiki_page_id = wp.id
      INNER JOIN documents d ON ws.document_id = d.id
      WHERE ws.embedding IS NOT NULL
        AND 1 - (ws.embedding <=> $1::vector) >= $2
        AND d.status != 'rejected'
      ORDER BY ws.embedding <=> $1::vector
      LIMIT 4
      `,
      [embeddingLiteral, WIKI_SIMILARITY_THRESHOLD]
    ),
  ]);

  const scoredChunks = chunkResult.rows
    .filter((c) => {
      if (scopeFilter === "department" && !isDepartmentPolicy(c.issuing_authority)) return false;
      if (scopeFilter === "school" && isDepartmentPolicy(c.issuing_authority)) return false;
      return true;
    })
    .slice(0, maxSources);

  const wikiSeenDocIds = new Set<number>();
  const scoredWiki = wikiResult.rows.filter((w) => {
    if (scopeFilter === "department" && !isDepartmentPolicy(w.issuing_authority)) return false;
    if (scopeFilter === "school" && isDepartmentPolicy(w.issuing_authority)) return false;
    if (wikiSeenDocIds.size >= 2 && !wikiSeenDocIds.has(w.document_id)) return false;
    wikiSeenDocIds.add(w.document_id);
    return true;
  });

  if (scoredChunks.length === 0 && scoredWiki.length === 0) {
    return {
      isEmpty: true,
      scoredChunks: [],
      scoredWiki: [],
      systemPrompt: "",
      claudeMessages: [],
      maxTokens: 256,
      fallbackMessage,
    };
  }

  const wikiContext = scoredWiki
    .map((w, i) => `[W${i + 1}] From "${w.title}" — ${w.heading}:\n${w.content.slice(0, 1_200)}`)
    .join("\n\n---\n\n");

  const chunkContext = scoredChunks
    .map((c, i) => {
      const label = c.title ?? c.filename;
      return `[${i + 1}] From "${label}" (doc #${c.document_id}):\n${c.content}`;
    })
    .join("\n\n---\n\n");

  const fullContext = [
    scoredWiki.length > 0 ? `=== STRUCTURED WIKI KNOWLEDGE ===\n${wikiContext}` : null,
    scoredChunks.length > 0 ? `=== VERBATIM DOCUMENT EVIDENCE ===\n${chunkContext}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  const safeHistory = history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-10)
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  const claudeMessages: Array<{ role: "user" | "assistant"; content: string }> = [
    ...safeHistory,
    {
      role: "user",
      content: `Context from policy documents:\n${fullContext}\n\nQuestion: ${question}\n\nAnswer based ONLY on the policy documents above.\n- Use [WN] to cite wiki sources (e.g. [W1]) and [N] for verbatim document chunks (e.g. [1]).\n- For summaries or procedures, prefer wiki sources.\n- For exact wording, quote verbatim chunks.\n- If the answer is not in the provided documents, respond with exactly: "${fallbackMessage}"`,
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

  const systemPrompt = `You are PolicyPilot, an AI assistant specialising in Australian K-12 school policies. You have access to two types of context: structured wiki summaries (labelled [WN]) and verbatim policy document chunks (labelled [N]). Use wiki sources for overviews and procedures; use verbatim chunks for exact wording and specific claims. Always cite sources. Never fabricate information. ${toneInstruction} ${lengthInstruction}`;

  const maxTokens =
    responseLength === "brief" ? 256 : responseLength === "concise" ? 512 : 1024;

  return {
    isEmpty: false,
    scoredChunks,
    scoredWiki,
    systemPrompt,
    claudeMessages,
    maxTokens,
    fallbackMessage,
  };
}

// ─── Shared response processing ─────────────────────────────────────────────

function finalizeRagResult(responseText: string, ctx: PreparedRagContext): RagResult {
  const { scoredChunks, scoredWiki } = ctx;

  const wikiRefs = [...responseText.matchAll(/\[W(\d+)\]/g)].map(
    (m) => parseInt(m[1], 10) - 1
  );
  const usedWikiIndices = [...new Set(wikiRefs)].filter(
    (i) => i >= 0 && i < scoredWiki.length
  );

  const chunkRefs = [...responseText.matchAll(/\[(?!W)(\d+)\]/g)].map(
    (m) => parseInt(m[1], 10) - 1
  );
  const usedChunkIndices = [...new Set(chunkRefs)].filter(
    (i) => i >= 0 && i < scoredChunks.length
  );

  const wikiCitations: Citation[] = usedWikiIndices.map((i) => ({
    documentId: scoredWiki[i].document_id,
    title: scoredWiki[i].title,
    filename: scoredWiki[i].filename,
    excerpt: `${scoredWiki[i].heading}: ${scoredWiki[i].content.slice(0, 160)}`,
    sourceUrl: scoredWiki[i].source_url,
    sourceType: "wiki" as const,
  }));

  const chunkCitations: Citation[] = usedChunkIndices.map((i) => ({
    documentId: scoredChunks[i].document_id,
    title: scoredChunks[i].title ?? null,
    filename: scoredChunks[i].filename,
    excerpt: scoredChunks[i].content.slice(0, 200),
    sourceUrl: scoredChunks[i].source_url,
    sourceType: "chunk" as const,
  }));

  const seen = new Set<number>();
  const citations: Citation[] = [];
  for (const c of [...wikiCitations, ...chunkCitations]) {
    if (!seen.has(c.documentId)) {
      seen.add(c.documentId);
      citations.push(c);
    }
  }

  const refToDisplay = new Map<string, number>();
  for (const origIdx of usedWikiIndices) {
    const docId = scoredWiki[origIdx].document_id;
    const displayPos = citations.findIndex((c) => c.documentId === docId) + 1;
    if (displayPos > 0) refToDisplay.set(`W${origIdx + 1}`, displayPos);
  }
  for (const origIdx of usedChunkIndices) {
    const docId = scoredChunks[origIdx].document_id;
    const displayPos = citations.findIndex((c) => c.documentId === docId) + 1;
    if (displayPos > 0) refToDisplay.set(`${origIdx + 1}`, displayPos);
  }

  const answer = responseText.replace(
    /\[W(\d+)\]|\[(?!W)(\d+)\]/g,
    (match, wNum: string | undefined, cNum: string | undefined) => {
      const key = wNum !== undefined ? `W${wNum}` : cNum!;
      const pos = refToDisplay.get(key);
      return pos !== undefined ? `[${pos}]` : match;
    }
  );

  return { answer, citations };
}

// ─── Public API ─────────────────────────────────────────────────────────────

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

/** Non-streaming RAG — waits for the full response before returning. */
export async function ragChat(
  question: string,
  history: Array<{ role: string; content: string }>,
  options: RagOptions = {}
): Promise<RagResult> {
  const ctx = await prepareRagContext(question, history, options);
  if (ctx.isEmpty) return { answer: ctx.fallbackMessage, citations: [] };

  const response = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: ctx.maxTokens,
    system: ctx.systemPrompt,
    messages: ctx.claudeMessages,
  });

  const responseContent = response.content[0];
  if (responseContent.type !== "text") throw new Error("Unexpected response type");

  return finalizeRagResult(responseContent.text, ctx);
}

/**
 * Streaming RAG — calls `onToken` for each text chunk as Claude generates it,
 * then returns the fully processed RagResult (with renumbered citations) when done.
 */
export async function ragChatStream(
  question: string,
  history: Array<{ role: string; content: string }>,
  options: RagOptions = {},
  onToken: (text: string) => void
): Promise<RagResult> {
  const ctx = await prepareRagContext(question, history, options);

  if (ctx.isEmpty) {
    onToken(ctx.fallbackMessage);
    return { answer: ctx.fallbackMessage, citations: [] };
  }

  // Stream tokens from Claude as they arrive
  const stream = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: ctx.maxTokens,
    system: ctx.systemPrompt,
    messages: ctx.claudeMessages,
    stream: true,
  });

  let rawText = "";
  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      onToken(event.delta.text);
      rawText += event.delta.text;
    }
  }

  // Post-process the complete text: parse citations and renumber references
  return finalizeRagResult(rawText, ctx);
}
