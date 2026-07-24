/**
 * PAL Crawler — Victorian DET Policy and Advisory Library
 *
 * Implements the two-pass strategy from the PAL Crawl & Ingestion Spec:
 *   Pass 1  — slug discovery (recently-updated page + related-policies link graph)
 *   Pass 2  — direct print-all fetch for each slug at depth 0
 *
 * Also implements:
 *   - PAL-aware HTML parser that extracts all structured metadata from §4
 *   - Maintenance mode: re-crawl only topics listed on /pal/recently-updated since last run
 *   - Fallback mode: BFS from enrolment hub when slug index isn't available
 *
 * Traps from §2 of the spec are handled inline — see comments.
 */

import * as cheerio from "cheerio";
import pLimit from "p-limit";
import { db } from "@workspace/db";
import { scrapeJobs, documents, documentChunks, palSlugs } from "@workspace/db";
import { eq, and, inArray, notInArray } from "drizzle-orm";
import { autoTagDocument } from "./rag.js";
import { computeEmbedding } from "./embeddings.js";
import { chunkText } from "./fileParser.js";
import { upsertWikiPage } from "./wiki.js";
import { logger } from "./logger.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const PAL_BASE = "https://www2.education.vic.gov.au";
const PAL_ROOT = `${PAL_BASE}/pal`;
const RECENTLY_UPDATED_URL = `${PAL_ROOT}/recently-updated`;
const ENROLMENT_HUB_URL = `${PAL_ROOT}/enrolment/policy`;

const REQUEST_DELAY_MS = 600;   // polite rate limit; verify against robots.txt (§7)
const CONCURRENCY = 3;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_HTML_BYTES = 4 * 1024 * 1024; // 4 MB — print-all pages are large

// §3 attachment allowlist / blocklist
const ATTACHMENT_ALLOWLIST = new Set([
  "www2.education.vic.gov.au",
  "content.sdp.education.vic.gov.au",
]);
const BLOCKLIST_HOSTS = new Set([
  "eduvic.sharepoint.com",        // staff-gated, returns 401/403
  "arc.educationapps.vic.gov.au", // not policy content
]);

// Slugs that look like PAL topics but are infrastructure paths
const INFRA_SLUGS = new Set([
  "recently-updated", "filter-az", "search", "sitemap",
  "contact", "about", "help", "feedback",
]);

// Tab paths to exclude from the BFS frontier (canonical form is print-all, §4)
const EXCLUDED_TAB_SUFFIXES = ["/policy", "/overview", "/guidance", "/resources"];

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PalDocMetadata {
  topicSlug: string;
  category: string | null;
  policyLastUpdated: string | null;
  reviewedDate: string | null;
  scope: string | null;
  contactDivision: string | null;
  contactEmail: string | null;
  relatedPolicies: Array<{ slug: string; title: string }>;
  resourceLinks: Array<{ url: string; title: string; loginRequired: boolean }>;
  chapters: string[];
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "PolicyPilot/1.0 (+https://policypilot.app; DET PAL policy indexer)",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-AU,en;q=0.9",
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract PAL slug from a URL string.
 * Returns null for non-topic paths (infrastructure slugs, external links, etc.).
 */
function extractSlug(href: string, base = PAL_BASE): string | null {
  try {
    const url = new URL(href, base);
    if (url.hostname !== "www2.education.vic.gov.au") return null;
    const match = url.pathname.match(/^\/pal\/([a-z0-9-]+)/);
    if (!match) return null;
    const slug = match[1];
    if (INFRA_SLUGS.has(slug)) return null;
    return slug;
  } catch {
    return null;
  }
}

/** Build the print-all URL for a slug */
function printAllUrl(slug: string) {
  return `${PAL_ROOT}/${slug}/print-all`;
}

/** Determine if a URL should be blocked per spec §3 */
function isBlocked(urlStr: string): boolean {
  try {
    const host = new URL(urlStr).hostname;
    return BLOCKLIST_HOSTS.has(host);
  } catch {
    return true;
  }
}

/**
 * §2 trap: print-all breadcrumbs omit /pal prefix and 404.
 * Filter links whose pathname doesn't start with /pal.
 */
function isPalPath(href: string, base = PAL_BASE): boolean {
  try {
    const url = new URL(href, base);
    return url.hostname === "www2.education.vic.gov.au" &&
      url.pathname.startsWith("/pal/");
  } catch {
    return false;
  }
}

// ─── Pass 1: Slug Discovery ────────────────────────────────────────────────────

/**
 * Fetch the /pal/recently-updated page (server-rendered, complete since 2020)
 * and extract every unique PAL slug linked from it.
 */
async function discoverSlugsFromRecentlyUpdated(): Promise<Set<string>> {
  const slugs = new Set<string>();
  logger.info("PAL slug discovery: fetching recently-updated page");
  let res: Response;
  try {
    res = await fetchWithTimeout(RECENTLY_UPDATED_URL);
  } catch (err) {
    logger.warn({ err }, "Failed to fetch recently-updated page");
    return slugs;
  }
  if (!res.ok) {
    logger.warn({ status: res.status }, "recently-updated returned non-200");
    return slugs;
  }
  const html = await res.text();
  const $ = cheerio.load(html);
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const slug = extractSlug(href);
    if (slug) slugs.add(slug);
  });
  logger.info({ count: slugs.size }, "Slugs from recently-updated");
  return slugs;
}

