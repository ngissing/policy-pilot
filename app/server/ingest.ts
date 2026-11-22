import fs from "node:fs";
import crypto from "node:crypto";
import { all, one, run, tx } from "./db.ts";
import { embed, indexAdd, indexRemoveDoc, toBlob, vectorSearch, DIMS } from "./embed.ts";
import { chunkMarkdown, extract, firstHeading, titleFromFilename, wordCount } from "./text.ts";
import type { Chunk } from "./text.ts";
import { aiReady, structured, friendlyAiError } from "./ai.ts";

export const CATEGORIES = [
  "Human resources",
  "Finance and procurement",
  "Student health, safety, wellbeing and engagement",
  "Infrastructure and facilities",
  "Occupational health and safety",
  "School operations and student administration",
  "School councils",
  "Learning, teaching, curriculum and improvement",
  "Information management, security and technology",
] as const;

export const DOC_TYPES = ["Policy", "Procedure", "Guideline", "Plan", "Form or template", "Handbook", "Register", "Statement", "Other"];
export const AUDIENCES = ["Staff", "Students", "Parents and carers", "Whole school community", "School council"];

export const sha = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest("hex");

/** Replace a document's chunks (DB + FTS + vector index). */
export async function writeChunks(docId: number, schoolId: number | null, title: string, chunks: Chunk[]) {
  const vectors = await embed(chunks.map((c) => `${title}. ${c.section}\n${c.text}`));
  tx(() => {
    for (const { id } of all<{ id: number }>("SELECT id FROM chunks WHERE document_id = ?", docId)) {
      run("DELETE FROM chunks_fts WHERE rowid = ?", id);
    }
    run("DELETE FROM chunks WHERE document_id = ?", docId);
    chunks.forEach((c, i) => {
      const r = run(
        "INSERT INTO chunks(document_id, school_id, idx, section, text, embedding) VALUES (?, ?, ?, ?, ?, ?)",
        docId, schoolId, i, c.section, c.text, toBlob(vectors[i])
      );
      run("INSERT INTO chunks_fts(rowid, title, section, text) VALUES (?, ?, ?, ?)", r.lastInsertRowid, title, c.section, c.text);
    });
  });
  indexRemoveDoc(docId);
  const rows = all<{ id: number; idx: number }>("SELECT id, idx FROM chunks WHERE document_id = ?", docId);
  for (const r of rows) indexAdd(r.id, docId, schoolId, vectors[r.idx]);
}

export function deleteDocument(docId: number) {
  tx(() => {
    for (const { id } of all<{ id: number }>("SELECT id FROM chunks WHERE document_id = ?", docId)) {
      run("DELETE FROM chunks_fts WHERE rowid = ?", id);
    }
    run("DELETE FROM documents WHERE id = ?", docId);
  });
  indexRemoveDoc(docId);
}

// ─── AI tagging and plain-English overview ───────────────────────────────────

interface Tags {
  title: string;
  category: string;
  doc_type: string;
  audience: string;
  summary: string;
  overview: string;
  reviewed_date: string;
  next_review: string;
}

const TAG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "category", "doc_type", "audience", "summary", "overview", "reviewed_date", "next_review"],
  properties: {
    title: { type: "string", description: "The document's real title, as the school would name it." },
    category: { type: "string", enum: [...CATEGORIES, "Other"] },
    doc_type: { type: "string", enum: DOC_TYPES },
    audience: { type: "string", enum: AUDIENCES },
    summary: { type: "string", description: "One plain sentence: what this document is for." },
    overview: { type: "string", description: "Markdown overview (see instructions)." },
    reviewed_date: { type: "string", description: "Date last approved or reviewed, as YYYY-MM-DD or YYYY-MM. Empty string if not stated." },
    next_review: { type: "string", description: "Date the document is next due for review, as YYYY-MM-DD or YYYY-MM. Empty string if not stated." },
  },
};

const TAG_SYSTEM = `You catalogue documents for a Victorian government school's policy library. School leaders will rely on your overview instead of reading the whole document, so it must be accurate and must never add requirements the document does not contain.

Write the overview in Australian English, in this markdown shape:
### What it covers
1–2 sentences.
### Key requirements
3–7 bullets of the concrete obligations or steps, each short. Quote numbers, timeframes and roles exactly.
### Who is responsible
Bullets naming roles (e.g. principal, classroom teacher, first aid officer).
### Review
When it was approved or reviewed and when it is next due, if stated. Otherwise write "Not stated in the document."

If a section has nothing in the document, write "Not stated in the document." under it.`;

export async function tagDocument(title: string, body: string): Promise<Tags> {
  return structured<Tags>({
    system: TAG_SYSTEM,
    prompt: `Filename or working title: ${title}\n\n<document>\n${body.slice(0, 400_000)}\n</document>`,
    schema: TAG_SCHEMA,
    effort: "low",
  });
}

// ─── Linking school documents to the PAL topics they relate to ──────────────

