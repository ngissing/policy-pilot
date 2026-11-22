import express from "express";
import type { Request, Response, NextFunction } from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { all, one, run, tx, setSetting, getSetting, UPLOAD_DIR } from "./db.ts";
import {
  hashPassword, verifyPassword, newJoinCode, startSession, endSession,
  requireUser, requireAdmin, requireOwner,
} from "./auth.ts";
import { aiReady, claude, structured, friendlyAiError, MODELS, answerModel, processingModel, isModel, estimateCost } from "./ai.ts";
import { enqueue, deleteDocument, retagPending, CATEGORIES, DOC_TYPES, AUDIENCES } from "./ingest.ts";
import { kindFromName, SUPPORTED } from "./text.ts";
import { startPalSync, palSyncRunning, recategorisePal } from "./pal.ts";
import { startFinder, importDiscovery, normaliseSiteUrl } from "./finder.ts";
import { buildChecklist, CHECKLIST } from "./checklist.ts";
import { answer, buildAnswerRequest, splitFollowups, toSourceOut, LENGTHS, userLength } from "./chat.ts";
import { retrieve } from "./search.ts";

export const api = express.Router();
api.use(express.json({ limit: "1mb" }));

type Handler = (req: Request, res: Response) => unknown | Promise<unknown>;
const h = (fn: Handler) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    await fn(req, res);
  } catch (err) {
    next(err);
  }
};
const bad = (res: Response, error: string, status = 400) => res.status(status).json({ error });
const int = (v: unknown) => Number.parseInt(String(v), 10);
const str = (v: unknown, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// ─── Session & sign-up ───────────────────────────────────────────────────────

api.get("/me", (req, res) => {
  const hasAccounts = !!one("SELECT 1 FROM users LIMIT 1");
  if (!req.user) return res.json({ user: null, hasAccounts });
  const school = one<any>("SELECT id, name, school_type, suburb, region, website, about FROM schools WHERE id = ?", req.user.school_id);
  const counts = one<any>(
    `SELECT (SELECT COUNT(*) FROM documents WHERE school_id = ? AND status = 'ready') AS school_docs,
            (SELECT COUNT(*) FROM documents WHERE school_id IS NULL AND status = 'ready') AS pal_docs,
            (SELECT COUNT(*) FROM pal_changes c WHERE c.changed_on >= date('now','-60 days')
               AND NOT EXISTS (SELECT 1 FROM change_acks a WHERE a.change_id = c.id AND a.school_id = ?)
               AND EXISTS (SELECT 1 FROM doc_links l JOIN documents d ON d.id = l.document_id WHERE l.pal_slug = c.slug AND d.school_id = ?)) AS alerts`,
    req.user.school_id, req.user.school_id, req.user.school_id
  );
  res.json({ user: req.user, school, counts, aiReady: aiReady(), hasAccounts, answerLength: userLength(req.user.id) });
});

function validateAccount(body: any): string | null {
  if (!str(body.name)) return "Enter your name.";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(str(body.email))) return "Enter a valid email address.";
  if (typeof body.password !== "string" || body.password.length < 10) return "Use a password of at least 10 characters.";
  if (one("SELECT 1 FROM users WHERE email = ?", str(body.email))) return "There's already an account with that email. Sign in instead.";
  return null;
}

api.post("/auth/signup-school", h((req, res) => {
  const b = req.body ?? {};
  const err = validateAccount(b);
  if (err) return bad(res, err);
  if (!str(b.schoolName)) return bad(res, "Enter your school's name.");
  const isFirst = !one("SELECT 1 FROM users LIMIT 1");
  const userId = tx(() => {
    const schoolId = Number(run(
      "INSERT INTO schools(name, school_type, suburb, join_code) VALUES (?, ?, ?, ?)",
      str(b.schoolName, 200), str(b.schoolType, 60) || null, str(b.suburb, 100) || null, newJoinCode()
    ).lastInsertRowid);
    return Number(run(
      "INSERT INTO users(school_id, email, name, password_hash, role, is_owner) VALUES (?, ?, ?, ?, 'admin', ?)",
      schoolId, str(b.email, 200), str(b.name, 120), hashPassword(b.password), isFirst ? 1 : 0
    ).lastInsertRowid);
  });
  startSession(res, userId);
  res.json({ ok: true });
}));

