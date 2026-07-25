import { anthropic } from "@workspace/integrations-anthropic-ai";
import { db } from "@workspace/db";
import { wikiPages, wikiSections } from "@workspace/db";
import { eq } from "drizzle-orm";
import { computeEmbedding } from "./embeddings.js";
import { logger } from "./logger.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Below this threshold the full text fits in one prompt — use a single LLM pass.
 * Above it, use a two-pass extract→synthesize approach so no content is truncated.
 */
const SINGLE_PASS_THRESHOLD = 10_000; // chars

/** Size of each extraction chunk in the multi-pass path */
const EXTRACT_CHUNK_SIZE = 10_000; // chars

/**
 * Maximum number of extraction chunks (covers up to 60,000 chars).
 * PAL print-all pages are typically 15–40k chars; even complex topics are covered.
 */
const MAX_EXTRACT_CHUNKS = 6;

// ─── Utilities ────────────────────────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 80);
}

/**
 * Split text into non-overlapping chunks at word boundaries.
 * No overlap is intentional — each chunk is independently summarised, so
 * overlapping context would inflate the extracted facts without adding precision.
 */
function splitIntoChunks(text: string, chunkSize: number, maxChunks: number): string[] {
  const chunks: string[] = [];
  let pos = 0;
  while (pos < text.length && chunks.length < maxChunks) {
    let end = Math.min(pos + chunkSize, text.length);
    // Snap backward to a word boundary when not at the end of the text
    if (end < text.length) {
      const lastSpace = text.lastIndexOf(" ", end);
      if (lastSpace > pos) end = lastSpace;
    }
    const chunk = text.slice(pos, end).trim();
    if (chunk.length > 0) chunks.push(chunk);
    pos = end;
  }
  return chunks;
}

/**
 * Parse wiki markdown into discrete top-level sections (## headings only).
 * Sub-headings (###) are kept inside their parent section's content.
 * Sections with fewer than 20 chars of content are skipped.
 */