export function linkToPal(docId: number) {
  const vecs = all<{ embedding: Uint8Array }>("SELECT embedding FROM chunks WHERE document_id = ? AND embedding IS NOT NULL", docId);
  if (!vecs.length) return;
  const mean = new Float32Array(DIMS);
  for (const { embedding } of vecs) {
    const v = new Float32Array(embedding.buffer.slice(embedding.byteOffset, embedding.byteOffset + embedding.byteLength));
    for (let i = 0; i < DIMS; i++) mean[i] += v[i];
  }
  const norm = Math.hypot(...mean) || 1;
  for (let i = 0; i < DIMS; i++) mean[i] /= norm;
  const hits = vectorSearch(mean, (e) => e.schoolId === null, 60);
  const best = new Map<number, number>();
  for (const h of hits) best.set(h.docId, Math.max(best.get(h.docId) ?? 0, h.score));
  // Similar policy texts all score fairly high, so keep only topics close to the best match.
  const ranked = [...best.entries()].sort((a, b) => b[1] - a[1]);
  const bestScore = ranked[0]?.[1] ?? 0;
  const top = ranked.filter(([, s]) => s >= 0.55 && s >= bestScore - 0.05).slice(0, 3);
  tx(() => {
    run("DELETE FROM doc_links WHERE document_id = ?", docId);
    for (const [palDocId, score] of top) {
      // A match on an attached guide counts for the PAL topic it belongs to.
      const slug = one<{ slug: string }>("SELECT COALESCE(d.pal_slug, p.pal_slug) AS slug FROM documents d LEFT JOIN documents p ON p.id = d.parent_id WHERE d.id = ?", palDocId)?.slug;
      if (slug) run("INSERT OR REPLACE INTO doc_links(document_id, pal_slug, score) VALUES (?, ?, ?)", docId, slug, score);
    }
  });
}

// ─── Processing queue for school documents ───────────────────────────────────

const queue: number[] = [];
let active = 0;
const CONCURRENCY = 2;

export function enqueue(docId: number) {
  run("UPDATE documents SET status = 'queued', error = NULL WHERE id = ?", docId);
  queue.push(docId);
  pump();
}

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const id = queue.shift()!;
    active++;
    processDocument(id)
      .catch((err) => {
        run("UPDATE documents SET status = 'error', error = ?, updated_at = datetime('now') WHERE id = ?", friendlyAiError(err), id);
      })
      .finally(() => {
        active--;
        pump();
      });
  }
}

export function resumeQueue() {
  for (const { id } of all<{ id: number }>("SELECT id FROM documents WHERE status = 'queued' AND source != 'pal' ORDER BY id")) {
    queue.push(id);
  }
  pump();
}

/** Re-run AI tagging for documents that were added before an API key was set. */
export function retagPending() {
  if (!aiReady()) return 0;
  const rows = all<{ id: number }>("SELECT id FROM documents WHERE needs_ai = 1 AND status = 'ready' AND source != 'pal'");
  rows.forEach((r) => enqueue(r.id));
  return rows.length;
}

async function processDocument(docId: number) {
  const doc = one("SELECT * FROM documents WHERE id = ?", docId);
  if (!doc) return;
  run("UPDATE documents SET status = 'processing', updated_at = datetime('now') WHERE id = ?", docId);

  let body: string = doc.body ?? "";
  if (!body && doc.file_path) {
    body = await extract(fs.readFileSync(doc.file_path), doc.mime);
  }
  if (wordCount(body) < 20) {
    throw new Error("This file has almost no readable text. If it's a scanned PDF, save it with text recognition (OCR) and upload it again.");
  }

  const twin = one<{ title: string }>(
    "SELECT title FROM documents WHERE school_id IS ? AND content_hash = ? AND id != ? AND status = 'ready'",
    doc.school_id, sha(body), docId
  );
  if (twin) throw new Error(`This is the same as "${twin.title}", which is already in your library.`);

  let title: string = doc.title || firstHeading(body) || titleFromFilename(doc.filename ?? "Untitled");
  let fields: Partial<Tags> = {};
  let needsAi = 0;
  if (aiReady()) {
    fields = await tagDocument(title, body);
    title = fields.title?.trim() || title;
  } else {
    needsAi = 1;
    title = firstHeading(body) ?? title;
  }

  await writeChunks(docId, doc.school_id, title, chunkMarkdown(body));

  run(
    `UPDATE documents SET title = ?, body = ?, word_count = ?, content_hash = ?, category = ?, doc_type = ?, audience = ?,
       summary = ?, overview = ?, reviewed_date = ?, next_review = ?, needs_ai = ?, status = 'ready', error = NULL,
       updated_at = datetime('now') WHERE id = ?`,
    title, body, wordCount(body), sha(body),
    fields.category && fields.category !== "Other" ? fields.category : doc.category ?? null,
    fields.doc_type ?? doc.doc_type ?? null,
    fields.audience ?? doc.audience ?? null,
    fields.summary ?? null,
    fields.overview ?? null,
    fields.reviewed_date || null,
    fields.next_review || null,
    needsAi,
    docId
  );
  linkToPal(docId);
}