/**
 * Fetch one PAL topic page and collect "Related policies" slugs.
 * Used to expand the slug set via the link graph.
 */
async function discoverRelatedSlugs(fromUrl: string): Promise<Set<string>> {
  const slugs = new Set<string>();
  let res: Response;
  try {
    res = await fetchWithTimeout(fromUrl);
  } catch {
    return slugs;
  }
  if (!res.ok) return slugs;
  const html = await res.text();
  const $ = cheerio.load(html);
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    if (!isPalPath(href)) return;
    const slug = extractSlug(href);
    if (slug) slugs.add(slug);
  });
  return slugs;
}

/**
 * Build the full slug index via:
 *   1. /pal/recently-updated (broad coverage)
 *   2. One hop of related-policies from the enrolment hub (fills gaps)
 *
 * Note: The authoritative approach is the A–Z JSON API (§7 open item).
 * Once the endpoint is captured, replace Pass 1 entirely.
 */
async function buildSlugIndex(
  onProgress?: (msg: string) => void
): Promise<string[]> {
  const allSlugs = new Set<string>();

  // Step 1 — recently-updated page
  onProgress?.("Fetching /pal/recently-updated …");
  const recentSlugs = await discoverSlugsFromRecentlyUpdated();
  recentSlugs.forEach((s) => allSlugs.add(s));

  // Step 2 — enrolment hub + one level of related policies
  onProgress?.(`Expanding via enrolment hub (${allSlugs.size} slugs so far) …`);
  await sleep(REQUEST_DELAY_MS);
  const hubSlugs = await discoverRelatedSlugs(ENROLMENT_HUB_URL);
  hubSlugs.forEach((s) => allSlugs.add(s));

  // Step 3 — one hop from each newly-discovered hub slug
  const limit = pLimit(CONCURRENCY);
  const toExpand = [...hubSlugs].slice(0, 50); // cap at 50 to stay polite
  const expanded = await Promise.all(
    toExpand.map((slug) =>
      limit(async () => {
        await sleep(REQUEST_DELAY_MS);
        return discoverRelatedSlugs(`${PAL_ROOT}/${slug}/policy`);
      })
    )
  );
  for (const set of expanded) {
    set.forEach((s) => allSlugs.add(s));
  }

  const slugList = [...allSlugs];
  logger.info({ count: slugList.length }, "PAL slug index built");
  return slugList;
}

// ─── PAL HTML Parser (§4) ─────────────────────────────────────────────────────

/**
 * Extract all structured metadata from a /pal/{slug}/print-all page.
 * Multiple CSS selector strategies are tried for each field since Nuxt/Drupal
 * markup can vary across topics.
 */