api.post("/auth/join", h((req, res) => {
  const b = req.body ?? {};
  const school = one<{ id: number }>("SELECT id FROM schools WHERE join_code = ?", str(b.code, 20).toUpperCase());
  if (!school) return bad(res, "That join code didn't match a school. Check it with your school's admin.");
  const err = validateAccount(b);
  if (err) return bad(res, err);
  const userId = Number(run(
    "INSERT INTO users(school_id, email, name, password_hash, role) VALUES (?, ?, ?, ?, 'staff')",
    school.id, str(b.email, 200), str(b.name, 120), hashPassword(b.password)
  ).lastInsertRowid);
  startSession(res, userId);
  res.json({ ok: true });
}));

api.post("/auth/login", h((req, res) => {
  const u = one<any>("SELECT id, password_hash FROM users WHERE email = ?", str(req.body?.email, 200));
  if (!u || !verifyPassword(String(req.body?.password ?? ""), u.password_hash)) {
    return bad(res, "That email and password don't match an account.", 401);
  }
  startSession(res, u.id);
  res.json({ ok: true });
}));

api.post("/auth/logout", (req, res) => {
  endSession(req, res);
  res.json({ ok: true });
});

// Everything below needs a signed-in user.
api.use(requireUser);

// ─── School profile & staff ──────────────────────────────────────────────────

api.get("/school", (req, res) => {
  const school = one<any>("SELECT * FROM schools WHERE id = ?", req.user!.school_id);
  if (req.user!.role !== "admin") delete school.join_code;
  const staff = all("SELECT id, name, email, role, created_at FROM users WHERE school_id = ? ORDER BY role, name", req.user!.school_id);
  res.json({ school, staff });
});

api.patch("/school", requireAdmin, (req, res) => {
  const b = req.body ?? {};
  if (b.name !== undefined && !str(b.name)) return bad(res, "Your school needs a name.");
  const fields = { name: str(b.name, 200), school_type: str(b.school_type, 60), suburb: str(b.suburb, 100), region: str(b.region, 100), website: str(b.website, 300), about: str(b.about, 2000) };
  for (const [k, v] of Object.entries(fields)) {
    if (b[k] !== undefined) run(`UPDATE schools SET ${k} = ? WHERE id = ?`, v || null, req.user!.school_id);
  }
  res.json({ ok: true });
});

api.post("/school/join-code", requireAdmin, (req, res) => {
  const code = newJoinCode();
  run("UPDATE schools SET join_code = ? WHERE id = ?", code, req.user!.school_id);
  res.json({ join_code: code });
});

api.patch("/school/staff/:id", requireAdmin, (req, res) => {
  const role = req.body?.role === "admin" ? "admin" : "staff";
  const target = one<any>("SELECT id FROM users WHERE id = ? AND school_id = ?", int(req.params.id), req.user!.school_id);
  if (!target) return bad(res, "Staff member not found.", 404);
  if (target.id === req.user!.id && role !== "admin") return bad(res, "You can't remove your own admin access.");
  run("UPDATE users SET role = ? WHERE id = ?", role, target.id);
  res.json({ ok: true });
});

api.delete("/school/staff/:id", requireAdmin, (req, res) => {
  const id = int(req.params.id);
  if (id === req.user!.id) return bad(res, "You can't remove your own account.");
  run("DELETE FROM users WHERE id = ? AND school_id = ? AND is_owner = 0", id, req.user!.school_id);
  res.json({ ok: true });
});

// ─── Documents ───────────────────────────────────────────────────────────────

const canSee = (doc: any, req: Request) => doc && (doc.school_id === null || doc.school_id === req.user!.school_id);

