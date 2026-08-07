/**
 * PAL Crawler — Victorian DET Policy and Advisory Library
 *
 * Discovery strategy (authoritative — sitemap replaces all previous fallbacks):
 *   Pass 1  — fetch sitemap.xml, extract 456 topic roots + <lastmod> per URL
 *   Pass 1b — optional: enrich categories from Elasticsearch (degrades gracefully)
 *   Pass 2  — fetch /pal/{slug}/print-all for each root at depth 0
 *             if print-all returns non-200, fall back to crawling that topic's
 *             individual sitemap URLs
 *
 * Maintenance mode uses sitemap <lastmod> comparison — re-crawls only topics
 * whose lastmod has advanced since the stored value.
 *
 * Spec references inline — §N refers to the PAL Crawl & Ingestion Spec.
 * Discovery notes from "DISCOVERY" addendum (24 Jul 2026).
 */

import * as cheerio from "cheerio";
import pLimit from "p-limit";
import { db } from "@workspace/db";
import { scrapeJobs, documents, documentChunks, palSlugs } from "@workspace/db";
import { eq } from "drizzle-orm";
import { autoTagDocument } from "./rag.js";
import { computeEmbedding } from "./embeddings.js";
import { chunkText } from "./fileParser.js";
import { upsertWikiPage } from "./wiki.js";
import { logger } from "./logger.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const PAL_BASE = "https://www2.education.vic.gov.au";
const PAL_ROOT = `${PAL_BASE}/pal`;
const SITEMAP_URL = `${PAL_BASE}/sitemap.xml`;

// Elasticsearch metadata enrichment endpoint (undocumented, CORS-scoped — may fail).
// Strip /site-5 prefix from url field to get /pal/{slug}.
const ES_ENDPOINT =
  "https://f638372d60d9258888e59583f505162f.sdp4.elastic.sdp.vic.gov.au" +
  "/elasticsearch_index_production_node/_search";
const ES_BODY = JSON.stringify({
  query: { term: { type: "publication" } },
  size: 500,
  _source: ["url", "title", "field_pal_category_name", "changed"],
});

// Politeness — verified against robots.txt 24 Jul 2026. No Crawl-delay directive.
const REQUEST_DELAY_MS = 600;
const CONCURRENCY = 3;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_HTML_BYTES = 4 * 1024 * 1024; // 4 MB — print-all pages can be large

// Sitemap health-check bounds (addendum §1)
const SITEMAP_PAL_MIN = 3_000;
const SITEMAP_PAL_MAX = 4_000;
const SITEMAP_ROOTS_EXPECTED = 456;

// §3 attachment allowlist / blocklist
const ATTACHMENT_ALLOWLIST = new Set([
  "www2.education.vic.gov.au",
  "content.sdp.education.vic.gov.au",
]);
const BLOCKLIST_HOSTS = new Set([
  "eduvic.sharepoint.com",        // staff-gated, returns 401/403
  "arc.educationapps.vic.gov.au", // not policy content
]);

// Infrastructure slugs that are not topics
const INFRA_SLUGS = new Set([
  "recently-updated", "filter-az", "search", "sitemap",
  "contact", "about", "help", "feedback",
  "js", "img", "_nuxt",                  // addendum: do not crawl
]);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PalDocMetadata {
  topicSlug: string;
  category: string | null;
  categories: string[];              // DET may assign two categories (ES source)
  policyLastUpdated: string | null;
  reviewedDate: string | null;
  sitemapLastmod: string | null;     // secondary date signal
  scope: string | null;
  contactDivision: string | null;
  contactEmail: string | null;
  relatedPolicies: Array<{ slug: string; title: string }>;
  resourceLinks: Array<{ url: string; title: string; loginRequired: boolean }>;
  chapters: string[];
}