function parsePrintAllPage(
  $: cheerio.CheerioAPI,
  slug: string,
  pageUrl: string
): { metadata: PalDocMetadata; title: string; text: string } {
  // ── Title ──────────────────────────────────────────────────────────────────
  const title = $("h1").first().text().trim() || slug;

  // ── Category ───────────────────────────────────────────────────────────────
  // Drupal typically puts the category label in a taxonomy term element above h1
  const category =
    $(".field--name-field-category, .category-label, [class*='category'], .topic-category")
      .first().text().trim() ||
    // Fallback: look for text above h1 in the page header area
    $(".page-header, .page-intro, .hero, .banner")
      .find("span, p, div")
      .filter((_, el) => $(el).text().trim().length < 80)
      .first().text().trim() ||
    null;

  // ── Policy last updated ────────────────────────────────────────────────────
  const policyLastUpdated = extractLabelledValue($,
    ["Policy last updated", "Last updated", "Date"],
    [".policy-updated", ".field--name-field-policy-date", "[class*='updated']"]
  );

  // ── Reviewed date ──────────────────────────────────────────────────────────
  // "Reviewed {date}" appears in the footer area
  const reviewedDate = (() => {
    let found: string | null = null;
    $("*").each((_, el) => {
      const text = $(el).clone().children().remove().end().text().trim();
      const m = text.match(/reviewed\s+(\w+\s+\d{4}|\d{1,2}\s+\w+\s+\d{4})/i);
      if (m && !found) found = m[1];
    });
    return found;
  })();

  // ── Scope ──────────────────────────────────────────────────────────────────
  const scope = extractLabelledValue($,
    ["Scope", "Applies to"],
    [".field--name-field-scope", "[class*='scope']"]
  );

  // ── Contact ────────────────────────────────────────────────────────────────
  const contactBlock =
    $(".field--name-field-contact, [class*='contact-block'], .contact-info")
      .first().text().trim();

  let contactDivision: string | null = null;
  let contactEmail: string | null = null;

  if (contactBlock) {
    const emailMatch = contactBlock.match(/[\w.+-]+@[\w.-]+\.\w+/);
    if (emailMatch) contactEmail = emailMatch[0];
    // Division is everything before the email / pipe separator
    contactDivision = contactBlock
      .replace(contactEmail ?? "", "")
      .replace(/[|,]/g, "")
      .trim() || null;
  }

  // Also search body text for an email if block wasn't found
  if (!contactEmail) {
    const bodyText = $("body").text();
    const emailMatch = bodyText.match(/[\w.+-]+@education\.vic\.gov\.au/);
    if (emailMatch) contactEmail = emailMatch[0];
  }

  // ── Related policies ────────────────────────────────────────────────────────
  const relatedPolicies: Array<{ slug: string; title: string }> = [];
  const relatedSection =
    $("[class*='related'], #related-policies, .related-content").first();

  const searchArea = relatedSection.length ? relatedSection : $("body");
  // Find the "Related policies" heading and collect links after it
  let inRelated = false;
  searchArea.find("h2, h3, h4, a[href]").each((_, el) => {
    const tagName = (el as { tagName?: string }).tagName?.toLowerCase() ?? "";
    if (/^h[2-4]$/.test(tagName)) {
      const headingText = $(el).text().toLowerCase();
      inRelated = headingText.includes("related");
      return;
    }
    if (tagName === "a" && inRelated) {
      const href = $(el).attr("href") ?? "";
      const relSlug = extractSlug(href);
      const relTitle = $(el).text().trim();
      if (relSlug && relTitle) {
        relatedPolicies.push({ slug: relSlug, title: relTitle });
      }
    }
  });

  // ── Resource links ─────────────────────────────────────────────────────────
  const resourceLinks: Array<{ url: string; title: string; loginRequired: boolean }> = [];
  const resourceSection =
    $("[class*='resource'], #resources, .attachments").first();
  (resourceSection.length ? resourceSection : $("body"))
    .find("a[href]")
    .each((_, el) => {
      const href = $(el).attr("href") ?? "";
      if (!href || href.startsWith("javascript:")) return;
      try {
        const abs = new URL(href, pageUrl).href;
        const host = new URL(abs).hostname;
        // §2: record SharePoint URLs but flag as login-required, don't fetch
        if (BLOCKLIST_HOSTS.has(host) || ATTACHMENT_ALLOWLIST.has(host)) {
          const linkText = $(el).text().trim();
          if (linkText) {
            resourceLinks.push({
              url: abs,
              title: linkText,
              loginRequired: BLOCKLIST_HOSTS.has(host),
            });
          }
        }
      } catch { /* ignore malformed hrefs */ }
    });

  // ── Chapters ───────────────────────────────────────────────────────────────
  // Guidance chapter headings are h2/h3 elements on the print-all page
  const chapters: string[] = [];
  $("main, article, [role=main], .content, body").first()
    .find("h2, h3").each((_, el) => {
      const text = $(el).text().trim();
      // Filter out common structural headings
      if (text && !["Policy", "Overview", "Summary", "Resources", "Contact", "Related policies"].includes(text)) {
        chapters.push(text);
      }
    });

  // ── Body text extraction ────────────────────────────────────────────────────
  // §2 trap: /pal links to no policies, filter-az is client-rendered shell
  // Remove nav chrome
  $("script, style, noscript, nav, header, footer, aside, .nav, .header, .footer, .sidebar, .menu, .breadcrumb, .cookie-banner, [role=navigation], [role=banner], [role=contentinfo]").remove();

  const main = $("main, article, [role=main], .content, .page-content, #content, #main").first();
  const container = main.length ? main : $("body");
  const parts: string[] = [];

  container.find("h1,h2,h3,h4,h5,h6,p,li,td,th,dt,dd,blockquote").each((_, el) => {
    const tag = (el as { tagName?: string }).tagName?.toLowerCase() ?? "";
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (!text || text.length < 10) return;
    if (/^h[1-6]$/.test(tag)) {
      parts.push(`\n## ${text}\n`);
    } else {
      parts.push(text);
    }
  });

  const text = parts.join("\n").trim();

  const metadata: PalDocMetadata = {
    topicSlug: slug,
    category: category || null,
    policyLastUpdated: policyLastUpdated || null,
    reviewedDate: reviewedDate || null,
    scope: scope || null,
    contactDivision: contactDivision || null,
    contactEmail: contactEmail || null,
    relatedPolicies,
    resourceLinks,
    chapters,
  };

  return { metadata, title, text };
}