api.get("/documents", (req, res) => {
  const source = req.query.source === "pal" ? "pal" : "school";
  const q = str(req.query.q, 200);
  const where = [source === "pal" ? "d.school_id IS NULL" : "d.school_id = ?"];
  const params: any[] = source === "pal" ? [] : [req.user!.school_id];
  if (source === "pal") where.push("d.status = 'ready'");
  if (q) {
    where.push("(d.title LIKE ? OR d.summary LIKE ? OR d.pal_slug LIKE ?)");
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (str(req.query.category)) {
    where.push("d.category = ?");
    params.push(str(req.query.category));
  }
  const docs = all(
    `SELECT d.id, d.title, d.source, d.category, d.doc_type, d.audience, d.summary, d.status, d.error, d.reviewed_date,
            d.next_review, d.filename, d.url, d.word_count, d.updated_at, d.created_at, d.needs_ai
     FROM documents d WHERE ${where.join(" AND ")}
     ORDER BY ${source === "pal" ? "d.title COLLATE NOCASE" : "d.created_at DESC"} LIMIT 1000`,
    ...params
  );
  res.json({ documents: docs, categories: CATEGORIES, docTypes: DOC_TYPES, audiences: AUDIENCES });
});

api.get("/documents/:id", (req, res) => {
  const doc = one<any>("SELECT * FROM documents WHERE id = ?", int(req.params.id));
  if (!canSee(doc, req)) return bad(res, "Document not found.", 404);
  delete doc.file_path;
  doc.meta = doc.meta ? JSON.parse(doc.meta) : null;

  let related: any[] = [];
  let usedBy: any[] = [];
  let changes: any[] = [];
  if (doc.school_id !== null) {
    related = all(
      `SELECT l.pal_slug AS slug, d.id, d.title, d.reviewed_date,
              (SELECT MAX(changed_on) FROM pal_changes c WHERE c.slug = l.pal_slug) AS last_change
       FROM doc_links l JOIN documents d ON d.pal_slug = l.pal_slug WHERE l.document_id = ? ORDER BY l.score DESC`,
      doc.id
    );
  } else {
    usedBy = all(
      `SELECT d.id, d.title FROM doc_links l JOIN documents d ON d.id = l.document_id
       WHERE l.pal_slug = ? AND d.school_id = ? ORDER BY l.score DESC`,
      doc.pal_slug, req.user!.school_id
    );
    changes = all("SELECT changed_on, description FROM pal_changes WHERE slug = ? ORDER BY changed_on DESC LIMIT 8", doc.pal_slug);
  }
  res.json({ document: doc, related, usedBy, changes });
});

api.get("/documents/:id/file", (req, res) => {
  const doc = one<any>("SELECT school_id, file_path, filename FROM documents WHERE id = ?", int(req.params.id));
  if (!canSee(doc, req) || !doc.file_path || !fs.existsSync(doc.file_path)) return bad(res, "There's no original file for this document.", 404);
  res.download(doc.file_path, doc.filename ?? path.basename(doc.file_path));
});

/** Plain-English overview, generated on first view for PAL topics (school documents get one at upload). */
api.post("/documents/:id/overview", h(async (req, res) => {
  const doc = one<any>("SELECT id, school_id, title, body, overview, summary FROM documents WHERE id = ?", int(req.params.id));
  if (!canSee(doc, req)) return bad(res, "Document not found.", 404);
  if (doc.overview) return res.json({ overview: doc.overview });
  if (!aiReady()) return bad(res, "AI isn't set up yet, so there's no summary. The platform owner can add an API key in Settings.", 409);
  try {
    const out = await structured<{ summary: string; overview: string }>({
      system: `You write plain-English briefings on Victorian Department of Education policy (PAL) topics for school principals. Be accurate; never add requirements the text doesn't contain. Australian English.
Overview markdown shape:
### In short
2–3 sentences.
### What schools must do
Bullets of the mandatory requirements, quoting numbers, timeframes and roles exactly.
### Good practice
Bullets of recommended (non-mandatory) guidance, or "Not stated in the source."
### Who is responsible
Bullets naming roles.
### Where to get help
Contacts or resources named in the text, or "Not stated in the source."`,
      prompt: `<topic title="${doc.title}">\n${String(doc.body ?? "").slice(0, 600_000)}\n</topic>`,
      schema: {
        type: "object", additionalProperties: false, required: ["summary", "overview"],
        properties: { summary: { type: "string", description: "One sentence." }, overview: { type: "string" } },
      },
      effort: "low",
    });
    run("UPDATE documents SET overview = ?, summary = COALESCE(summary, ?) WHERE id = ?", out.overview, out.summary, doc.id);
    res.json({ overview: out.overview });
  } catch (err) {
    bad(res, friendlyAiError(err), 502);
  }
}));

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${kindFromName(file.originalname, file.mimetype) ?? ""}`),
  }),
  limits: { fileSize: 30 * 1024 * 1024, files: 50 },
  fileFilter: (_req, file, cb) => cb(null, !!kindFromName(file.originalname, file.mimetype)),
});

api.post("/documents/upload", requireAdmin, upload.array("files", 50), (req, res) => {
  const files = (req.files as Express.Multer.File[]) ?? [];
  if (!files.length) return bad(res, `Choose at least one file (${SUPPORTED.join(", ")}).`);
  const ids = files.map((f) => {
    const name = Buffer.from(f.originalname, "latin1").toString("utf8");
    const id = Number(run(
      "INSERT INTO documents(school_id, source, title, filename, mime, file_path, uploaded_by) VALUES (?, 'upload', '', ?, ?, ?, ?)",
      req.user!.school_id, name, kindFromName(name, f.mimetype), f.path, req.user!.id
    ).lastInsertRowid);
    enqueue(id);
    return id;
  });
  res.json({ ids });
});

api.patch("/documents/:id", requireAdmin, (req, res) => {
  const doc = one<any>("SELECT id FROM documents WHERE id = ? AND school_id = ?", int(req.params.id), req.user!.school_id);
  if (!doc) return bad(res, "Document not found.", 404);
  for (const k of ["title", "category", "doc_type", "audience", "reviewed_date", "next_review"]) {
    if (req.body?.[k] !== undefined) run(`UPDATE documents SET ${k} = ?, updated_at = datetime('now') WHERE id = ?`, str(req.body[k], 300) || null, doc.id);
  }
  res.json({ ok: true });
});

api.post("/documents/:id/reprocess", requireAdmin, (req, res) => {
  const doc = one<any>("SELECT id, file_path FROM documents WHERE id = ? AND school_id = ?", int(req.params.id), req.user!.school_id);
  if (!doc) return bad(res, "Document not found.", 404);
  if (doc.file_path) run("UPDATE documents SET body = NULL WHERE id = ?", doc.id);
  enqueue(doc.id);
  res.json({ ok: true });
});

api.delete("/documents/:id", requireAdmin, (req, res) => {
  const doc = one<any>("SELECT id, file_path FROM documents WHERE id = ? AND school_id = ?", int(req.params.id), req.user!.school_id);
  if (!doc) return bad(res, "Document not found.", 404);
  deleteDocument(doc.id);
  if (doc.file_path) fs.rm(doc.file_path, { force: true }, () => {});
  run("UPDATE discoveries SET status = 'new', document_id = NULL WHERE document_id = ?", doc.id);
  res.json({ ok: true });
});

// ─── Finding documents on the school website ─────────────────────────────────

api.get("/finder", (req, res) => {
  const job = one("SELECT * FROM jobs WHERE kind = 'finder' AND school_id = ? ORDER BY id DESC LIMIT 1", req.user!.school_id);
  const found = all(
    `SELECT x.*, d.status AS doc_status FROM discoveries x LEFT JOIN documents d ON d.id = x.document_id
     WHERE x.school_id = ? AND x.status != 'dismissed' ORDER BY x.status = 'imported', x.score DESC, x.title`,
    req.user!.school_id
  );
  res.json({ job, found, website: one<any>("SELECT website FROM schools WHERE id = ?", req.user!.school_id)?.website });
});

api.post("/finder/start", requireAdmin, (req, res) => {
  let url: string;
  try {
    url = normaliseSiteUrl(str(req.body?.url, 300));
  } catch (e) {
    return bad(res, e instanceof Error && e.message.startsWith("Enter") ? e.message : "That doesn't look like a web address.");
  }
  run("UPDATE schools SET website = ? WHERE id = ?", url, req.user!.school_id);
  try {
    res.json({ jobId: startFinder(req.user!.school_id, url) });
  } catch (e) {
    bad(res, e instanceof Error ? e.message : String(e), 409);
  }
});

api.post("/finder/import", requireAdmin, h(async (req, res) => {
  const ids: number[] = Array.isArray(req.body?.ids) ? req.body.ids.map(int).filter(Number.isFinite).slice(0, 100) : [];
  const results = [];
  for (const id of ids) {
    try {
      results.push({ id, documentId: await importDiscovery(req.user!.school_id, id, req.user!.id) });
    } catch (e) {
      results.push({ id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  res.json({ results });
}));

api.post("/finder/:id/dismiss", requireAdmin, (req, res) => {
  run("UPDATE discoveries SET status = 'dismissed' WHERE id = ? AND school_id = ?", int(req.params.id), req.user!.school_id);
  res.json({ ok: true });
});

// ─── Policy checklist ────────────────────────────────────────────────────────

api.get("/checklist", h(async (req, res) => {
  res.json({ items: await buildChecklist(req.user!.school_id) });
}));

api.put("/checklist/:key", requireAdmin, (req, res) => {
  const key = String(req.params.key);
  if (!CHECKLIST.some((i) => i.key === key)) return bad(res, "Unknown checklist item.", 404);
  const status = req.body?.status;
  if (status === "clear") {
    run("DELETE FROM checklist_marks WHERE school_id = ? AND item_key = ?", req.user!.school_id, key);
  } else if (status === "not_applicable" || status === "linked") {
    let docId: number | null = null;
    if (status === "linked") {
      docId = int(req.body?.documentId);
      if (!one("SELECT 1 FROM documents WHERE id = ? AND school_id = ?", docId, req.user!.school_id)) return bad(res, "Choose one of your school's documents.");
    }
    run(
      `INSERT INTO checklist_marks(school_id, item_key, document_id, status) VALUES (?, ?, ?, ?)
       ON CONFLICT(school_id, item_key) DO UPDATE SET document_id = excluded.document_id, status = excluded.status`,
      req.user!.school_id, key, docId, status
    );
  } else return bad(res, "Unknown status.");
  res.json({ ok: true });
});

// ─── PAL updates ─────────────────────────────────────────────────────────────

api.get("/updates", (req, res) => {
  const sid = req.user!.school_id;
  const changes = all<any>(
    `SELECT c.*, d.id AS document_id, EXISTS (SELECT 1 FROM change_acks a WHERE a.change_id = c.id AND a.school_id = ?) AS acked
     FROM pal_changes c LEFT JOIN documents d ON d.pal_slug = c.slug
     WHERE c.changed_on >= date('now', '-12 months') ORDER BY c.changed_on DESC, c.id DESC LIMIT 300`,
    sid
  );
  const affects = all<any>(
    `SELECT l.pal_slug, d.id, d.title FROM doc_links l JOIN documents d ON d.id = l.document_id WHERE d.school_id = ?`,
    sid
  );
  const bySlug = new Map<string, any[]>();
  for (const a of affects) bySlug.set(a.pal_slug, [...(bySlug.get(a.pal_slug) ?? []), { id: a.id, title: a.title }]);
  res.json({
    lastSync: getSetting("pal_last_sync"),
    changes: changes.map((c) => ({ ...c, acked: !!c.acked, affects: bySlug.get(c.slug) ?? [] })),
  });
});

api.post("/updates/:id/ack", (req, res) => {
  run("INSERT OR IGNORE INTO change_acks(school_id, change_id) VALUES (?, ?)", req.user!.school_id, int(req.params.id));
  res.json({ ok: true });
});

// ─── Conversations ───────────────────────────────────────────────────────────

const SCOPES = new Set(["all", "department", "school"]);

api.get("/conversations", (req, res) => {
  res.json({
    conversations: all(
      "SELECT id, title, scope, document_id, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100",
      req.user!.id
    ),
  });
});

api.post("/conversations", (req, res) => {
  const scope = SCOPES.has(req.body?.scope) ? req.body.scope : "all";
  const question = str(req.body?.question, 4000);
  let documentId: number | null = req.body?.documentId ? int(req.body.documentId) : null;
  let title = question ? question.slice(0, 90) : "New conversation";
  if (documentId) {
    const doc = one<any>("SELECT id, school_id, title FROM documents WHERE id = ?", documentId);
    if (!canSee(doc, req)) documentId = null;
    else if (!question) title = `About: ${doc.title}`;
  }
  const id = Number(run(
    "INSERT INTO conversations(school_id, user_id, title, scope, document_id) VALUES (?, ?, ?, ?, ?)",
    req.user!.school_id, req.user!.id, title, scope, documentId
  ).lastInsertRowid);
  res.json({ id });
});

api.get("/conversations/:id", (req, res) => {
  const c = one<any>(
    `SELECT c.*, d.title AS document_title FROM conversations c LEFT JOIN documents d ON d.id = c.document_id
     WHERE c.id = ? AND c.user_id = ?`,
    int(req.params.id), req.user!.id
  );
  if (!c) return bad(res, "Conversation not found.", 404);
  const messages = all<any>("SELECT id, role, content, sources, followups, created_at FROM messages WHERE conversation_id = ? ORDER BY id", c.id)
    .map((m) => ({ ...m, sources: m.sources ? JSON.parse(m.sources) : [], followups: m.followups ? JSON.parse(m.followups) : [] }));
  res.json({ conversation: c, messages });
});

api.patch("/conversations/:id", (req, res) => {
  const c = one<any>("SELECT id FROM conversations WHERE id = ? AND user_id = ?", int(req.params.id), req.user!.id);
  if (!c) return bad(res, "Conversation not found.", 404);
  if (SCOPES.has(req.body?.scope)) run("UPDATE conversations SET scope = ? WHERE id = ?", req.body.scope, c.id);
  if (str(req.body?.title)) run("UPDATE conversations SET title = ? WHERE id = ?", str(req.body.title, 120), c.id);
  res.json({ ok: true });
});

api.delete("/conversations/:id", (req, res) => {
  run("DELETE FROM conversations WHERE id = ? AND user_id = ?", int(req.params.id), req.user!.id);
  res.json({ ok: true });
});

api.post("/conversations/:id/ask", h(async (req, res) => {
  const question = str(req.body?.question, 4000);
  if (!question) return bad(res, "Type a question first.");
  await answer(res, req.user!, int(req.params.id), question);
}));

// ─── Platform (owner only): AI key and the shared PAL library ────────────────

api.get("/platform", requireOwner, (_req, res) => {
  const key = getSetting("anthropic_api_key");
  res.json({
    ai: { ready: aiReady(), source: key ? "settings" : process.env.ANTHROPIC_API_KEY ? "environment" : null, hint: key ? `…${key.slice(-4)}` : null },
    models: { answers: answerModel(), processing: processingModel(), options: Object.entries(MODELS).map(([id, m]) => ({ id, ...m })) },
    pal: {
      topics: one<any>("SELECT COUNT(*) AS n FROM pal_topics WHERE retired_at IS NULL AND document_id IS NOT NULL")?.n ?? 0,
      lastSync: getSetting("pal_last_sync"),
      running: palSyncRunning(),
    },
    job: one("SELECT * FROM jobs WHERE kind = 'pal_sync' ORDER BY id DESC LIMIT 1"),
    schools: one<any>("SELECT COUNT(*) AS n FROM schools")?.n ?? 0,
  });
});

api.put("/platform/key", requireOwner, h(async (req, res) => {
  const key = str(req.body?.key, 300);
  if (!key) {
    setSetting("anthropic_api_key", null);
    return res.json({ ok: true });
  }
  const previous = getSetting("anthropic_api_key");
  setSetting("anthropic_api_key", key);
  try {
    await claude()!.models.retrieve(answerModel());
  } catch (err) {
    setSetting("anthropic_api_key", previous);
    return bad(res, friendlyAiError(err));
  }
  recategorisePal().catch(() => {});
  res.json({ ok: true, retagging: retagPending() });
}));

api.post("/platform/pal-sync", requireOwner, (req, res) => {
  try {
    const limit = req.body?.limit ? Math.max(1, Math.min(1000, int(req.body.limit))) : undefined;
    res.json({ jobId: startPalSync({ full: !!req.body?.full, limit }) });
  } catch (e) {
    bad(res, e instanceof Error ? e.message : String(e), 409);
  }
});

api.get("/jobs/:id", (req, res) => {
  const job = one<any>("SELECT * FROM jobs WHERE id = ?", int(req.params.id));
  if (!job || (job.school_id !== null && job.school_id !== req.user!.school_id)) return bad(res, "Job not found.", 404);
  res.json({ job });
});

// ─── Personal preferences ────────────────────────────────────────────────────

api.patch("/me/preferences", (req, res) => {
  const length = req.body?.answerLength;
  if (!(length in LENGTHS)) return bad(res, "Choose short, normal or extended.");
  run("UPDATE users SET answer_length = ? WHERE id = ?", length, req.user!.id);
  res.json({ ok: true });
});

// ─── Model choice and side-by-side comparison (owner only) ───────────────────

api.put("/platform/models", requireOwner, (req, res) => {
  const { answers, processing } = req.body ?? {};
  if (answers !== undefined && !isModel(answers)) return bad(res, "Unknown model.");
  if (processing !== undefined && !isModel(processing)) return bad(res, "Unknown model.");
  if (answers) setSetting("model_answers", answers);
  if (processing) setSetting("model_processing", processing);
  res.json({ ok: true });
});

/** Answer one question with several models from the same sources, so the owner can judge quality and cost. */
api.post("/platform/compare", requireOwner, h(async (req, res) => {
  const question = str(req.body?.question, 2000);
  const models: string[] = Array.isArray(req.body?.models) ? req.body.models.filter(isModel).slice(0, 3) : [];
  if (!question) return bad(res, "Type a question to compare.");
  if (!models.length) return bad(res, "Choose at least one model.");
  const client = claude();
  if (!client) return bad(res, "Add an API key first.", 409);

  const length = userLength(req.user!.id);
  const passages = await retrieve(question, { schoolId: req.user!.school_id, scope: "all", k: LENGTHS[length].k, minK: LENGTHS[length].minK });
  if (!passages.length) return bad(res, "No policy passages matched that question, so there's nothing to compare.");

  const results = await Promise.all(
    models.map(async (model) => {
      const started = Date.now();
      try {
        const msg = await client.beta.messages
          .stream(buildAnswerRequest(model as keyof typeof MODELS, req.user!.school_id, question, [], passages, length))
          .finalMessage();
        const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
        return {
          model,
          label: MODELS[model as keyof typeof MODELS].label,
          text: splitFollowups(text).body,
          seconds: (Date.now() - started) / 1000,
          inputTokens: msg.usage.input_tokens + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0),
          outputTokens: msg.usage.output_tokens,
          cost: estimateCost(model as keyof typeof MODELS, msg.usage),
          refused: msg.stop_reason === "refusal",
        };
      } catch (err) {
        return { model, label: MODELS[model as keyof typeof MODELS].label, error: friendlyAiError(err) };
      }
    })
  );
  res.json({ sources: toSourceOut(passages), results, length });
}));
