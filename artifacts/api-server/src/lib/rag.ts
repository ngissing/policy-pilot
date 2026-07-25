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
  const embeddingLiteral = `[${queryEmbedding.join(",")}]`;

  const domainCondition =
    domainFilter && domainFilter !== "all"
      ? `AND d.policy_domain = $4`
      : "";

  const chunkParams: unknown[] = [embeddingLiteral, SIMILARITY_THRESHOLD, maxSources * 4];
  if (domainFilter && domainFilter !== "all") {
    chunkParams.push(domainFilter);
  }

  // Run wiki and chunk searches in parallel
  const [chunkResult, wikiResult] = await Promise.all([
    pool.query<{
      id: number;
      content: string;
      document_id: number;
      filename: string;
      title: string | null;
      issuing_authority: string | null;
      policy_domain: string | null;
      similarity: number;
    }>(
      `
      SELECT
        dc.id,
        dc.content,
        dc.document_id,
        d.filename,
        d.title,
        d.issuing_authority,
        d.policy_domain,
        1 - (dc.embedding <=> $1::vector) AS similarity
      FROM document_chunks dc
      INNER JOIN documents d ON dc.document_id = d.id
      WHERE dc.embedding IS NOT NULL
        AND 1 - (dc.embedding <=> $1::vector) >= $2
        ${domainCondition}
      ORDER BY dc.embedding <=> $1::vector
      LIMIT $3
      `,
      chunkParams
    ),
    pool.query<{
      id: number;
      document_id: number;
      title: string;
      summary: string | null;
      markdown_content: string;
      filename: string;
      issuing_authority: string | null;
      similarity: number;
    }>(
      `
      SELECT
        wp.id,
        wp.document_id,
        wp.title,
        wp.summary,
        wp.markdown_content,
        d.filename,
        d.issuing_authority,
        1 - (wp.embedding <=> $1::vector) AS similarity
      FROM wiki_pages wp
      INNER JOIN documents d ON wp.document_id = d.id
      WHERE wp.embedding IS NOT NULL
        AND 1 - (wp.embedding <=> $1::vector) >= $2
      ORDER BY wp.embedding <=> $1::vector
      LIMIT $3
      `,
      [embeddingLiteral, WIKI_SIMILARITY_THRESHOLD, 3]
    ),
  ]);

  // Apply scope filter to chunks
  const scoredChunks = chunkResult.rows
    .filter((c) => {
      if (scopeFilter === "department" && !isDepartmentPolicy(c.issuing_authority)) return false;
      if (scopeFilter === "school" && isDepartmentPolicy(c.issuing_authority)) return false;
      return true;
    })
    .slice(0, maxSources);

  // Apply scope filter to wiki results
  const scoredWiki = wikiResult.rows
    .filter((w) => {
      if (scopeFilter === "department" && !isDepartmentPolicy(w.issuing_authority)) return false;
      if (scopeFilter === "school" && isDepartmentPolicy(w.issuing_authority)) return false;
      return true;
    })
    .slice(0, 2);

  if (scoredChunks.length === 0 && scoredWiki.length === 0) {
    return { answer: fallbackMessage, citations: [] };
  }

  // Build combined context — wiki first (structure), then chunks (evidence)
  const wikiContext = scoredWiki
    .map((w, i) => {
      const excerpt = w.summary
        ? `${w.summary}\n\n${w.markdown_content.slice(0, 1500)}`
        : w.markdown_content.slice(0, 2000);
      return `[W${i + 1}] Wiki summary for "${w.title}" (doc #${w.document_id}):\n${excerpt}`;
    })
    .join("\n\n---\n\n");

  const chunkContext = scoredChunks
    .map((c, i) => {
      const label = c.title ?? c.filename;
      return `[${i + 1}] From "${label}" (doc #${c.document_id}):\n${c.content}`;
    })
    .join("\n\n---\n\n");

  const fullContext = [
    scoredWiki.length > 0
      ? `=== STRUCTURED WIKI KNOWLEDGE ===\n${wikiContext}`
      : null,
    scoredChunks.length > 0
      ? `=== VERBATIM DOCUMENT EVIDENCE ===\n${chunkContext}`
      : null,
  ]
    .filter(Boolean)
    .join("\n\n");

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

  const maxTokens = responseLength === "brief" ? 256 : responseLength === "concise" ? 512 : 1024;

  const response = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: maxTokens,
    system: systemPrompt,
    messages,
  });

  const responseContent = response.content[0];
  if (responseContent.type !== "text") throw new Error("Unexpected response type");

  // Parse wiki citations [W1], [W2], ...
  const wikiRefs = [...responseContent.text.matchAll(/\[W(\d+)\]/g)].map(
    (m) => parseInt(m[1], 10) - 1
  );
  const usedWikiIndices = [...new Set(wikiRefs)].filter(
    (i) => i >= 0 && i < scoredWiki.length
  );

  // Parse chunk citations [1], [2], ... (but not [W...])
  const chunkRefs = [...responseContent.text.matchAll(/\[(?!W)(\d+)\]/g)].map(
    (m) => parseInt(m[1], 10) - 1
  );
  const usedChunkIndices = [...new Set(chunkRefs)].filter(
    (i) => i >= 0 && i < scoredChunks.length
  );

  const wikiCitations: Citation[] = usedWikiIndices.map((i) => ({
    documentId: scoredWiki[i].document_id,
    title: scoredWiki[i].title,
    filename: scoredWiki[i].filename,
    excerpt: scoredWiki[i].summary ?? scoredWiki[i].markdown_content.slice(0, 200),
    sourceType: "wiki" as const,
  }));

  const chunkCitations: Citation[] = usedChunkIndices.map((i) => ({
    documentId: scoredChunks[i].document_id,
    title: scoredChunks[i].title ?? null,
    filename: scoredChunks[i].filename,
    excerpt: scoredChunks[i].content.slice(0, 200),
    sourceType: "chunk" as const,
  }));

  // Deduplicate by documentId, wiki takes precedence
  const seen = new Set<number>();
  const citations: Citation[] = [];
  for (const c of [...wikiCitations, ...chunkCitations]) {
    if (!seen.has(c.documentId)) {
      seen.add(c.documentId);
      citations.push(c);
    }
  }

  // Build a mapping from original context reference → final 1-based display position.
  // Claude numbers chunks [1]..[N] and wiki sources [W1]..[WM] based on their position
  // in the context. The citations array is deduplicated, so those numbers no longer
  // correspond to sequential display positions. We rewrite them here so the inline
  // citations in the answer text match the [1], [2], ... labels shown in the sources panel.
  const refToDisplay = new Map<string, number>();

  // Wiki refs: [W1] → original index 0 → find in citations by documentId
  for (const origIdx of usedWikiIndices) {
    const docId = scoredWiki[origIdx].document_id;
    const displayPos = citations.findIndex((c) => c.documentId === docId) + 1;
    if (displayPos > 0) refToDisplay.set(`W${origIdx + 1}`, displayPos);
  }

  // Chunk refs: [1], [3] etc. → original index → find in citations by documentId
  // (chunk may be deduped under a wiki entry for the same document, which is correct)
  for (const origIdx of usedChunkIndices) {
    const docId = scoredChunks[origIdx].document_id;
    const displayPos = citations.findIndex((c) => c.documentId === docId) + 1;
    if (displayPos > 0) refToDisplay.set(`${origIdx + 1}`, displayPos);
  }

  // Replace [WN] and [N] in one pass to avoid double-substitution
  const answer = responseContent.text.replace(
    /\[W(\d+)\]|\[(?!W)(\d+)\]/g,
    (match, wNum: string | undefined, cNum: string | undefined) => {
      const key = wNum !== undefined ? `W${wNum}` : cNum!;
      const pos = refToDisplay.get(key);
      return pos !== undefined ? `[${pos}]` : match;
    }
  );

  return { answer, citations };
}