/** Helper: find a labelled field value using text-label or CSS selector strategies */
function extractLabelledValue(
  $: cheerio.CheerioAPI,
  labels: string[],
  selectors: string[]
): string | null {
  // Try CSS selectors first
  for (const sel of selectors) {
    const val = $(sel).first().text().trim();
    if (val) return val;
  }
  // Fall back to scanning text nodes for label patterns
  for (const label of labels) {
    let found: string | null = null;
    $("dt, th, strong, b, label, p, div").each((_, el) => {
      const text = $(el).text().trim();
      if (text.toLowerCase().startsWith(label.toLowerCase())) {
        // The value might be in a sibling dd/td or the remainder of the string
        const sibling = $(el).next();
        if (sibling.length) {
          found = sibling.text().trim() || null;
        } else {
          found = text.replace(new RegExp(`^${label}[:\\s]*`, "i"), "").trim() || null;
        }
      }
    });
    if (found) return found;
  }
  return null;
}

// ─── Import ───────────────────────────────────────────────────────────────────

async function importPalPage(
  slug: string,
  pageUrl: string,
  html: string,
  jobId: number
): Promise<boolean> {
  if (html.length > MAX_HTML_BYTES) {
    logger.warn({ slug, size: html.length }, "print-all page too large, skipping");
    return false;
  }

  const $ = cheerio.load(html);
  const { metadata, title, text } = parsePrintAllPage($, slug, pageUrl);

  if (text.length < 200) {
    logger.warn({ slug }, "print-all page has insufficient content");
    return false;
  }

  // AI auto-tagging
  const tags = await autoTagDocument(text);
  const status = (tags.confidenceScore ?? 0) >= 0.75 ? "approved" : "pending";

  // Upsert document (replace if same sourceUrl already exists)
  const existing = await db
    .select({ id: documents.id })
    .from(documents)
    .where(eq(documents.sourceUrl, pageUrl));

  let docId: number;
  if (existing.length > 0) {
    docId = existing[0].id;
    await db
      .update(documents)
      .set({
        filename: title.slice(0, 255),
        fileType: "pal-page",
        rawText: text,
        title: tags.title ?? title,
        issuingAuthority: tags.issuingAuthority,
        policyDomain: tags.policyDomain,
        documentType: tags.documentType,
        audience: tags.audience,
        confidenceScore: tags.confidenceScore,
        status,
        palMetadata: metadata as unknown,
        updatedAt: new Date(),
      })
      .where(eq(documents.id, docId));

    // Re-chunk: remove old chunks
    await db.delete(documentChunks).where(eq(documentChunks.documentId, docId));
  } else {
    const [doc] = await db
      .insert(documents)
      .values({
        filename: title.slice(0, 255),
        fileType: "pal-page",
        rawText: text,
        title: tags.title ?? title,
        issuingAuthority: tags.issuingAuthority,
        policyDomain: tags.policyDomain,
        documentType: tags.documentType,
        audience: tags.audience,
        confidenceScore: tags.confidenceScore,
        sourceUrl: pageUrl,
        status,
        palMetadata: metadata as unknown,
      })
      .returning();
    docId = doc.id;
  }

  // §4 chunking: split on ## headings (already formatted in extractHtmlText)
  const chunks = chunkText(text);
  if (chunks.length > 0) {
    const embeddings = await Promise.all(chunks.map((c) => computeEmbedding(c)));
    await db.insert(documentChunks).values(
      chunks.map((content, i) => ({
        documentId: docId,
        content,
        embedding: embeddings[i],
        chunkIndex: i,
      }))
    );
  }

  // Generate wiki page (background, non-blocking for job progress)
  upsertWikiPage(docId, text).catch((err) =>
    logger.warn({ slug, err }, "Wiki page generation failed")
  );

  // Update slug index
  await db
    .insert(palSlugs)
    .values({
      slug,
      title,
      category: metadata.category,
      lastCrawled: new Date(),
      policyLastUpdated: metadata.policyLastUpdated,
      reviewedDate: metadata.reviewedDate,
    })
    .onConflictDoUpdate({
      target: palSlugs.slug,
      set: {
        title,
        category: metadata.category,
        lastCrawled: new Date(),
        policyLastUpdated: metadata.policyLastUpdated,
        reviewedDate: metadata.reviewedDate,
        isRetired: false,
        retiredAt: null,
        updatedAt: new Date(),
      },
    });

  return true;
}

