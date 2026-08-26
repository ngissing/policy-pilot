import * as cheerio from "cheerio";
import pLimit from "p-limit";
import { db } from "@workspace/db";
import { scrapeJobs, documents, documentChunks } from "@workspace/db";
import { eq } from "drizzle-orm";
import { autoTagDocument } from "./rag.js";
import { computeEmbedding } from "./embeddings.js";
import { chunkText } from "./fileParser.js";
import { logger } from "./logger.js";
import { parseFile, getFileType } from "./fileParser.js";

const CONCURRENCY = 3;
const REQUEST_DELAY_MS = 600;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_HTML_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB

const SKIP_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".svg", ".webp", ".ico",
  ".mp4", ".mp3", ".avi", ".mov", ".wmv", ".flv",
  ".zip", ".tar", ".gz", ".rar", ".7z",
  ".css", ".js", ".mjs", ".ts", ".map",
  ".xml", ".json", ".rss", ".atom",
  ".woff", ".woff2", ".ttf", ".eot",
]);

const DOCUMENT_EXTENSIONS = new Set([".pdf", ".docx", ".txt"]);
const DOCUMENT_MIMES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
]);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function normaliseUrl(href: string, base: string): string | null {
  try {
    const url = new URL(href, base);
    // Strip fragment and trailing slash normalisation
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function isSameDomain(urlStr: string, origin: string): boolean {
  try {
    return new URL(urlStr).origin === origin;
  } catch {
    return false;
  }
}

function getExtension(urlStr: string): string {
  try {
    const pathname = new URL(urlStr).pathname;
    const dot = pathname.lastIndexOf(".");
    if (dot === -1) return "";
    return pathname.slice(dot).toLowerCase();
  } catch {
    return "";
  }
}

function isSkippable(urlStr: string): boolean {
  const ext = getExtension(urlStr);
  return SKIP_EXTENSIONS.has(ext);
}

function isDocument(urlStr: string, contentType: string): boolean {
  const ext = getExtension(urlStr);
  if (DOCUMENT_EXTENSIONS.has(ext)) return true;
  const mime = contentType.split(";")[0].trim().toLowerCase();
  return DOCUMENT_MIMES.has(mime);
}

/**
 * Extract clean readable text from an HTML page.
 * Removes nav, header, footer, scripts, styles, then concatenates headings and paragraphs.
 */
function extractHtmlText($: cheerio.CheerioAPI, pageUrl: string): { title: string; text: string } {
  $("script, style, noscript, nav, header, footer, aside, .nav, .header, .footer, .sidebar, .menu, .breadcrumb, .cookie-banner, [role=navigation], [role=banner], [role=contentinfo]").remove();

  const title =
    $("h1").first().text().trim() ||
    $("title").text().trim() ||
    new URL(pageUrl).pathname.split("/").filter(Boolean).pop() ||
    "Untitled";

  // Prefer main content area
  const main =
    $("main, article, [role=main], .content, .page-content, .article-body, #content, #main").first();

  const container = main.length ? main : $("body");

  const parts: string[] = [];

  container.find("h1,h2,h3,h4,h5,h6,p,li,td,th,dt,dd,blockquote,pre").each((_, el) => {
    const tag = (el as { tagName?: string }).tagName?.toLowerCase() ?? "";
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (!text || text.length < 10) return;

    if (/^h[1-6]$/.test(tag)) {
      parts.push(`\n## ${text}\n`);
    } else {
      parts.push(text);
    }
  });

  return { title, text: parts.join("\n").trim() };
}

async function fetchWithTimeout(url: string, opts: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...opts,
      signal: controller.signal,
      headers: {
        "User-Agent": "PolicyPilot/1.0 (+https://policypilot.app; policy document indexer)",
        Accept: "text/html,application/xhtml+xml,application/xml,application/pdf,*/*;q=0.8",
        ...((opts.headers as Record<string, string>) ?? {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function processHtmlPage(
  url: string,
  response: Response,
  jobId: number
): Promise<{ links: string[]; imported: boolean }> {
  const html = await response.text();
  if (html.length > MAX_HTML_BYTES) {
    return { links: [], imported: false };
  }

  const $ = cheerio.load(html);
  const { title, text } = extractHtmlText($, url);

  // Collect all links for further crawling
  const links: string[] = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    if (!href || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) return;
    const abs = normaliseUrl(href, url);
    if (abs) links.push(abs);
  });

  // Only import pages with meaningful content (>200 chars)
  if (text.length < 200) {
    return { links, imported: false };
  }

  await importTextDocument(title, url, "html-page", text, jobId);
  return { links, imported: true };
}

async function processFileUrl(
  url: string,
  response: Response,
  jobId: number
): Promise<{ imported: boolean }> {
  const contentLength = parseInt(response.headers.get("content-length") ?? "0", 10);
  if (contentLength > MAX_FILE_BYTES) {
    logger.warn({ url, contentLength }, "Skipping oversized file");
    return { imported: false };
  }

  const arrayBuf = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);
  const contentType = response.headers.get("content-type") ?? "";
  const pathname = new URL(url).pathname;
  const filename = pathname.split("/").pop() || "document";

  const fileType = getFileType(contentType, filename);
  if (fileType === "unknown") return { imported: false };

  let rawText: string;
  try {
    rawText = await parseFile(buffer, contentType, filename);
  } catch (err) {
    logger.warn({ url, err }, "Failed to parse file");
    return { imported: false };
  }

  await importTextDocument(filename, url, fileType, rawText, jobId);
  return { imported: true };
}

async function importTextDocument(
  title: string,
  sourceUrl: string,
  fileType: string,
  rawText: string,
  _jobId: number
): Promise<void> {
  if (!rawText.trim()) return;

  const tags = await autoTagDocument(rawText);
  const status = (tags.confidenceScore ?? 0) >= 0.75 ? "approved" : "pending";

  const [doc] = await db
    .insert(documents)
    .values({
      filename: title.slice(0, 255),
      fileType,
      rawText,
      title: tags.title ?? title,
      issuingAuthority: tags.issuingAuthority,
      policyDomain: tags.policyDomain,
      documentType: tags.documentType,
      audience: tags.audience,
      confidenceScore: tags.confidenceScore,
      sourceUrl,
      resourceScope: "external",
      status,
    })
    .returning();

  const chunks = chunkText(rawText);
  if (chunks.length > 0) {
    const embeddings = await Promise.all(chunks.map((c) => computeEmbedding(c)));
    await db.insert(documentChunks).values(
      chunks.map((content, i) => ({
        documentId: doc.id,
        content,
        embedding: embeddings[i],
        chunkIndex: i,
      }))
    );
  }
}

async function updateJobProgress(
  jobId: number,
  patch: Partial<{
    status: string;
    urlsFound: number;
    urlsProcessed: number;
    docsImported: number;
    docsSkipped: number;
    currentUrl: string | null;
    error: string | null;
    completedAt: Date | null;
  }>
) {
  await db
    .update(scrapeJobs)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(scrapeJobs.id, jobId));
}

/**
 * Main BFS crawl. Runs in the background — caller does not await.
 */
export async function runScrapeJob(jobId: number): Promise<void> {
  const [job] = await db.select().from(scrapeJobs).where(eq(scrapeJobs.id, jobId));
  if (!job) return;

  const seedUrl = job.seedUrl;
  const maxDepth = job.maxDepth;
  const maxPages = job.maxPages;

  let origin: string;
  try {
    origin = new URL(seedUrl).origin;
  } catch {
    await updateJobProgress(jobId, { status: "failed", error: "Invalid seed URL" });
    return;
  }

  const visited = new Set<string>();
  // Queue entries: [url, depth]
  const queue: Array<[string, number]> = [[seedUrl, 0]];
  visited.add(seedUrl);

  let urlsProcessed = 0;
  let docsImported = 0;
  let docsSkipped = 0;

  const limit = pLimit(CONCURRENCY);

  await updateJobProgress(jobId, { status: "running", urlsFound: 1, currentUrl: seedUrl });

  try {
    while (queue.length > 0 && urlsProcessed < maxPages) {
      // Check if job was cancelled
      const [current] = await db
        .select({ status: scrapeJobs.status })
        .from(scrapeJobs)
        .where(eq(scrapeJobs.id, jobId));
      if (current?.status === "cancelled") {
        logger.info({ jobId }, "Scrape job cancelled");
        return;
      }

      // Take a batch of up to CONCURRENCY items from the front
      const batch = queue.splice(0, CONCURRENCY);

      const results = await Promise.all(
        batch.map(([url, depth]) =>
          limit(async () => {
            if (isSkippable(url)) return { url, links: [], imported: false };

            await updateJobProgress(jobId, { currentUrl: url });

            let response: Response;
            try {
              response = await fetchWithTimeout(url);
            } catch (err) {
              logger.warn({ url, err }, "Fetch failed");
              return { url, links: [], imported: false };
            }

            if (!response.ok) return { url, links: [], imported: false };

            const contentType = response.headers.get("content-type") ?? "";

            let links: string[] = [];
            let imported = false;

            if (isDocument(url, contentType)) {
              ({ imported } = await processFileUrl(url, response, jobId));
            } else if (contentType.includes("text/html")) {
              ({ links, imported } = await processHtmlPage(url, response, jobId));
            }

            // Enqueue new links (if within depth)
            if (depth < maxDepth) {
              for (const link of links) {
                if (!visited.has(link) && isSameDomain(link, origin) && !isSkippable(link)) {
                  visited.add(link);
                  queue.push([link, depth + 1]);
                }
              }
            }

            return { url, links, imported };
          })
        )
      );

      for (const r of results) {
        urlsProcessed++;
        if (r.imported) docsImported++;
        else docsSkipped++;
      }

      await updateJobProgress(jobId, {
        urlsFound: visited.size,
        urlsProcessed,
        docsImported,
        docsSkipped,
      });

      if (queue.length > 0 && urlsProcessed < maxPages) {
        await sleep(REQUEST_DELAY_MS);
      }
    }

    await updateJobProgress(jobId, {
      status: "completed",
      currentUrl: null,
      urlsFound: visited.size,
      urlsProcessed,
      docsImported,
      docsSkipped,
      completedAt: new Date(),
    });

    logger.info({ jobId, urlsProcessed, docsImported }, "Scrape job completed");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ jobId, err }, "Scrape job failed");
    await updateJobProgress(jobId, {
      status: "failed",
      error: msg,
      currentUrl: null,
      completedAt: new Date(),
    });
  }
}