function parseSections(markdown: string): Array<{ heading: string; content: string }> {
  const parts = markdown.split(/\n(?=## )/);
  const sections: Array<{ heading: string; content: string }> = [];
  for (const part of parts) {
    const newlineIdx = part.indexOf("\n");
    if (newlineIdx === -1) continue;
    const heading = part.slice(0, newlineIdx).replace(/^##\s*/, "").trim();
    const content = part.slice(newlineIdx + 1).trim();
    if (heading && content.length >= 20) {
      sections.push({ heading, content });
    }
  }
  return sections;
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

const WIKI_SYSTEM_PROMPT =
  "You are an expert at converting policy documents into structured internal wiki pages for Australian K-12 schools.";

const EXTRACT_SYSTEM_PROMPT =
  "You are extracting structured policy facts from sections of Australian K-12 school policy documents.";

function extractionUserPrompt(chunk: string, chunkIndex: number, totalChunks: number): string {
  return `Extract key policy information from section ${chunkIndex + 1} of ${totalChunks} of a school policy document. Be concise — use brief bullet points.

Extract under each heading below. Write "none" if not present in this section.

KEY REQUIREMENTS: (obligations, rules, mandates)
PROCEDURES: (step-by-step processes or workflows)
RESPONSIBILITIES: (who must do what)
DEFINITIONS: (defined terms and meanings)
DATES & TIMEFRAMES: (review dates, deadlines, effective dates)
RELATED POLICIES: (other policies or documents referenced)

Only include information explicitly stated. Do not infer or expand.

Section text:
${chunk}`;
}

function synthesisUserPrompt(
  inferredTitle: string,
  opening: string,
  extractedFacts: string
): string {
  return `Convert this Australian K-12 school policy into a structured internal wiki page.

You have the document's inferred title, its opening paragraphs, and structured facts extracted from every section of the full document.

Requirements:
- Use clear markdown with proper headings.
- Preserve factual meaning exactly — do not invent or infer rules not stated.
- Include these sections (omit any where information is genuinely absent):
  ## Overview
  ## Purpose
  ## Scope
  ## Key Responsibilities
  ## Procedures
  ## Important Definitions
  ## Related Policies
  ## Source Notes
- If information is absent, write "Not specified in the source document."
- Do NOT add a "Common Questions" section.
- Begin your response with:
  TITLE: <the policy title>
  SUMMARY: <one sentence summary>
  RELATED_TOPICS_JSON: <JSON array of related policy/topic names, e.g. ["Child Safety Policy", "Duty of Care"]>
  (blank line)
  ## Overview
  ...

Inferred document title: ${inferredTitle}

Document opening (first 2,000 characters):
${opening}

Extracted facts from all sections:
${extractedFacts}`;
}

function singlePassUserPrompt(text: string): string {
  return `Convert this policy document into a structured internal wiki page.

Requirements:
- Use clear markdown with proper headings.
- Preserve factual meaning exactly — do not invent or infer rules not stated.
- Include these sections (omit any where information is genuinely absent):
  ## Overview
  ## Purpose
  ## Scope
  ## Key Responsibilities
  ## Procedures
  ## Important Definitions
  ## Related Policies
  ## Source Notes
- Include exact references to document sections when available.
- If information is unclear or absent, write "Not specified in the source document."
- Do NOT add a "Common Questions" section.
- Begin your response with:
  TITLE: <the policy title>
  SUMMARY: <one sentence summary>
  RELATED_TOPICS_JSON: <JSON array of related policy/topic names, e.g. ["Child Safety Policy", "Duty of Care"]>
  (blank line)
  ## Overview
  ...

Document text:
${text.slice(0, 10_000)}`;
}

// ─── Response parsing ─────────────────────────────────────────────────────────

export interface WikiGenerationResult {
  title: string;
  slug: string;
  markdownContent: string;
  summary: string;
  relatedTopics: string[];
}

function parseWikiResponse(raw: string): WikiGenerationResult {
  const titleMatch = raw.match(/^TITLE:\s*(.+)/m);
  const summaryMatch = raw.match(/^SUMMARY:\s*(.+)/m);
  // Match RELATED_TOPICS_JSON with its JSON array (may span to first ])
  const relatedMatch = raw.match(/^RELATED_TOPICS_JSON:\s*(\[.*?\])/ms);
  // Find the start of the first top-level section
  const markdownStart = raw.indexOf("\n## ");

  const title = titleMatch?.[1]?.trim() ?? "Policy Wiki Page";
  const summary = summaryMatch?.[1]?.trim() ?? "";

  let relatedTopics: string[] = [];
  if (relatedMatch?.[1]) {
    try {
      const parsed = JSON.parse(relatedMatch[1]) as unknown;
      if (Array.isArray(parsed)) {
        relatedTopics = parsed.filter((t): t is string => typeof t === "string").slice(0, 10);
      }
    } catch {
      // Malformed JSON — degrade gracefully
    }
  }

  const markdownContent =
    markdownStart !== -1 ? raw.slice(markdownStart).trim() : raw;

  return {
    title,
    slug: slugify(title),
    markdownContent,
    summary,
    relatedTopics,
  };
}

// ─── Generation strategies ────────────────────────────────────────────────────

/** Single-pass path: used when the full text fits within the prompt limit. */
async function generateWikiPageSinglePass(rawText: string): Promise<WikiGenerationResult> {
  const response = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 2048,
    system: WIKI_SYSTEM_PROMPT,
    messages: [{ role: "user", content: singlePassUserPrompt(rawText) }],
  });

  const content = response.content[0];
  if (content.type !== "text") throw new Error("Unexpected wiki response type");
  return parseWikiResponse(content.text.trim());
}

/**
 * Multi-pass path: for long documents (PAL print-all pages, lengthy uploaded PDFs).
 *
 * Pass 1 (parallel): extract structured bullet-point facts from each chunk.
 *   This ensures no content is missed regardless of document length.
 *
 * Pass 2 (single): synthesize the complete wiki page from the aggregated facts
 *   plus the document's opening text (for context and tone).
 */
async function generateWikiPageMultiPass(rawText: string): Promise<WikiGenerationResult> {
  const chunks = splitIntoChunks(rawText, EXTRACT_CHUNK_SIZE, MAX_EXTRACT_CHUNKS);

  logger.info(
    { chunks: chunks.length, totalChars: rawText.length },
    "Wiki: running multi-pass extraction"
  );

  // Pass 1: extract facts from all chunks in parallel
  const factResponses = await Promise.all(
    chunks.map((chunk, i) =>
      anthropic.messages.create({
        model: "claude-opus-4-5",
        max_tokens: 600,
        system: EXTRACT_SYSTEM_PROMPT,
        messages: [{ role: "user", content: extractionUserPrompt(chunk, i, chunks.length) }],
      })
    )
  );

  const extractedFacts = factResponses
    .map((r, i) => {
      const content = r.content[0];
      if (content.type !== "text") return "";
      return `--- Section ${i + 1} of ${chunks.length} ---\n${content.text.trim()}`;
    })
    .filter(Boolean)
    .join("\n\n");

  // Infer a title from the document's first non-empty line (best effort)
  const inferredTitle =
    rawText
      .slice(0, 500)
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 5) ?? "Policy Document";

  // Pass 2: synthesize the full wiki page
  const response = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 2048,
    system: WIKI_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: synthesisUserPrompt(inferredTitle, rawText.slice(0, 2_000), extractedFacts),
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== "text") throw new Error("Unexpected wiki synthesis response type");
  return parseWikiResponse(content.text.trim());
}

