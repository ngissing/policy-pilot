/**
 * Finds policy documents on a school's public website so admins can import them in a few clicks.
 * Polite: one request at a time, honours robots.txt Disallow rules, crawls only the school's own site
 * (linked PDFs may live on a CDN), and never fetches private network addresses.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import * as cheerio from "cheerio";
import { one, run } from "./db.ts";
import { UPLOAD_DIR } from "./db.ts";
import { htmlToMarkdown, kindFromName, titleFromFilename } from "./text.ts";
import { enqueue } from "./ingest.ts";

const UA = "PolicyPilot/2.0 (finds a school's published policies at the school's request)";
const MAX_PAGES = 150;
const DELAY_MS = 400;
const MAX_FILE_BYTES = 30 * 1024 * 1024;
// Document hosts that need a login or return a viewer page instead of the file.
const GATED_HOSTS = /(^|\.)(sharepoint\.com|google\.com|onedrive\.live\.com|1drv\.ms|dropbox\.com|box\.com)$/i;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const POSITIVE: Array<[RegExp, number]> = [
  [/\bpolic(y|ies)\b/i, 4],
  [/\bprocedures?\b/i, 3],
  [/child[\s-]?safe|child safety|wellbeing|engagement|bullying|anaphylaxis|asthma|first aid|medication|duty of care|complaints?|privacy|attendance|enrol|camps?|excursions?|mobile phones?|digital (learning|technologies)|visitors?|volunteers?|yard duty|supervision|dress code|uniform|parent payments?|inclusion|diversity|statement of values|code of conduct|health care|sun ?smart|homework|assessment|reporting|emergency|critical incident/i, 2],
  [/\b(guidelines?|handbook|framework|plan|statement|register|charter)\b/i, 1],
];
const NEGATIVE = /newsletter|calendar|booklist|book list|menu|canteen order|timetable|term dates|photo|gallery|careers? expo|annual report|minutes|agenda|job|vacanc|tender|enrolment form|application form|order form/i;

function score(text: string): number {
  let s = 0;
  for (const [re, w] of POSITIVE) if (re.test(text)) s += w;
  if (NEGATIVE.test(text)) s -= 4;
  return s;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sameSite(a: URL, b: URL) {
  const strip = (h: string) => h.replace(/^www\./, "");
  return strip(a.hostname) === strip(b.hostname);
}

/** Only fetch public internet addresses — never the server's own network. */
function isPrivateIp(ip: string): boolean {
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

async function isPublicUrl(url: string): Promise<boolean> {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return false;
    const addrs = await dns.lookup(u.hostname, { all: true });
    return addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address));
  } catch {
    return false;
  }
}

async function get(url: string, accept = "text/html,application/xhtml+xml"): Promise<Response | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    // Follow redirects by hand so every hop is checked.
    let current = url;
    for (let hop = 0; hop < 6; hop++) {
      if (!(await isPublicUrl(current))) return null;
      const res = await fetch(current, { headers: { "User-Agent": UA, Accept: accept }, signal: ctrl.signal, redirect: "manual" });
      const next = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!next) return Object.defineProperty(res, "url", { value: current });
      current = new URL(next, current).href;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function robotsRules(origin: string): Promise<string[]> {
  const res = await get(`${origin}/robots.txt`, "text/plain");
  if (!res?.ok) return [];
  const rules: string[] = [];
  let applies = false;
  for (const raw of (await res.text()).split("\n")) {
    const line = raw.split("#")[0].trim();
    const [k, ...rest] = line.split(":");
    const v = rest.join(":").trim();
    if (/^user-agent$/i.test(k)) applies = v === "*";
    else if (applies && /^disallow$/i.test(k) && v) rules.push(v);
  }
  return rules;
}

