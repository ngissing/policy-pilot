import { anthropic } from "@workspace/integrations-anthropic-ai";
import { db } from "@workspace/db";
import { wikiPages } from "@workspace/db";
import { eq } from "drizzle-orm";
import { computeEmbedding } from "./embeddings.js";
import { logger } from "./logger.js";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 80);
}

const WIKI_SYSTEM_PROMPT = `You are an expert at converting policy documents into structured internal wiki pages for Australian K-12 schools.`;

const WIKI_USER_PROMPT = (text: string) => `Convert this policy document into a structured internal wiki page.

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
  ## Common Questions
  ## Source Notes
- Include exact references to document sections when available.
- If information is unclear or absent, write "Not specified in the source document."
- Begin your response with a single line: TITLE: <the policy title>
- Then a blank line, then: SUMMARY: <one sentence summary>
- Then a blank line, then the full markdown wiki content starting with ## Overview

Document text:
${text.slice(0, 12000)}`;

export interface WikiGenerationResult {
  title: string;
  slug: string;
  markdownContent: string;
  summary: string;
}

export async function generateWikiPage(
  rawText: string
): Promise<WikiGenerationResult> {
  const response = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 2048,
    system: WIKI_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: WIKI_USER_PROMPT(rawText),
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== "text") throw new Error("Unexpected wiki response type");

  const raw = content.text.trim();

  const titleMatch = raw.match(/^TITLE:\s*(.+)/m);
  const summaryMatch = raw.match(/^SUMMARY:\s*(.+)/m);
  const markdownStart = raw.indexOf("## ");

  const title = titleMatch?.[1]?.trim() ?? "Policy Wiki Page";
  const summary = summaryMatch?.[1]?.trim() ?? "";
  const markdownContent =
    markdownStart !== -1 ? raw.slice(markdownStart).trim() : raw;

  return {
    title,
    slug: slugify(title),
    markdownContent,
    summary,
  };
}

export async function upsertWikiPage(
  documentId: number,
  rawText: string
): Promise<void> {
  const wiki = await generateWikiPage(rawText);
  const embedding = await computeEmbedding(
    `${wiki.title}\n${wiki.summary}\n${wiki.markdownContent.slice(0, 1000)}`
  );

  const existing = await db
    .select({ id: wikiPages.id })
    .from(wikiPages)
    .where(eq(wikiPages.documentId, documentId));

  if (existing.length > 0) {
    await db
      .update(wikiPages)
      .set({
        title: wiki.title,
        slug: wiki.slug,
        markdownContent: wiki.markdownContent,
        summary: wiki.summary,
        embedding,
        updatedAt: new Date(),
      })
      .where(eq(wikiPages.documentId, documentId));
  } else {
    await db.insert(wikiPages).values({
      documentId,
      title: wiki.title,
      slug: wiki.slug,
      markdownContent: wiki.markdownContent,
      summary: wiki.summary,
      embedding,
    });
  }

  logger.info({ documentId, title: wiki.title }, "Wiki page generated");
}