export async function generateWikiPage(rawText: string): Promise<WikiGenerationResult> {
  if (rawText.length <= SINGLE_PASS_THRESHOLD) {
    return generateWikiPageSinglePass(rawText);
  }
  return generateWikiPageMultiPass(rawText);
}

// ─── Upsert (wiki page + per-section embeddings) ──────────────────────────────

/**
 * Generate (or regenerate) the wiki page for a document, then upsert both
 * the wiki_pages row and all wiki_sections rows with individual embeddings.
 *
 * The page-level embedding on wiki_pages is kept for backward compatibility.
 * RAG now queries wiki_sections for section-level precision retrieval.
 */
export async function upsertWikiPage(documentId: number, rawText: string): Promise<void> {
  const wiki = await generateWikiPage(rawText);

  // Page-level embedding (summary + first 1,000 chars of content)
  const pageEmbedding = await computeEmbedding(
    `${wiki.title}\n${wiki.summary}\n${wiki.markdownContent.slice(0, 1_000)}`
  );

  // ── Upsert wiki_pages row ──────────────────────────────────────────────────
  let wikiPageId: number;

  const existing = await db
    .select({ id: wikiPages.id })
    .from(wikiPages)
    .where(eq(wikiPages.documentId, documentId));

  if (existing.length > 0) {
    wikiPageId = existing[0].id;
    await db
      .update(wikiPages)
      .set({
        title: wiki.title,
        slug: wiki.slug,
        markdownContent: wiki.markdownContent,
        summary: wiki.summary,
        relatedTopics: wiki.relatedTopics.length > 0 ? wiki.relatedTopics : null,
        embedding: pageEmbedding,
        updatedAt: new Date(),
      })
      .where(eq(wikiPages.documentId, documentId));
  } else {
    const [inserted] = await db
      .insert(wikiPages)
      .values({
        documentId,
        title: wiki.title,
        slug: wiki.slug,
        markdownContent: wiki.markdownContent,
        summary: wiki.summary,
        relatedTopics: wiki.relatedTopics.length > 0 ? wiki.relatedTopics : null,
        embedding: pageEmbedding,
      })
      .returning({ id: wikiPages.id });
    wikiPageId = inserted.id;
  }

  // ── Replace wiki_sections (delete then re-insert) ─────────────────────────
  // Always replace on regeneration so stale sections from old content are removed.
  await db.delete(wikiSections).where(eq(wikiSections.wikiPageId, wikiPageId));

  const sections = parseSections(wiki.markdownContent);

  if (sections.length > 0) {
    // Embed each section with its title prefix for better semantic retrieval.
    // Content is capped at 800 chars — enough for the embedding model to
    // capture the section's meaning without padding noise.
    const sectionEmbeddings = await Promise.all(
      sections.map(({ heading, content }) =>
        computeEmbedding(`${wiki.title} — ${heading}\n${content.slice(0, 800)}`)
      )
    );

    await db.insert(wikiSections).values(
      sections.map(({ heading, content }, i) => ({
        wikiPageId,
        documentId,
        heading,
        content,
        embedding: sectionEmbeddings[i],
      }))
    );
  }

  logger.info(
    {
      documentId,
      title: wiki.title,
      sections: sections.length,
      relatedTopics: wiki.relatedTopics.length,
      multiPass: rawText.length > SINGLE_PASS_THRESHOLD,
    },
    "Wiki page generated"
  );
}