// ─── Job progress helper ──────────────────────────────────────────────────────

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

async function isCancelled(jobId: number): Promise<boolean> {
  const [row] = await db
    .select({ status: scrapeJobs.status })
    .from(scrapeJobs)
    .where(eq(scrapeJobs.id, jobId));
  return row?.status === "cancelled";
}

// ─── Main job runners ─────────────────────────────────────────────────────────

/**
 * Full two-pass PAL crawl.
 * Pass 1 builds the slug index, Pass 2 fetches print-all for each slug.
 */
export async function runPalFullCrawl(jobId: number): Promise<void> {
  await updateJobProgress(jobId, { status: "running", currentUrl: "Building slug index…" });

  try {
    // ── Pass 1: build slug index ──────────────────────────────────────────────
    const slugList = await buildSlugIndex((msg) => {
      updateJobProgress(jobId, { currentUrl: msg }).catch(() => {});
    });

    if (!slugList.length) {
      await updateJobProgress(jobId, {
        status: "failed",
        error: "Slug discovery returned 0 topics. The site may be blocking or the recently-updated page structure has changed.",
        completedAt: new Date(),
      });
      return;
    }

    await updateJobProgress(jobId, { urlsFound: slugList.length });

    // ── Pass 2: fetch print-all for each slug ─────────────────────────────────
    let processed = 0;
    let imported = 0;
    let skipped = 0;

    const limit = pLimit(CONCURRENCY);

    // Process in batches so we can update progress and check for cancellation
    const batchSize = 10;
    for (let i = 0; i < slugList.length; i += batchSize) {
      if (await isCancelled(jobId)) {
        logger.info({ jobId }, "PAL full crawl cancelled");
        return;
      }

      const batch = slugList.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map((slug) =>
          limit(async () => {
            const url = printAllUrl(slug);
            await updateJobProgress(jobId, { currentUrl: url });
            await sleep(REQUEST_DELAY_MS);

            let res: Response;
            try {
              res = await fetchWithTimeout(url);
            } catch (err) {
              logger.warn({ slug, err }, "Failed to fetch print-all");
              return false;
            }

            if (res.status === 404) {
              // §5: tombstone retired topics
              await db
                .insert(palSlugs)
                .values({ slug, isRetired: true, retiredAt: new Date() })
                .onConflictDoUpdate({
                  target: palSlugs.slug,
                  set: { isRetired: true, retiredAt: new Date(), updatedAt: new Date() },
                });
              return false;
            }

            if (!res.ok) return false;

            const html = await res.text();
            return importPalPage(slug, url, html, jobId);
          })
        )
      );

      for (const r of results) {
        processed++;
        if (r) imported++;
        else skipped++;
      }

      await updateJobProgress(jobId, { urlsProcessed: processed, docsImported: imported, docsSkipped: skipped });
    }

    await updateJobProgress(jobId, {
      status: "completed",
      currentUrl: null,
      urlsFound: slugList.length,
      urlsProcessed: processed,
      docsImported: imported,
      docsSkipped: skipped,
      completedAt: new Date(),
    });

    logger.info({ jobId, imported, skipped }, "PAL full crawl completed");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ jobId, err }, "PAL full crawl failed");
    await updateJobProgress(jobId, {
      status: "failed",
      error: msg,
      currentUrl: null,
      completedAt: new Date(),
    });
  }
}

