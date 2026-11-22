/**
 * PAL sync — the Victorian Department of Education's Policy and Advisory Library.
 *
 * Discovery: sitemap.xml lists every PAL URL (~3,400) and ~455 topic roots, with <lastmod>.
 * Content:   /pal/{slug}/print-all renders a whole topic (all tabs and chapters) on one page.
 *            If print-all fails, fall back to the topic's own sitemap URLs.
 * Changes:   /pal/recently-updated is a table of every substantive change since June 2020,
 *            with PAL's own plain-English description — we store it as the change feed.
 * Dates:     only "Policy last updated" from the page body is shown as a review date.
 *            The "Date: 16 Mar 2020" block is the 2020 migration date and is ignored.
 * Politeness: one request at a time with a 600 ms gap; /js, /img, /_nuxt are never fetched.
 */
import * as cheerio from "cheerio";
import { all, one, run } from "./db.ts";
import { htmlToMarkdown, chunkMarkdown, wordCount, extract } from "./text.ts";
import { writeChunks, sha, CATEGORIES, linkToPal } from "./ingest.ts";
import { embed } from "./embed.ts";
import { aiReady, structured } from "./ai.ts";

const BASE = "https://www2.education.vic.gov.au";
const DELAY_MS = 600;
const UA = "PolicyPilot/2.0 (school policy assistant; polite crawler)";
const NOT_TOPICS = new Set(["recently-updated", "about-pal", "pal-help", "filter-az", "search", "js", "img", "_nuxt"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastRequest = 0;

async function politeFetch(url: string): Promise<Response> {
  const wait = lastRequest + DELAY_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequest = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    return await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,application/xml" }, signal: ctrl.signal, redirect: "follow" });
  } finally {
    clearTimeout(timer);
  }
}

// ─── Discovery ───────────────────────────────────────────────────────────────

interface Topic { slug: string; lastmod: string | null; urls: string[] }

export async function discoverTopics(): Promise<Topic[]> {
  const res = await politeFetch(`${BASE}/sitemap.xml`);
  if (!res.ok) throw new Error(`Couldn't read the PAL sitemap (HTTP ${res.status}).`);
  const $ = cheerio.load(await res.text(), { xml: true });
  const topics = new Map<string, Topic>();
  let palUrls = 0;
  $("url").each((_, el) => {
    const loc = $(el).find("loc").text().trim();
    const m = loc.match(/^https:\/\/www2\.education\.vic\.gov\.au\/pal\/([a-z0-9][a-z0-9-]*)(\/.*)?$/);
    if (!m) return;
    palUrls++;
    const slug = m[1];
    if (NOT_TOPICS.has(slug)) return;
    const lastmod = $(el).find("lastmod").text().trim() || null;
    const t = topics.get(slug) ?? { slug, lastmod: null, urls: [] };
    t.urls.push(loc);
    if (lastmod && (!t.lastmod || lastmod > t.lastmod)) t.lastmod = lastmod;
    topics.set(slug, t);
  });
  // Health check: a big swing means the site changed shape — stop rather than retire half of PAL.
  if (palUrls < 3000 || palUrls > 4500) {
    throw new Error(`The PAL sitemap listed ${palUrls} pages (expected about 3,400). The site may have changed, so the sync stopped.`);
  }
  return [...topics.values()];
}

// ─── Parsing a topic ─────────────────────────────────────────────────────────

export interface PalMeta {
  scope: string[];
  policyUpdated: string | null;
  related: Array<{ slug: string; title: string }>;
  chapters: string[];
  contacts: string[];
  url: string;
  /** Publicly downloadable files linked from the topic (staff-login SharePoint links are left out). */
  attachments?: Array<{ url: string; title: string }>;
}

// Hosts that need a Department login, so their files can't be fetched.
const LOGIN_HOSTS = /(^|\.)(sharepoint\.com|edugate\.eduweb\.vic\.gov\.au|arc\.educationapps\.vic\.gov\.au)$/i;

function cleanLinkText(s: string) {
  return s
    .replace(/\((pdf|docx?|xlsx?|pptx?)[^)]*\)/gi, "")
    .replace(/\((staff login required|opens in a new (window|tab))\)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseAttachments($: cheerio.CheerioAPI): PalMeta["attachments"] {
  const seen = new Map<string, { url: string; title: string }>();
  $("a[href]").each((_, a) => {
    const raw = $(a).attr("href") ?? "";
    const text = $(a).text().replace(/\s+/g, " ").trim();
    if (/staff login required/i.test(text)) return;
    let u: URL;
    try { u = new URL(raw, BASE); } catch { return; }
    if (!/\.(pdf|docx)$/i.test(u.pathname)) return;
    if (!u.hostname.endsWith(".vic.gov.au") || LOGIN_HOSTS.test(u.hostname)) return;
    const title = cleanLinkText(text) || decodeURIComponent(u.pathname.split("/").pop() ?? "").replace(/\.(pdf|docx)$/i, "");
    if (!seen.has(u.href) && title.length > 2) seen.set(u.href, { url: u.href, title });
  });
  return [...seen.values()];
}

function parseTopicPage(html: string, slug: string, url: string): { title: string; body: string; meta: PalMeta } {
  const $ = cheerio.load(html);
  const title = $("h1").first().text().replace(/\s+/g, " ").trim() || slug;

  let policyUpdated: string | null = null;
  const scope: string[] = [];
  $(".det-sidebar-info__block").each((_, b) => {
    const h = $(b).find(".det-sidebar-info__heading").text().trim().toLowerCase();
    if (h.includes("last updated")) policyUpdated = $(b).find(".det-sidebar-info__value").text().trim() || null;
    if (h === "scope") $(b).find("li").each((_, li) => { scope.push($(li).text().trim()); });
  });

  const related: PalMeta["related"] = [];
  $("h2, h3").filter((_, h) => /related polic/i.test($(h).text())).each((_, h) => {
    $(h).nextUntil("h2, h3").find("a[href]").each((_, a) => {
      const m = ($(a).attr("href") ?? "").match(/\/pal\/([a-z0-9-]+)/);
      if (m && m[1] !== slug) related.push({ slug: m[1], title: $(a).text().trim() });
    });
  });

  const contacts = [...new Set($("a[href^='mailto:']").map((_, a) => $(a).attr("href")!.slice(7).trim()).get())].slice(0, 12);

  const chapters: string[] = [];
  const parts: string[] = [];
  const headers = $(".tide-chapter-print-header");
  if (headers.length) {
    headers.each((_, h) => {
      const chapter = $(h).find("h2, h1").first().text().replace(/\s+/g, " ").trim();
      const container = $(h).parent();
      const md = container
        .find(".rpl-content")
        .map((_, c) => htmlToMarkdown($.html(c)))
        .get()
        .join("\n\n");
      if (!md.trim()) return;
      chapters.push(chapter);
      // Inner headings that just repeat the chapter name add noise.
      parts.push(`# ${chapter}\n\n${md.replace(new RegExp(`^#+ ${escapeRe(chapter)}\\s*\\n`, "i"), "")}`);
    });
  } else {
    const main = $("#rpl-main, main").first();
    parts.push(htmlToMarkdown($.html(main.length ? main : $("body"))));
  }

  return {
    title,
    body: parts.join("\n\n").trim(),
    meta: { scope, policyUpdated, related: dedupe(related), chapters, contacts, url, attachments: parseAttachments($) },
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const dedupe = <T extends { slug: string }>(xs: T[]) => [...new Map(xs.map((x) => [x.slug, x])).values()];

async function fetchTopic(t: Topic): Promise<{ title: string; body: string; meta: PalMeta } | "gone" | null> {
  const printAll = `${BASE}/pal/${t.slug}/print-all`;
  const res = await politeFetch(printAll);
  if (res.status === 404 && t.urls.length === 0) return "gone";
  if (res.ok) {
    const parsed = parseTopicPage(await res.text(), t.slug, `${BASE}/pal/${t.slug}`);
    if (wordCount(parsed.body) > 40) return parsed;
  }
  // Fallback: stitch together the topic's own pages from the sitemap.
  const pages = t.urls.filter((u) => !/\.(pdf|docx?|xlsx?|pptx?|zip)$/i.test(u)).slice(0, 30);
  let title = "";
  const bodies: string[] = [];
  let meta: PalMeta | null = null;
  for (const url of pages) {
    const r = await politeFetch(url);
    if (!r.ok) continue;
    const p = parseTopicPage(await r.text(), t.slug, `${BASE}/pal/${t.slug}`);
    title ||= p.title;
    if (!meta) meta = p.meta;
    else meta.attachments = [...new Map([...(meta.attachments ?? []), ...(p.meta.attachments ?? [])].map((a) => [a.url, a])).values()];
    const tab = url.split(`/pal/${t.slug}`)[1]?.split("/").filter(Boolean).pop() ?? "Overview";
    if (wordCount(p.body) > 20) bodies.push(`# ${tab.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase())}\n\n${p.body}`);
  }
  if (!bodies.length || !meta) return null;
  return { title, body: bodies.join("\n\n"), meta };
}

// ─── Change feed from /pal/recently-updated ──────────────────────────────────

export async function syncChangeFeed(): Promise<number> {
  const res = await politeFetch(`${BASE}/pal/recently-updated`);
  if (!res.ok) return 0;
  const $ = cheerio.load(await res.text());
  let added = 0;
  $("table tbody tr").each((_, tr) => {
    const cells = $(tr).children("td");
    if (cells.length < 3) return;
    const date = toIsoDate($(cells[0]).text().trim());
    const description = $(cells[2]).text().replace(/\s+/g, " ").trim();
    $(cells[1]).find("a[href]").each((_, a) => {
      const m = ($(a).attr("href") ?? "").match(/\/pal\/([a-z0-9-]+)/);
      if (!m) return;
      const r = run(
        "INSERT OR IGNORE INTO pal_changes(slug, title, kind, description, changed_on) VALUES (?, ?, 'updated', ?, ?)",
        m[1], $(a).text().replace(/\s+/g, " ").trim(), description, date
      );
      added += Number(r.changes);
    });
  });
  return added;
}

const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];
export function toIsoDate(s: string): string | null {
  const m = s.trim().match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (!m) return null;
  const mi = MONTHS.findIndex((x) => x.startsWith(m[2].toLowerCase().slice(0, 3)));
  if (mi < 0) return null;
  return `${m[3]}-${String(mi + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

// ─── Categorising topics ─────────────────────────────────────────────────────

const CATEGORY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["category", "summary"],
  properties: {
    category: { type: "string", enum: [...CATEGORIES] },
    summary: { type: "string", description: "One plain sentence saying what this PAL topic requires of schools." },
  },
};

// Used only when no AI key is set: describe each category so the local model can estimate a match.
const CATEGORY_HINTS: Record<string, string> = {
  "Human resources": "staff employment, recruitment, leave, pay, salaries, teacher registration, performance and development, staff conduct",
  "Finance and procurement": "school budgets, funding, purchasing, procurement, parent payments, fundraising, finance manual, insurance",
  "Student health, safety, wellbeing and engagement": "student wellbeing, medical conditions, allergies, anaphylaxis, asthma, first aid, medication, behaviour, bullying, child safety, mental health, students with disability",
  "Infrastructure and facilities": "school buildings, grounds, maintenance, capital works, construction, asbestos, fences, facilities",
  "Occupational health and safety": "workplace health and safety for staff, hazards, OHS risk management, manual handling, incidents, contractors",
  "School operations and student administration": "enrolment, attendance, school hours, school dates, student records, excursions, transport, school operations",
  "School councils": "school council governance, council elections, council meetings, council powers, office bearers",
  "Learning, teaching, curriculum and improvement": "curriculum, teaching, assessment, reporting student achievement, homework, school improvement, strategic plan, languages",
  "Information management, security and technology": "ICT, technology, information security, privacy, records management, digital devices, software, data",
};
let categoryVectors: Float32Array[] | null = null;

async function categorise(title: string, body: string): Promise<{ category: string; summary: string | null; estimated?: boolean }> {
  if (aiReady()) {
    try {
      return await structured<{ category: string; summary: string }>({
        system: "You classify topics from the Victorian Department of Education's Policy and Advisory Library (PAL) into PAL's own nine categories. Write the summary in Australian English for a busy principal.",
        prompt: `Topic: ${title}\n\n${body.slice(0, 6000)}`,
        schema: CATEGORY_SCHEMA,
        effort: "low",
        maxTokens: 2000,
      });
    } catch {
      // fall through to the local estimate
    }
  }
  categoryVectors ??= await embed(CATEGORIES.map((c) => `${c}: ${CATEGORY_HINTS[c]}`));
  const [v] = await embed([`${title}. ${body.slice(0, 600)}`]);
  let best = 0;
  let bestScore = -1;
  categoryVectors.forEach((c, i) => {
    let s = 0;
    for (let j = 0; j < c.length; j++) s += c[j] * v[j];
    if (s > bestScore) { bestScore = s; best = i; }
  });
  return { category: CATEGORIES[best], summary: null, estimated: true };
}

/** Once an AI key is added, replace locally estimated categories with AI ones (and add summaries). */
export async function recategorisePal() {
  if (!aiReady()) return;
  const rows = all<{ id: number; title: string; body: string }>("SELECT id, title, body FROM documents WHERE source = 'pal' AND parent_id IS NULL AND needs_ai = 1 AND status = 'ready'");
  for (const r of rows) {
    const c = await categorise(r.title, r.body ?? "");
    if (c.estimated) break; // AI unavailable — stop and try again later
    run("UPDATE documents SET category = ?, summary = COALESCE(summary, ?), needs_ai = 0 WHERE id = ?", c.category, c.summary, r.id);
  }
}

// ─── The sync job ────────────────────────────────────────────────────────────

let running = false;
export const palSyncRunning = () => running;

function job(id: number, patch: { done?: number; total?: number; message?: string; status?: string; result?: string }) {
  const sets = Object.keys(patch).map((k) => `${k} = ?`);
  if (patch.status && patch.status !== "running") sets.push("finished_at = datetime('now')");
  run(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`, ...Object.values(patch), id);
}

/** Full or incremental sync. Incremental re-crawls topics whose sitemap <lastmod> moved. */
export function startPalSync(opts: { full?: boolean; limit?: number } = {}): number {
  if (running) throw new Error("A PAL sync is already running.");
  running = true;
  const jobId = Number(run("INSERT INTO jobs(kind, message) VALUES ('pal_sync', 'Reading the PAL sitemap…')").lastInsertRowid);
  palSync(jobId, opts)
    .catch((err) => job(jobId, { status: "failed", message: err instanceof Error ? err.message : String(err) }))
    .finally(() => { running = false; });
  return jobId;
}

async function palSync(jobId: number, opts: { full?: boolean; limit?: number }) {
  const topics = await discoverTopics();
  // The change feed is a single page, so read it first and the Updates page fills in straight away.
  job(jobId, { message: "Reading PAL's list of recent changes…" });
  await syncChangeFeed().catch(() => 0);
  const known = new Map(all<{ slug: string; sitemap_lastmod: string | null; retired_at: string | null; document_id: number | null }>(
    "SELECT slug, sitemap_lastmod, retired_at, document_id FROM pal_topics"
  ).map((r) => [r.slug, r]));
  // Topics found while the library is first being loaded aren't "new on PAL".
  const firstRun = !one("SELECT 1 FROM settings WHERE key = 'pal_last_sync'");

  let todo = topics.filter((t) => {
    const k = known.get(t.slug);
    return opts.full || !k || !k.document_id || k.retired_at || (t.lastmod && (!k.sitemap_lastmod || t.lastmod > k.sitemap_lastmod));
  });
  if (opts.limit) todo = todo.slice(0, opts.limit);
  job(jobId, { total: todo.length, message: `${topics.length} topics on PAL. ${todo.length} to fetch.` });

  let done = 0, added = 0, updated = 0, unchanged = 0, failed = 0;
  for (const t of todo) {
    job(jobId, { done, message: `Reading ${t.slug.replace(/-/g, " ")}` });
    try {
      const got = await fetchTopic(t);
      if (got === "gone" || got === null) {
        failed++;
      } else {
        const outcome = await saveTopic(t, got, firstRun);
        if (outcome === "added") added++;
        else if (outcome === "updated") updated++;
        else unchanged++;
      }
    } catch {
      failed++;
    }
    done++;
  }

  // Retire topics that have left the sitemap (only on unlimited runs).
  let retired = 0;
  if (!opts.limit) {
    const live = new Set(topics.map((t) => t.slug));
    for (const [slug, k] of known) {
      if (live.has(slug) || k.retired_at) continue;
      retired++;
      run("UPDATE pal_topics SET retired_at = datetime('now') WHERE slug = ?", slug);
      if (k.document_id) {
        // The topic and its attached guides stop appearing in answers.
        const ids = [k.document_id, ...all<{ id: number }>("SELECT id FROM documents WHERE parent_id = ?", k.document_id).map((r) => r.id)];
        for (const id of ids) {
          await writeChunks(id, null, slug, []);
          run("UPDATE documents SET status = 'error', error = 'This topic has been retired from PAL.', updated_at = datetime('now') WHERE id = ?", id);
        }
      }
      const title = one<{ title: string }>("SELECT title FROM pal_topics WHERE slug = ?", slug)?.title ?? slug;
      run("INSERT OR IGNORE INTO pal_changes(slug, title, kind, description, changed_on) VALUES (?, ?, 'retired', 'This topic is no longer listed on PAL.', date('now'))", slug, title);
    }
  }

  const files = await syncAttachments(jobId);

  if (aiReady()) {
    job(jobId, { message: "Sorting topics into PAL categories…" });
    await recategorisePal().catch(() => {});
  }
  // School documents may now link to newly added topics.
  if (added) {
    for (const { id } of all<{ id: number }>("SELECT id FROM documents WHERE school_id IS NOT NULL AND status = 'ready'")) linkToPal(id);
  }

  const summary = { added, updated, unchanged, failed, retired, files };
  run("INSERT INTO settings(key, value) VALUES ('pal_last_sync', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  job(jobId, {
    done,
    status: "done",
    result: JSON.stringify(summary),
    message:
      `Finished: ${added} new, ${updated} updated, ${unchanged} unchanged${failed ? `, ${failed} couldn't be read` : ""}${retired ? `, ${retired} retired` : ""}.` +
      (files.added || files.removed ? ` Guides: ${files.added} added${files.removed ? `, ${files.removed} removed` : ""}.` : ""),
  });
}

// ─── Attached guides ─────────────────────────────────────────────────────────

/**
 * Which linked files are worth reading. Guides, fact sheets and procedures help answers;
 * blank forms, templates and registers mostly add noise.
 */
const GUIDE = /\b(guid(e|es|ance|elines)|fact ?sheets?|procedures?|advice|overview|information|faqs?|frequently asked|handbook|framework|toolkit|manual|explainer|q ?& ?a|principles|standards|strateg(y|ies)|protocols?|policy|summary|resource|requirements|roles and responsibilities)\b/i;
const STRONG_GUIDE = /\b(guid(e|es|ance|elines)|fact ?sheets?|faqs?|frequently asked|handbook|manual|toolkit|explainer)\b/i;
const NOT_GUIDE = /\b(form|forms|template|templates|checklist|register|log|application|order|declaration|consent|agreement|letter|poster|certificate|record sheet|spreadsheet|calculator|invoice|claim|sample|proforma|pro forma|timetable|list)\b/i;

export function isGuide(title: string, url: string): boolean {
  const text = `${title} ${decodeURIComponent(url.split("/").pop() ?? "").replace(/[_-]+/g, " ")}`;
  if (STRONG_GUIDE.test(text)) return true;
  if (NOT_GUIDE.test(text)) return false;
  if (GUIDE.test(text)) return true;
  // Unlabelled PDFs are usually publications; unlabelled Word files are usually templates.
  return /\.pdf$/i.test(url);
}

const MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * Make sure each PAL topic's public guides are in the library. Topics read before attachments were
 * tracked get their page fetched again once; after that the list comes with each topic sync.
 */
export async function syncAttachments(jobId: number): Promise<{ added: number; removed: number; skipped: number; loginOnly: number }> {
  const topics = all<{ id: number; title: string; pal_slug: string; category: string | null; meta: string }>(
    "SELECT id, title, pal_slug, category, meta FROM documents WHERE source = 'pal' AND parent_id IS NULL AND status = 'ready'"
  );
  let added = 0, removed = 0, skipped = 0, loginOnly = 0, checked = 0;
  job(jobId, { done: 0, total: topics.length, message: "Checking PAL topics for guides…" });

  for (const t of topics) {
    checked++;
    const meta = JSON.parse(t.meta) as PalMeta;
    if (!meta.attachments) {
      job(jobId, { done: checked, message: `Looking for guides in ${t.title}` });
      try {
        const res = await politeFetch(`${BASE}/pal/${t.pal_slug}/print-all`);
        if (!res.ok) continue;
        const html = await res.text();
        meta.attachments = parseAttachments(cheerio.load(html)) ?? [];
        loginOnly += (html.match(/staff login required/gi) ?? []).length;
        run("UPDATE documents SET meta = ? WHERE id = ?", JSON.stringify(meta), t.id);
      } catch {
        continue;
      }
    }

    const wanted = (meta.attachments ?? []).filter((a) => isGuide(a.title, a.url));
    skipped += (meta.attachments?.length ?? 0) - wanted.length;
    const have = new Map(all<{ id: number; url: string }>("SELECT id, url FROM documents WHERE parent_id = ?", t.id).map((r) => [r.url, r.id]));

    // Guides the topic no longer links to.
    for (const [url, id] of have) {
      if (!wanted.some((a) => a.url === url)) {
        await writeChunks(id, null, "", []);
        run("DELETE FROM documents WHERE id = ?", id);
        removed++;
      }
    }

    for (const a of wanted) {
      if (have.has(a.url)) continue;
      // The same file is often linked from several topics; keep it once.
      if (one("SELECT 1 FROM documents WHERE url = ? AND parent_id IS NOT NULL", a.url)) continue;
      job(jobId, { done: checked, message: `Reading "${a.title}"` });
      try {
        const res = await politeFetch(a.url);
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_FILE_BYTES) continue;
        const kind = /\.docx$/i.test(a.url) ? ".docx" : ".pdf";
        const body = await extract(buf, kind);
        if (wordCount(body) < 120) continue; // blank forms and scans
        // The same guide is sometimes published at two addresses.
        if (one("SELECT 1 FROM documents WHERE parent_id IS NOT NULL AND content_hash = ?", sha(body))) continue;
        const id = Number(run(
          `INSERT INTO documents(school_id, source, parent_id, title, url, mime, category, status, body, word_count, content_hash)
           VALUES (NULL, 'pal', ?, ?, ?, ?, ?, 'processing', ?, ?, ?)`,
          t.id, a.title.slice(0, 250), a.url, kind, t.category, body, wordCount(body), sha(body)
        ).lastInsertRowid);
        await writeChunks(id, null, `${a.title} (${t.title})`, chunkMarkdown(body));
        run("UPDATE documents SET status = 'ready' WHERE id = ?", id);
        added++;
      } catch {
        // Unreadable file: leave it out.
      }
    }
  }
  return { added, removed, skipped, loginOnly };
}

async function saveTopic(t: Topic, got: { title: string; body: string; meta: PalMeta }, firstRun: boolean): Promise<"added" | "updated" | "unchanged"> {
  const hash = sha(got.body);
  const existing = one<{ id: number; content_hash: string; category: string | null }>(
    "SELECT id, content_hash, category FROM documents WHERE pal_slug = ?", t.slug
  );
  const reviewed = got.meta.policyUpdated ? toIsoDate(got.meta.policyUpdated) ?? got.meta.policyUpdated : null;

  if (existing && existing.content_hash === hash) {
    run("UPDATE pal_topics SET sitemap_lastmod = ?, last_crawled = datetime('now'), retired_at = NULL WHERE slug = ?", t.lastmod, t.slug);
    run("UPDATE documents SET reviewed_date = ?, meta = ?, status = 'ready', error = NULL WHERE id = ?", reviewed, JSON.stringify(got.meta), existing.id);
    return "unchanged";
  }

  const { category, summary, estimated } = existing?.category ? { category: existing.category, summary: null, estimated: false } : await categorise(got.title, got.body);
  let docId = existing?.id;
  if (!docId) {
    docId = Number(run(
      `INSERT INTO documents(school_id, source, title, url, pal_slug, category, summary, status, reviewed_date, meta, body, word_count, content_hash, needs_ai)
       VALUES (NULL, 'pal', ?, ?, ?, ?, ?, 'processing', ?, ?, ?, ?, ?, ?)`,
      got.title, got.meta.url, t.slug, category, summary, reviewed, JSON.stringify(got.meta), got.body, wordCount(got.body), hash, estimated ? 1 : 0
    ).lastInsertRowid);
  } else {
    run(
      `UPDATE documents SET title = ?, url = ?, reviewed_date = ?, meta = ?, body = ?, word_count = ?, content_hash = ?,
         overview = NULL, summary = COALESCE(?, summary), status = 'processing', updated_at = datetime('now') WHERE id = ?`,
      got.title, got.meta.url, reviewed, JSON.stringify(got.meta), got.body, wordCount(got.body), hash, summary, docId
    );
  }

  await writeChunks(docId, null, got.title, chunkMarkdown(got.body));
  run("UPDATE documents SET status = 'ready', error = NULL WHERE id = ?", docId);
  run(
    `INSERT INTO pal_topics(slug, title, sitemap_lastmod, document_id, content_hash, last_crawled) VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(slug) DO UPDATE SET title = excluded.title, sitemap_lastmod = excluded.sitemap_lastmod, document_id = excluded.document_id,
       content_hash = excluded.content_hash, last_crawled = excluded.last_crawled, retired_at = NULL`,
    t.slug, got.title, t.lastmod, docId, hash
  );
  if (!existing && !firstRun) {
    run("INSERT OR IGNORE INTO pal_changes(slug, title, kind, description, changed_on) VALUES (?, ?, 'new', 'New topic added to PAL.', date('now'))", t.slug, got.title);
  }
  return existing ? "updated" : "added";
}

/** Weekly incremental sync, once the library has been loaded the first time. */
export function scheduleWeeklySync() {
  const check = () => {
    const last = one<{ value: string }>("SELECT value FROM settings WHERE key = 'pal_last_sync'")?.value;
    if (!last || running) return;
    if (Date.now() - Date.parse(last + "Z") > 7 * 86_400_000) {
      try { startPalSync(); } catch { /* already running */ }
    }
  };
  setInterval(check, 6 * 3_600_000).unref();
  setTimeout(check, 60_000).unref();
}
