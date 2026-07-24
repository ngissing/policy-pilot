---
name: PAL crawl spec
description: Key constraints and decisions for ingesting the DET Policy and Advisory Library
---

**Rule:** Never seed the generic BFS crawler at /pal — the A–Z filter is client-rendered and returns an empty shell (§2 trap).

**Slug discovery:** Fetch /pal/recently-updated (server-rendered, complete since 2020) + one-hop BFS from enrolment/policy via related-policies links. This is a best-effort alternative to the unknown A–Z JSON API endpoint (§7 open item — capture via DevTools Network → XHR → click a letter).

**Canonical form:** Index print-all only (`/pal/{slug}/print-all`). Exclude /policy, /guidance/*, /resources tabs to avoid triple-duplication (§4).

**Why:** /pal/recently-updated is authoritative for what has changed and links to all topics. print-all is a complete self-contained policy document — correct granularity for RAG chunking.

**How to apply:** When the A–Z endpoint is captured, replace the `buildSlugIndex()` function in `palCrawler.ts` Pass 1 with a direct API call. The endpoint and params go in §7 of the spec file at `attached_assets/Pasted--PAL-Crawl-Ingestion-Spec-Reference-document-for-scrapi_1784885919924.txt`.

**Hosts:** Allowlist `content.sdp.education.vic.gov.au` for attachments. Blocklist `eduvic.sharepoint.com` (401/403) and `arc.educationapps.vic.gov.au` (not policy content).

**Rate limit:** 600 ms between requests — verify robots.txt confirms this is compliant (§7 open item).