/**
 * Maintenance crawl — fetch /pal/recently-updated, parse entries newer than
 * `sinceDate`, re-crawl only those topics' print-all pages.
 * Also diffs the slug index to tombstone retired topics.
 */
export async function runPalMaintenanceCrawl(
  jobId: number,
  sinceDate: Date
): Promise<void> {
  await updateJobProgress(jobId, { status: "running", currentUrl: "Fetching recently-updated page…" });

  try {
    let res: Response;
    try {
      res = await fetchWithTimeout(RECENTLY_UPDATED_URL);
    } catch (err) {
      throw new Error(`Failed to fetch recently-updated: ${String(err)}`);
    }

    if (!res.ok) throw new Error(`recently-updated returned HTTP ${res.status}`);

    const html = await res.text();
    const $ = cheerio.load(html);

    // Parse the change log. Each entry typically looks like:
    //   <article> or <li>
    //     <time datetime="2024-01-15"> or text "15 January 2024"
    //     <a href="/pal/{slug}">Topic title</a>
    //     <p>Description of change</p>
    //   </article>
    const slugsToUpdate = new Set<string>();

    $("article, li, tr, .view-row").each((_, el) => {
      // Try to find a date within this element
      const timeEl = $(el).find("time").first();
      const datetimeAttr = timeEl.attr("datetime");
      let entryDate: Date | null = null;
      if (datetimeAttr) {
        entryDate = new Date(datetimeAttr);
      } else {
        // Try to parse a date from text content
        const text = $(el).text();
        const m = text.match(/(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})/i);
        if (m) {
          entryDate = new Date(`${m[2]} ${m[1]}, ${m[3]}`);
        }
      }

      if (!entryDate || entryDate <= sinceDate) return;

      // Find PAL links in this entry
      $(el).find("a[href]").each((_, a) => {
        const href = $(a).attr("href") ?? "";
        const slug = extractSlug(href);
        if (slug) slugsToUpdate.add(slug);
      });
    });

    // Fallback: if the structure didn't parse cleanly, re-collect all slugs from the page
    if (slugsToUpdate.size === 0) {
      logger.warn({ jobId }, "Could not parse dated entries — re-crawling all linked slugs");
      $("a[href]").each((_, el) => {
        const href = $(el).attr("href") ?? "";
        const slug = extractSlug(href);
        if (slug) slugsToUpdate.add(slug);
      });
    }

    const slugList = [...slugsToUpdate];
    await updateJobProgress(jobId, { urlsFound: slugList.length });
    logger.info({ jobId, count: slugList.length, sinceDate }, "PAL maintenance: topics to re-crawl");

    let processed = 0;
    let imported = 0;
    let skipped = 0;
    const limit = pLimit(CONCURRENCY);

    const results = await Promise.all(
      slugList.map((slug) =>
        limit(async () => {
          if (await isCancelled(jobId)) return false;
          const url = printAllUrl(slug);
          await updateJobProgress(jobId, { currentUrl: url });
          await sleep(REQUEST_DELAY_MS);

          let r: Response;
          try {
            r = await fetchWithTimeout(url);
          } catch {
            return false;
          }
          if (!r.ok) return false;
          const pageHtml = await r.text();
          return importPalPage(slug, url, pageHtml, jobId);
        })
      )
    );

    for (const r of results) {
      processed++;
      if (r) imported++;
      else skipped++;
    }

    // §5: diff slug index — tombstone any slug in DB that has disappeared
    // (We only do this on full crawls; maintenance just re-crawls changed topics)

    await updateJobProgress(jobId, {
      status: "completed",
      currentUrl: null,
      urlsFound: slugList.length,
      urlsProcessed: processed,
      docsImported: imported,
      docsSkipped: skipped,
      completedAt: new Date(),
    });

    logger.info({ jobId, imported }, "PAL maintenance crawl completed");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ jobId, err }, "PAL maintenance crawl failed");
    await updateJobProgress(jobId, {
      status: "failed",
      error: msg,
      currentUrl: null,
      completedAt: new Date(),
    });
  }
}