interface SlugEntry {
  slug: string;
  /** Most recent <lastmod> across all sitemap URLs for this topic */
  lastmod: string | null;
  /** All sitemap URLs for this topic (used as fallback if print-all 404s) */
  sitemapUrls: string[];
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(
  url: string,
  opts: RequestInit = {}
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...opts,
      signal: controller.signal,
      headers: {
        "User-Agent":
          "PolicyPilot/1.0 (+https://policypilot.app; DET PAL policy indexer)",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-AU,en;q=0.9",
        ...((opts.headers as Record<string, string>) ?? {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Extract PAL slug from a URL pathname. Returns null for infrastructure paths. */
function slugFromPathname(pathname: string): string | null {
  const m = pathname.match(/^\/pal\/([a-z0-9][a-z0-9-]*)/);
  if (!m) return null;
  const slug = m[1];
  return INFRA_SLUGS.has(slug) ? null : slug;
}

function printAllUrl(slug: string) {
  return `${PAL_ROOT}/${slug}/print-all`;
}

function isBlocked(urlStr: string): boolean {
  try {
    return BLOCKLIST_HOSTS.has(new URL(urlStr).hostname);
  } catch {
    return true;
  }
}

// ─── Pass 1A: Sitemap-based slug discovery ────────────────────────────────────

/**
 * Fetch sitemap.xml and extract the authoritative topic slug index.
 *
 * Addendum §1: 656 KB flat urlset, ~3,406 PAL URLs, ~456 topic roots.
 * Aborts if count is outside [3000, 4000] — site structure has changed.
 */
export async function fetchSlugIndexFromSitemap(): Promise<{
  slugs: SlugEntry[];
  totalPalUrls: number;
}> {
  logger.info("Fetching PAL sitemap from %s", SITEMAP_URL);

  const res = await fetchWithTimeout(SITEMAP_URL);
  if (!res.ok) {
    throw new Error(`Sitemap fetch failed: HTTP ${res.status}`);
  }

  const xml = await res.text();
  const $ = cheerio.load(xml, { xmlMode: true });

  // Collect all PAL <loc> + <lastmod> pairs
  const palUrls: Array<{ loc: string; lastmod: string | null }> = [];
  $("url").each((_, el) => {
    const loc = $("loc", el).text().trim();
    if (!loc.startsWith(`${PAL_BASE}/pal/`)) return;
    const lastmod = $("lastmod", el).text().trim() || null;
    palUrls.push({ loc, lastmod });
  });

  logger.info({ count: palUrls.length }, "PAL URLs found in sitemap");

  // Health-check: abort if count is outside expected range
  if (palUrls.length < SITEMAP_PAL_MIN || palUrls.length > SITEMAP_PAL_MAX) {
    throw new Error(
      `Sitemap PAL URL count ${palUrls.length} is outside expected range ` +
        `[${SITEMAP_PAL_MIN}, ${SITEMAP_PAL_MAX}]. ` +
        "The site structure may have changed — aborting."
    );
  }

  // Group by topic root (first segment after /pal/)
  // Topic roots have exactly one path segment after /pal/.
  // Sub-pages (/pal/{slug}/policy, /guidance/...) are also collected per-slug
  // as fallback URLs if print-all returns non-200.
  const bySlug = new Map<string, SlugEntry>();

  for (const { loc, lastmod } of palUrls) {
    const pathname = new URL(loc).pathname;
    const slug = slugFromPathname(pathname);
    if (!slug) continue;

    const existing = bySlug.get(slug);
    if (!existing) {
      bySlug.set(slug, { slug, lastmod, sitemapUrls: [loc] });
    } else {
      existing.sitemapUrls.push(loc);
      // Keep the most recent lastmod
      if (lastmod && (!existing.lastmod || lastmod > existing.lastmod)) {
        existing.lastmod = lastmod;
      }
    }
  }

  const slugs = [...bySlug.values()];
  logger.info(
    { roots: slugs.length, expected: SITEMAP_ROOTS_EXPECTED },
    "PAL topic roots extracted from sitemap"
  );

  return { slugs, totalPalUrls: palUrls.length };
}

// ─── Pass 1B: Elasticsearch category enrichment (optional) ───────────────────

/**
 * Fetch DET's own category assignments from the Elasticsearch endpoint.
 *
 * Addendum §METADATA ENRICHMENT:
 *   - Returns up to 454 topics; 2 known anomalies (right-to-disconnect,
 *     teach-the-future-fellowship-program) lack a /pal/ segment in the url field.
 *   - Strip /site-5 prefix from url field.
 *   - Endpoint is CORS-scoped — may fail from server context. Degrade gracefully.
 *   - Never surface ES "changed" field to users as a review date (bulk migration
 *     date 2020-03-11 appears on many topics).
 *
 * Returns: Map<slug, string[]> of category names (many topics carry two).
 */
async function enrichFromElasticsearch(): Promise<Map<string, string[]>> {
  const categories = new Map<string, string[]>();

  try {
    const res = await fetchWithTimeout(ES_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    if (!res.ok) {
      logger.warn(
        { status: res.status },
        "ES enrichment returned non-200 — degrading gracefully"
      );
      return categories;
    }

    const data = (await res.json()) as {
      hits?: {
        hits?: Array<{
          _source?: {
            url?: string;
            field_pal_category_name?: string | string[];
          };
        }>;
      };
    };

    const hits = data?.hits?.hits ?? [];
    let enriched = 0;

    for (const hit of hits) {
      const src = hit._source;
      if (!src?.url) continue;

      // Strip /site-5 prefix to get /pal/{slug}
      const cleanUrl = src.url.replace(/^\/site-\d+/, "");
      const slug = slugFromPathname(cleanUrl);
      if (!slug) continue;

      const cats = Array.isArray(src.field_pal_category_name)
        ? src.field_pal_category_name.filter(Boolean)
        : src.field_pal_category_name
        ? [src.field_pal_category_name]
        : [];

      if (cats.length > 0) {
        categories.set(slug, cats);
        enriched++;
      }
    }

    logger.info(
      { hits: hits.length, enriched },
      "ES category enrichment complete"
    );
  } catch (err) {
    logger.warn({ err }, "ES enrichment failed — degrading gracefully");
  }

  return categories;
}

// ─── Combined Pass 1 ──────────────────────────────────────────────────────────

/**
 * Build the authoritative slug index: sitemap + optional ES category enrichment.
 */
async function buildSlugIndex(
  onProgress?: (msg: string) => void
): Promise<{ slugs: SlugEntry[]; categories: Map<string, string[]> }> {
  onProgress?.("Fetching sitemap.xml …");
  const { slugs, totalPalUrls } = await fetchSlugIndexFromSitemap();
  onProgress?.(
    `Sitemap: ${totalPalUrls} PAL URLs → ${slugs.length} topic roots`
  );

  onProgress?.("Enriching categories from Elasticsearch …");
  const categories = await enrichFromElasticsearch();
  onProgress?.(
    categories.size > 0
      ? `ES enrichment: ${categories.size} topics with DET categories`
      : "ES enrichment unavailable — AI tags will be used for categories"
  );

  return { slugs, categories };
}

// ─── PAL HTML Parser (§4 + addendum tab vocabulary) ──────────────────────────

/**
 * Extract all structured metadata from a /pal/{slug}/print-all page.
 *
 * Tab vocabulary (addendum): first tab is one of:
 *   policy | overview | policy-and-guidelines | procedure | advice
 * Chapter parents: guidance | policy-and-guidelines | procedure | procedures
 * Do not hardcode — treat the segment after the topic slug as open vocabulary.
 *
 * Date precedence (addendum):
 *   1. "Reviewed {date}" / "Policy last updated" from page body  ← authoritative
 *   2. <lastmod> from sitemap                                     ← secondary
 *   3. ES "changed" field                                         ← never surface
 */
function parsePrintAllPage(
  $: cheerio.CheerioAPI,
  slug: string,
  pageUrl: string,
  sitemapLastmod: string | null,
  esCategories: string[]
): { metadata: PalDocMetadata; title: string; text: string } {
  // ── Title ──────────────────────────────────────────────────────────────────
  const title = $("h1").first().text().trim() || slug;

  // ── Category ───────────────────────────────────────────────────────────────
  // Prefer DET's own ES categories; fall back to page DOM
  let categories: string[] = esCategories;
  if (categories.length === 0) {
    const domCategory = $(
      ".field--name-field-category, .category-label, [class*='category'], .topic-category"
    )
      .first()
      .text()
      .trim();
    if (domCategory) categories = [domCategory];
  }

  // ── Policy last updated & reviewed date ───────────────────────────────────
  // Authoritative: parsed from page body. Sitemap lastmod is secondary.
  const policyLastUpdated = extractLabelledValue($, ["Policy last updated", "Last updated"], [
    ".policy-updated",
    ".field--name-field-policy-date",
    "[class*='updated']",
  ]);

  const reviewedDate = (() => {
    let found: string | null = null;
    $("*").each((_, el) => {
      const text = $(el).clone().children().remove().end().text().trim();
      const m = text.match(
        /reviewed\s+(\w+\s+\d{4}|\d{1,2}\s+\w+\s+\d{4})/i
      );
      if (m && !found) found = m[1];
    });
    return found;
  })();

  // ── Scope ──────────────────────────────────────────────────────────────────
  const scope = extractLabelledValue($, ["Scope", "Applies to"], [
    ".field--name-field-scope",
    "[class*='scope']",
  ]);

  // ── Contact ────────────────────────────────────────────────────────────────
  const contactBlock = $(
    ".field--name-field-contact, [class*='contact-block'], .contact-info"
  )
    .first()
    .text()
    .trim();

  let contactDivision: string | null = null;
  let contactEmail: string | null = null;

  if (contactBlock) {
    const emailMatch = contactBlock.match(/[\w.+-]+@[\w.-]+\.\w+/);
    if (emailMatch) contactEmail = emailMatch[0];
    contactDivision =
      contactBlock
        .replace(contactEmail ?? "", "")
        .replace(/[|,]/g, "")
        .trim() || null;
  }
  if (!contactEmail) {
    const bodyText = $("body").text();
    const m = bodyText.match(/[\w.+-]+@education\.vic\.gov\.au/);
    if (m) contactEmail = m[0];
  }

  // ── Related policies ────────────────────────────────────────────────────────
  const relatedPolicies: Array<{ slug: string; title: string }> = [];
  let inRelated = false;
  $("h2, h3, h4, a[href]").each((_, el) => {
    const tagName = (el as { tagName?: string }).tagName?.toLowerCase() ?? "";
    if (/^h[2-4]$/.test(tagName)) {
      inRelated = $(el).text().toLowerCase().includes("related");
      return;
    }
    if (tagName === "a" && inRelated) {
      const href = $(el).attr("href") ?? "";
      const relSlug = slugFromPathname(new URL(href, PAL_BASE).pathname);
      const relTitle = $(el).text().trim();
      if (relSlug && relTitle) relatedPolicies.push({ slug: relSlug, title: relTitle });
    }
  });

  // ── Resource links ─────────────────────────────────────────────────────────
  const resourceLinks: Array<{ url: string; title: string; loginRequired: boolean }> = [];
  const resourceSection = $("[class*='resource'], #resources, .attachments").first();
  (resourceSection.length ? resourceSection : $("body"))
    .find("a[href]")
    .each((_, el) => {
      const href = $(el).attr("href") ?? "";
      if (!href || href.startsWith("javascript:")) return;
      try {
        const abs = new URL(href, pageUrl).href;
        const host = new URL(abs).hostname;
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
      } catch { /* ignore */ }
    });

  // ── Chapters — open tab vocabulary (addendum) ─────────────────────────────
  // Log any unrecognised first-tab segments (covered by open vocab note)
  const chapters: string[] = [];
  const STRUCTURAL = new Set([
    "Policy", "Overview", "Summary", "Resources", "Contact",
    "Related policies", "Policy and guidelines", "Procedure", "Advice",
    "Guidance",
  ]);
  $("main, article, [role=main], .content, body")
    .first()
    .find("h2, h3")
    .each((_, el) => {
      const text = $(el).text().trim();
      if (text && !STRUCTURAL.has(text)) chapters.push(text);
    });

  // ── Body text extraction ────────────────────────────────────────────────────
  $(
    "script, style, noscript, nav, header, footer, aside, .nav, .header, .footer, .sidebar, .menu, .breadcrumb, .cookie-banner, [role=navigation], [role=banner], [role=contentinfo]"
  ).remove();

  const main = $(
    "main, article, [role=main], .content, .page-content, #content, #main"
  ).first();
  const container = main.length ? main : $("body");
  const parts: string[] = [];

  container
    .find("h1,h2,h3,h4,h5,h6,p,li,td,th,dt,dd,blockquote")
    .each((_, el) => {
      const tag = (el as { tagName?: string }).tagName?.toLowerCase() ?? "";
      const text = $(el).text().replace(/\s+/g, " ").trim();
      if (!text || text.length < 10) return;
      parts.push(/^h[1-6]$/.test(tag) ? `\n## ${text}\n` : text);
    });

  const text = parts.join("\n").trim();

  const metadata: PalDocMetadata = {
    topicSlug: slug,
    category: categories[0] ?? null,
    categories,
    policyLastUpdated: policyLastUpdated || null,
    reviewedDate: reviewedDate || null,
    sitemapLastmod,
    scope: scope || null,
    contactDivision: contactDivision || null,
    contactEmail: contactEmail || null,
    relatedPolicies,
    resourceLinks,
    chapters,
  };

  return { metadata, title, text };
}

function extractLabelledValue(
  $: cheerio.CheerioAPI,
  labels: string[],
  selectors: string[]
): string | null {
  for (const sel of selectors) {
    const val = $(sel).first().text().trim();
    if (val) return val;
  }
  for (const label of labels) {
    let found: string | null = null;
    $("dt, th, strong, b, label, p, div").each((_, el) => {
      const text = $(el).text().trim();
      if (text.toLowerCase().startsWith(label.toLowerCase())) {
        const sibling = $(el).next();
        found = sibling.length
          ? sibling.text().trim() || null
          : text.replace(new RegExp(`^${label}[:\\s]*`, "i"), "").trim() || null;
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
  sitemapLastmod: string | null,
  esCategories: string[],
  _jobId: number
): Promise<boolean> {
  if (html.length > MAX_HTML_BYTES) {
    logger.warn({ slug, size: html.length }, "print-all page too large, skipping");
    return false;
  }

  const $ = cheerio.load(html);
  const { metadata, title, text } = parsePrintAllPage(
    $, slug, pageUrl, sitemapLastmod, esCategories
  );

  if (text.length < 200) {
    logger.warn({ slug }, "print-all page has insufficient content");
    return false;
  }

  const tags = await autoTagDocument(text);
  const status = (tags.confidenceScore ?? 0) >= 0.75 ? "approved" : "pending";

  // Upsert: replace existing document for this sourceUrl
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
        policyDomain: metadata.categories[0] ?? tags.policyDomain,
        documentType: tags.documentType,
        audience: tags.audience,
        confidenceScore: tags.confidenceScore,
        status,
        palMetadata: metadata as unknown,
        updatedAt: new Date(),
      })
      .where(eq(documents.id, docId));
    await db
      .delete(documentChunks)
      .where(eq(documentChunks.documentId, docId));
  } else {
    const [doc] = await db
      .insert(documents)
      .values({
        filename: title.slice(0, 255),
        fileType: "pal-page",
        rawText: text,
        title: tags.title ?? title,
        issuingAuthority: tags.issuingAuthority,
        policyDomain: metadata.categories[0] ?? tags.policyDomain,
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

  // §4 chunking — split on ## headings
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

  // Wiki generation (non-blocking)
  upsertWikiPage(docId, text).catch((err) =>
    logger.warn({ slug, err }, "Wiki page generation failed")
  );

  // Detect lastmod changes for the alert system
  const [existingSlug] = await db
    .select({ sitemapLastmod: palSlugs.sitemapLastmod })
    .from(palSlugs)
    .where(eq(palSlugs.slug, slug));

  const lastmodChanged = !!(
    existingSlug?.sitemapLastmod &&
    sitemapLastmod &&
    existingSlug.sitemapLastmod !== sitemapLastmod
  );

  const now = new Date();

  // Update slug index
  await db
    .insert(palSlugs)
    .values({
      slug,
      title,
      category: metadata.categories[0] ?? null,
      lastCrawled: now,
      sitemapLastmod,
      policyLastUpdated: metadata.policyLastUpdated,
      reviewedDate: metadata.reviewedDate,
    })
    .onConflictDoUpdate({
      target: palSlugs.slug,
      set: {
        title,
        category: metadata.categories[0] ?? null,
        lastCrawled: now,
        sitemapLastmod,
        policyLastUpdated: metadata.policyLastUpdated,
        reviewedDate: metadata.reviewedDate,
        isRetired: false,
        retiredAt: null,
        updatedAt: now,
        // When lastmod has advanced, raise an alert and clear any previous acknowledgement
        ...(lastmodChanged
          ? { changeDetectedAt: now, changeAcknowledgedAt: null }
          : {}),
      },
    });

  return true;
}

// ─── Job progress helpers ─────────────────────────────────────────────────────

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

// ─── Fallback: crawl individual sitemap URLs for a topic ─────────────────────

/**
 * If print-all returns non-200, fall back to crawling the topic's individual
 * sitemap URLs (addendum: "fall back to crawling that topic's sitemap URLs individually").
 */
async function crawlTopicFallback(
  entry: SlugEntry,
  esCategories: string[],
  jobId: number
): Promise<boolean> {
  // Filter to HTML-likely URLs (skip attachments / external)
  const htmlUrls = entry.sitemapUrls.filter(
    (u) =>
      u.startsWith(PAL_BASE) &&
      !u.match(/\.(pdf|docx|doc|xlsx|pptx|zip)$/i)
  );

  // Only import the most content-rich tab — prefer policy/overview/procedure pages
  const prioritised = [
    ...htmlUrls.filter((u) =>
      /\/(policy|overview|policy-and-guidelines|procedure|advice)$/.test(u)
    ),
    ...htmlUrls,
  ];

  for (const url of prioritised.slice(0, 3)) {
    await sleep(REQUEST_DELAY_MS);
    let res: Response;
    try {
      res = await fetchWithTimeout(url);
    } catch {
      continue;
    }
    if (!res.ok) continue;
    const html = await res.text();
    const ok = await importPalPage(
      entry.slug, url, html, entry.lastmod, esCategories, jobId
    );
    if (ok) return true;
  }
  return false;
}

// ─── Main job runners ─────────────────────────────────────────────────────────

/**
 * Full two-pass PAL crawl.
 * Pass 1: sitemap slug index + ES category enrichment.
 * Pass 2: print-all fetch for each slug; fallback to sitemap URLs on non-200.
 */
export async function runPalFullCrawl(jobId: number): Promise<void> {
  await updateJobProgress(jobId, {
    status: "running",
    currentUrl: "Fetching sitemap.xml …",
  });

  try {
    const { slugs, categories } = await buildSlugIndex((msg) => {
      updateJobProgress(jobId, { currentUrl: msg }).catch(() => {});
    });

    if (!slugs.length) {
      await updateJobProgress(jobId, {
        status: "failed",
        error:
          "Sitemap returned 0 topic roots. The site structure may have changed.",
        completedAt: new Date(),
      });
      return;
    }

    await updateJobProgress(jobId, { urlsFound: slugs.length });

    let processed = 0;
    let imported = 0;
    let skipped = 0;
    const limit = pLimit(CONCURRENCY);
    const batchSize = 10;

    for (let i = 0; i < slugs.length; i += batchSize) {
      if (await isCancelled(jobId)) {
        logger.info({ jobId }, "PAL full crawl cancelled");
        return;
      }

      const batch = slugs.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map((entry) =>
          limit(async () => {
            const url = printAllUrl(entry.slug);
            await updateJobProgress(jobId, { currentUrl: url });
            await sleep(REQUEST_DELAY_MS);

            let res: Response;
            try {
              res = await fetchWithTimeout(url);
            } catch (err) {
              logger.warn({ slug: entry.slug, err }, "Failed to fetch print-all");
              return false;
            }

            // §5: tombstone 404s
            if (res.status === 404) {
              await db
                .insert(palSlugs)
                .values({ slug: entry.slug, isRetired: true, retiredAt: new Date() })
                .onConflictDoUpdate({
                  target: palSlugs.slug,
                  set: {
                    isRetired: true,
                    retiredAt: new Date(),
                    updatedAt: new Date(),
                  },
                });
              return false;
            }

            if (res.ok) {
              const html = await res.text();
              const esCategories = categories.get(entry.slug) ?? [];
              return importPalPage(
                entry.slug, url, html, entry.lastmod, esCategories, jobId
              );
            }

            // Non-200, non-404: try individual sitemap URLs
            logger.warn(
              { slug: entry.slug, status: res.status },
              "print-all non-200, trying sitemap fallback"
            );
            const esCategories = categories.get(entry.slug) ?? [];
            return crawlTopicFallback(entry, esCategories, jobId);
          })
        )
      );

      for (const r of results) {
        processed++;
        if (r) imported++;
        else skipped++;
      }

      await updateJobProgress(jobId, {
        urlsProcessed: processed,
        docsImported: imported,
        docsSkipped: skipped,
      });
    }

    await updateJobProgress(jobId, {
      status: "completed",
      currentUrl: null,
      urlsFound: slugs.length,
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
 * Maintenance crawl — uses sitemap <lastmod> to detect changed topics.
 *
 * Date comparison logic:
 *   Fetch sitemap; compare each slug's <lastmod> against stored sitemapLastmod.
 *   If sitemap lastmod > stored → re-crawl. Also accepts a sinceDate fallback
 *   for first runs where no stored lastmod exists.
 */
export async function runPalMaintenanceCrawl(
  jobId: number,
  sinceDate: Date
): Promise<void> {
  await updateJobProgress(jobId, {
    status: "running",
    currentUrl: "Fetching sitemap for change detection …",
  });

  try {
    const { slugs, categories } = await buildSlugIndex((msg) => {
      updateJobProgress(jobId, { currentUrl: msg }).catch(() => {});
    });

    // Load stored lastmod values for all slugs
    const stored = await db.select().from(palSlugs);
    const storedBySlug = new Map(stored.map((r) => [r.slug, r]));

    // Determine which slugs need re-crawling
    const toUpdate = slugs.filter((entry) => {
      const row = storedBySlug.get(entry.slug);
      if (!row) return true; // never seen before

      // Compare sitemap lastmod
      if (entry.lastmod && row.sitemapLastmod) {
        return entry.lastmod > row.sitemapLastmod;
      }

      // Fall back to sinceDate comparison against lastCrawled
      if (row.lastCrawled) {
        return new Date(row.lastCrawled) < sinceDate;
      }

      return true; // no crawl date stored → include
    });

    // Also detect retired topics (in DB but not in sitemap)
    const sitemapSlugSet = new Set(slugs.map((s) => s.slug));
    const retiredCandidates = stored.filter(
      (r) => !r.isRetired && !sitemapSlugSet.has(r.slug)
    );
    for (const r of retiredCandidates) {
      await db
        .update(palSlugs)
        .set({ isRetired: true, retiredAt: new Date(), updatedAt: new Date() })
        .where(eq(palSlugs.slug, r.slug));
      logger.info({ slug: r.slug }, "PAL topic tombstoned — no longer in sitemap");
    }

    logger.info(
      {
        jobId,
        toUpdate: toUpdate.length,
        retired: retiredCandidates.length,
      },
      "PAL maintenance: topics to re-crawl"
    );

    await updateJobProgress(jobId, { urlsFound: toUpdate.length });

    let processed = 0;
    let imported = 0;
    let skipped = 0;
    const limit = pLimit(CONCURRENCY);

    const results = await Promise.all(
      toUpdate.map((entry) =>
        limit(async () => {
          if (await isCancelled(jobId)) return false;

          const url = printAllUrl(entry.slug);
          await updateJobProgress(jobId, { currentUrl: url });
          await sleep(REQUEST_DELAY_MS);

          let res: Response;
          try {
            res = await fetchWithTimeout(url);
          } catch {
            return false;
          }

          if (res.status === 404) {
            await db
              .update(palSlugs)
              .set({ isRetired: true, retiredAt: new Date(), updatedAt: new Date() })
              .where(eq(palSlugs.slug, entry.slug));
            return false;
          }

          if (!res.ok) {
            const esCategories = categories.get(entry.slug) ?? [];
            return crawlTopicFallback(entry, esCategories, jobId);
          }

          const html = await res.text();
          const esCategories = categories.get(entry.slug) ?? [];
          return importPalPage(
            entry.slug, url, html, entry.lastmod, esCategories, jobId
          );
        })
      )
    );

    for (const r of results) {
      processed++;
      if (r) imported++;
      else skipped++;
    }

    await updateJobProgress(jobId, {
      status: "completed",
      currentUrl: null,
      urlsFound: toUpdate.length,
      urlsProcessed: processed,
      docsImported: imported,
      docsSkipped: skipped,
      completedAt: new Date(),
    });

    logger.info({ jobId, imported, retired: retiredCandidates.length }, "PAL maintenance completed");
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
 * Fallback link-graph crawl from the enrolment hub.
 * Use only if sitemap-based discovery fails.
 */
export async function runPalFallbackCrawl(
  jobId: number,
  maxDepth = 5,
  maxPages = 4000
): Promise<void> {
  const ENROLMENT_HUB = `${PAL_ROOT}/enrolment/policy`;
  await updateJobProgress(jobId, { status: "running", currentUrl: ENROLMENT_HUB });

  const visited = new Set<string>();
  const queue: Array<[string, number]> = [[ENROLMENT_HUB, 0]];
  visited.add(ENROLMENT_HUB);

  let processed = 0;
  let imported = 0;
  let skipped = 0;
  const limit = pLimit(CONCURRENCY);

  try {
    while (queue.length > 0 && processed < maxPages) {
      if (await isCancelled(jobId)) return;

      const batch = queue.splice(0, CONCURRENCY);
      const results = await Promise.all(
        batch.map(([url, depth]) =>
          limit(async () => {
            if (!url.startsWith(`${PAL_BASE}/pal/`) || isBlocked(url)) {
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

            const links: string[] = [];
            if (depth < maxDepth) {
              $("a[href]").each((_, el) => {
                const href = $(el).attr("href") ?? "";
                try {
                  const abs = new URL(href, PAL_BASE).href;
                  if (abs.startsWith(`${PAL_BASE}/pal/`) && !visited.has(abs) && !isBlocked(abs)) {
                    visited.add(abs);
                    links.push(abs);
                  }
                } catch { /* ignore */ }
              });
            }

            let pageImported = false;
            if (new URL(url).pathname.endsWith("/print-all")) {
              const slug = slugFromPathname(new URL(url).pathname) ?? url.split("/")[4];
              if (slug) {
                pageImported = await importPalPage(slug, url, html, null, [], jobId);
              }
            }

            return { url, links, imported: pageImported };
          })
        )
      );

      for (const r of results) {
        processed++;
        if (r.imported) imported++;
        else skipped++;
        const [, depth] = batch.find(([u]) => u === r.url) ?? [r.url, 0];
        for (const link of r.links) queue.push([link, depth + 1]);
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
  const lastCrawled =
    rows
      .filter((r) => r.lastCrawled)
      .sort(
        (a, b) =>
          (b.lastCrawled?.getTime() ?? 0) - (a.lastCrawled?.getTime() ?? 0)
      )[0]?.lastCrawled ?? null;

  const byCategory: Record<string, number> = {};
  for (const r of active) {
    if (r.category) byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
  }

  return {
    total: rows.length,
    active: active.length,
    retired: retired.length,
    lastCrawled,
    byCategory,
  };
}
