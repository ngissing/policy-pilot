---
name: PAL crawl spec
description: Key constraints and decisions for ingesting the DET Policy and Advisory Library
---

**Slug discovery (authoritative):** Fetch `https://www2.education.vic.gov.au/sitemap.xml` — flat 656 KB urlset, ~3,406 PAL URLs, 456 topic roots. Health-check: abort if count outside [3000, 4000]. Keep `<lastmod>` per slug for maintenance mode. Implemented in `fetchSlugIndexFromSitemap()`.

**Canonical form:** Index `print-all` only (`/pal/{slug}/print-all`) — not in sitemap, must construct. If print-all returns non-200, fall back to crawling that topic's individual sitemap URLs. Tab vocabulary is open (policy | overview | policy-and-guidelines | procedure | advice) — do not hardcode.

**ES enrichment (optional):** POST to the Elasticsearch endpoint (see `palCrawler.ts` `ES_ENDPOINT` constant) to get DET's own category assignments (up to 2 per topic). Degrades gracefully if CORS-blocked. Never surface ES `changed` field as a review date (bulk migration date 2020-03-11 appears on many topics).

**Date precedence:** page body ("Reviewed…" / "Policy last updated") > sitemap lastmod > ES changed (never).

**Maintenance mode:** Compare sitemap lastmod against stored `sitemapLastmod` in `pal_slugs`. Re-crawl only where sitemap lastmod > stored. Tombstone slugs present in DB but missing from sitemap.

**Known anomalies:** `right-to-disconnect` and `teach-the-future-fellowship-program` lack a /pal/ segment in ES data — their categories may be missing.

**Hosts:** Allowlist `content.sdp.education.vic.gov.au` for attachments. Blocklist `eduvic.sharepoint.com` and `arc.educationapps.vic.gov.au`. Rate limit: 600 ms, verified compliant 24 Jul 2026.