export function normaliseSiteUrl(input: string): string {
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  if (!/^https?:$/.test(u.protocol)) throw new Error("Enter a web address starting with http or https.");
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/.test(u.hostname)) throw new Error("Enter your school's public website address.");
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/$/, "")}`;
}

export function startFinder(schoolId: number, siteUrl: string): number {
  const running = one("SELECT id FROM jobs WHERE kind = 'finder' AND school_id = ? AND status = 'running'", schoolId);
  if (running) throw new Error("A website search is already running for your school.");
  const jobId = Number(run("INSERT INTO jobs(kind, school_id, total, message) VALUES ('finder', ?, ?, 'Starting…')", schoolId, MAX_PAGES).lastInsertRowid);
  crawl(jobId, schoolId, siteUrl).catch((err) => {
    run("UPDATE jobs SET status = 'failed', message = ?, finished_at = datetime('now') WHERE id = ?", err instanceof Error ? err.message : String(err), jobId);
  });
  return jobId;
}

async function crawl(jobId: number, schoolId: number, siteUrl: string) {
  const start = new URL(siteUrl);
  const disallow = await robotsRules(start.origin);
  const blocked = (u: URL) => disallow.some((rule) => u.pathname.startsWith(rule));

  const seen = new Set<string>();
  // Higher-scoring links are visited first so policy pages are reached early.
  const frontier: Array<{ url: string; priority: number }> = [{ url: start.href, priority: 100 }];
  let pages = 0;
  let lastFoundAt = 0;
  const foundUrls = new Set<string>();

  const remember = (url: string, title: string, kind: string, foundOn: string, s: number) => {
    run(
      `INSERT INTO discoveries(school_id, url, title, kind, found_on, score) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(school_id, url) DO UPDATE SET score = MAX(score, excluded.score)`,
      schoolId, url, title.slice(0, 200), kind, foundOn, s
    );
    if (!foundUrls.has(url)) {
      foundUrls.add(url);
      lastFoundAt = pages;
    }
  };

  // Stop early once a long stretch of pages turns up nothing new.
  while (frontier.length && pages < MAX_PAGES && !(foundUrls.size > 0 && pages - lastFoundAt > 50)) {
    frontier.sort((a, b) => b.priority - a.priority);
    const { url } = frontier.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    await sleep(DELAY_MS);
    const res = await get(url);
    pages++;
    run("UPDATE jobs SET done = ?, message = ? WHERE id = ?", pages, `Checked ${plural(pages, "page")}, found ${plural(foundUrls.size, "likely document")}`, jobId);
    if (!res?.ok || !(res.headers.get("content-type") ?? "").includes("html")) continue;
    const finalUrl = new URL(res.url || url);
    if (!sameSite(finalUrl, start)) continue;

    const $ = cheerio.load(await res.text());
    const pageTitle = $("title").text().trim() || $("h1").first().text().trim();

    // The page itself may be a policy published as a web page.
    const h1 = $("h1").first().text().trim();
    const pageScore = score(`${h1} ${finalUrl.pathname}`);
    if (pageScore >= 4 && finalUrl.href !== start.href) {
      const words = $("main, article, body").first().text().split(/\s+/).length;
      if (words > 250) remember(finalUrl.href, h1 || pageTitle, "page", finalUrl.href, pageScore);
    }

    $("a[href]").each((_, a) => {
      const href = $(a).attr("href") ?? "";
      if (/^(mailto|tel|javascript):/i.test(href)) return;
      let u: URL;
      try { u = new URL(href, finalUrl); } catch { return; }
      u.hash = "";
      if (!/^https?:$/.test(u.protocol)) return;
      const linkText = $(a).text().replace(/\s+/g, " ").trim() || $(a).attr("title") || "";
      const ext = kindFromName(u.pathname);
      // Files linked from the school's site count even when hosted elsewhere (many schools use a CDN).
      if (ext === ".pdf" || ext === ".docx") {
        if (GATED_HOSTS.test(u.hostname)) return;
        const raw = linkText.length > 3 ? linkText : decodeURIComponent(path.basename(u.pathname));
        const label = /\.(pdf|docx)\s*$/i.test(raw) ? titleFromFilename(raw) : raw;
        const s = score(`${label} ${decodeURIComponent(u.pathname)}`);
        if (s >= 2) remember(u.href, label, ext.slice(1), finalUrl.href, s);
        return;
      }
      if (!sameSite(u, start) || blocked(u)) return;
      if (/\.(jpe?g|png|gif|svg|webp|mp4|mp3|zip|xlsx?|pptx?|ics|css|js)$/i.test(u.pathname)) return;
      if (!seen.has(u.href) && frontier.length < 2000) {
        frontier.push({ url: u.href, priority: score(`${linkText} ${u.pathname}`) * 10 - u.pathname.split("/").length });
      }
    });
  }

  run(
    "UPDATE jobs SET status = 'done', done = total, message = ?, finished_at = datetime('now') WHERE id = ?",
    `Checked ${plural(pages, "page")} and found ${plural(foundUrls.size, "likely policy document")}.`,
    jobId
  );
}

/** Download a discovered document and send it through the normal processing pipeline. */
export async function importDiscovery(schoolId: number, discoveryId: number, userId: number): Promise<number> {
  const d = one<any>("SELECT * FROM discoveries WHERE id = ? AND school_id = ?", discoveryId, schoolId);
  if (!d) throw new Error("That document is no longer in the list.");
  if (d.document_id) return d.document_id;

  const res = await get(d.url, "*/*");
  if (!res?.ok) throw new Error(`Couldn't download it (the website returned ${res?.status ?? "no response"}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_FILE_BYTES) throw new Error("That file is over 30 MB.");

  let docId: number;
  if (d.kind === "page") {
    const body = htmlToMarkdown(buf.toString("utf8"), { mainOnly: true });
    docId = Number(run(
      "INSERT INTO documents(school_id, source, title, url, mime, body, uploaded_by) VALUES (?, 'web', ?, ?, '.html', ?, ?)",
      schoolId, d.title, d.url, body, userId
    ).lastInsertRowid);
  } else {
    const ext = d.kind === "docx" ? ".docx" : ".pdf";
    const file = path.join(UPLOAD_DIR, `${crypto.randomUUID()}${ext}`);
    fs.writeFileSync(file, buf);
    docId = Number(run(
      "INSERT INTO documents(school_id, source, title, filename, url, mime, file_path, uploaded_by) VALUES (?, 'web', '', ?, ?, ?, ?, ?)",
      schoolId, decodeURIComponent(path.basename(new URL(d.url).pathname)), d.url, ext, file, userId
    ).lastInsertRowid);
  }
  run("UPDATE discoveries SET status = 'imported', document_id = ? WHERE id = ?", docId, discoveryId);
  enqueue(docId);
  return docId;
}