/**
 * Fallback link-graph crawl — seeds from the enrolment hub and follows
 * related-policy links up to `maxDepth` levels (spec: depth 5, max 4000 pages).
 * Use this only when the slug index isn't available.
 */
export async function runPalFallbackCrawl(
  jobId: number,
  maxDepth = 5,
  maxPages = 4000
): Promise<void> {
  await updateJobProgress(jobId, { status: "running", currentUrl: ENROLMENT_HUB_URL });

  const visited = new Set<string>();
  const queue: Array<[string, number]> = [[ENROLMENT_HUB_URL, 0]];
  visited.add(ENROLMENT_HUB_URL);

  let processed = 0;
  let imported = 0;
  let skipped = 0;
  const limit = pLimit(CONCURRENCY);

  try {
    while (queue.length > 0 && processed < maxPages) {
      if (await isCancelled(jobId)) {
        logger.info({ jobId }, "PAL fallback crawl cancelled");
        return;
      }

      const batch = queue.splice(0, CONCURRENCY);
      const results = await Promise.all(
        batch.map(([url, depth]) =>
          limit(async () => {
            // §2: skip broken print-all breadcrumbs that omit /pal prefix
            if (!isPalPath(url)) return { url, links: [], imported: false };

            // §2: block SharePoint and other off-target hosts
            if (isBlocked(url)) return { url, links: [], imported: false };

            // §4: skip individual tabs if we prefer print-all
            const pathname = new URL(url).pathname;
            if (EXCLUDED_TAB_SUFFIXES.some((s) => pathname.endsWith(s) && !pathname.endsWith("/print-all"))) {
              return { url, links: [], imported: false };
            }

            await updateJobProgress(jobId, { currentUrl: url });
            await sleep(REQUEST_DELAY_MS);

            let res: Response;
            try {
              res = await fetchWithTimeout(url);
            } catch {
              return { url, links: [], imported: false };
            }
            if (!res.ok) return { url, links: [], imported: false };

            const html = await res.text();
            const $ = cheerio.load(html);

            // Collect PAL links for further crawling
            const links: string[] = [];
            if (depth < maxDepth) {
              $("a[href]").each((_, el) => {
                const href = $(el).attr("href") ?? "";
                if (!isPalPath(href)) return;
                const abs = new URL(href, PAL_BASE).href;
                if (!visited.has(abs) && !isBlocked(abs)) {
                  visited.add(abs);
                  links.push(abs);
                }
              });
            }

            // Only import print-all pages (skip tabs)
            let pageImported = false;
            if (pathname.endsWith("/print-all")) {
              const slug = extractSlug(url) ?? pathname.split("/")[2];
              pageImported = await importPalPage(slug, url, html, jobId);
            }

            return { url, links, imported: pageImported };
          })
        )
      );

      for (const r of results) {
        processed++;
        if (r.imported) imported++;
        else skipped++;
        // Add new links to queue
        for (const link of r.links) {
          const [, depth] = batch.find(([u]) => u === r.url) ?? [r.url, 0];
          queue.push([link, depth + 1]);
        }
      }

      await updateJobProgress(jobId, {
        urlsFound: visited.size,
        urlsProcessed: processed,
        docsImported: imported,
        docsSkipped: skipped,
      });
    }

    await updateJobProgress(jobId, {
      status: "completed",
      currentUrl: null,
      urlsFound: visited.size,
      urlsProcessed: processed,
      docsImported: imported,
      docsSkipped: skipped,
      completedAt: new Date(),
    });

    logger.info({ jobId, imported }, "PAL fallback crawl completed");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ jobId, err }, "PAL fallback crawl failed");
    await updateJobProgress(jobId, {
      status: "failed",
      error: msg,
      currentUrl: null,
      completedAt: new Date(),
    });
  }
}

// ─── Slug index stats ─────────────────────────────────────────────────────────

export async function getPalSlugStats() {
  const rows = await db.select().from(palSlugs);
  const active = rows.filter((r) => !r.isRetired);
  const retired = rows.filter((r) => r.isRetired);
  const lastCrawled = rows
    .filter((r) => r.lastCrawled)
    .sort((a, b) => (b.lastCrawled?.getTime() ?? 0) - (a.lastCrawled?.getTime() ?? 0))[0]
    ?.lastCrawled ?? null;

  const byCategory: Record<string, number> = {};
  for (const r of active) {
    if (r.category) byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
  }

  return { total: rows.length, active: active.length, retired: retired.length, lastCrawled, byCategory };
}
