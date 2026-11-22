# PolicyPilot

Policy answers for Victorian government schools. Staff ask questions in plain words; PolicyPilot searches the
Department's Policy and Advisory Library (PAL) and the school's own documents, then answers with every claim linked
to the passage it came from.

This is a rebuild of the earlier Replit prototype (in `../artifacts`), keeping its core ideas and simplifying everything
around them.

## What it does

- **Ask**: streaming answers that cite numbered sources. Blue tabs are PAL, green tabs are the school's own documents.
  Click a citation to see the exact passage. Search all policies, PAL only, your school only, or a single document.
- **Library**: every PAL topic and school document, with a plain-English briefing (what schools must do, good practice,
  who is responsible, contacts) and the full text.
- **Add documents**: drag-and-drop upload, or **find documents on your school website** — PolicyPilot looks through
  the public site for policies and procedures and you tick which ones to add.
- **Policy checklist**: about 30 policies Victorian government schools commonly hold, matched to the school's documents,
  with flags for overdue reviews and for PAL changes made after the school's last review.
- **PAL updates**: PAL's own change log for the past 12 months, highlighting changes to topics your documents rely on.
- **Schools and staff**: each school has a private space. Admins invite staff with a join code.

## Running it

Needs Node.js 22.18 or later (it runs TypeScript directly, no build step for the server).

```powershell
cd app
npm install
npm run dev
```

Open http://localhost:5173. The first account you create sets up a school and becomes the **platform owner**, who can:

1. Add an Anthropic API key in **Settings** (or put `ANTHROPIC_API_KEY` in `app/.env`). Without a key, search, the
   library and the website finder still work, but questions aren't answered and documents aren't summarised.
2. Load the PAL library from **Settings**. It reads about 455 topics one page at a time (10–15 minutes), then checks
   weekly and only re-reads topics whose sitemap date changed.

For production: `npm run build` then `npm start` (serves the app and API on `PORT`, default 3011). Run one server
process per data folder: background jobs (PAL sync, document processing) live in that process.

## How it works

| Piece | Where | Notes |
|---|---|---|
| Server | `server/` | Express 5, run directly by Node's TypeScript support |
| Storage | `data/policypilot.db` | Built-in `node:sqlite`, with an FTS5 index for keyword search |
| Embeddings | `server/embed.ts` | `all-MiniLM-L6-v2` running locally (downloaded once into `data/models`) |
| Search | `server/search.ts` | Keyword (BM25) and meaning-based search merged with reciprocal rank fusion; neighbouring passages are stitched together so the AI sees whole thoughts |
| Answers | `server/chat.ts` | Claude (`claude-opus-5-5` by default, set `POLICYPILOT_MODEL` to change) streamed to the browser |
| PAL sync | `server/pal.ts` | Sitemap discovery, `print-all` pages, fallback to individual tabs, `/pal/recently-updated` as the change feed, retired topics tombstoned |
| Website finder | `server/finder.ts` | Same-site crawl (150 pages max), honours robots.txt, ranks links by policy keywords |
| Front end | `src/` | React + Vite, plain CSS (`src/app.css`) |

### PAL crawling rules

From the PAL crawl spec in `../attached_assets`: one request at a time with a 600 ms gap, never `/js`, `/img` or `/_nuxt`,
and only the "Policy last updated" date from the page body is shown (the "Date: 16 Mar 2020" block is PAL's migration
date). The sync stops if the sitemap suddenly lists far more or fewer pages than expected. The Department's
Elasticsearch category endpoint isn't used; categories come from the AI (or a local estimate when there's no key).

**Attached guides.** PAL topics link to PDFs and Word files. Most sit on the Department's SharePoint and need a staff
login, so they're skipped. Of the public ones, guides, fact sheets, FAQs and procedures are read and stored under their
topic; blank forms, templates, registers and samples are skipped (`isGuide` in `server/pal.ts`). In November 2026 that
was 32 guides from 289 public links. Guide passages rank slightly below the policy text and are cited as
"Topic › Guide title".

### Costs

Each answer is one Claude call with about 8 passages of context. Each uploaded document is one call for tagging and
its briefing. PAL briefings are written the first time someone opens a topic and then kept.
