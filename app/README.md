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

Needs Node.js 24 (it runs TypeScript directly, no build step for the server).

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

## Accounts and access

- **Platform owner:** the account whose email matches `OWNER_EMAIL`, or the first account if that's blank. Manages the
  AI key, models, the PAL library, school invitations and backups (Settings → Platform).
- **New schools** need a single-use invitation link from the owner (valid 14 days), unless `SCHOOL_SIGNUP=open`.
  `ALLOWED_EMAIL_DOMAINS` can restrict every sign-up to certain email domains.
- **Staff** join their school with its join code. School admins can make other staff admins, remove them, or give them
  a one-time password, which they must change at their next sign-in.
- **Locked out?** On the server run `npm run reset-password -- someone@example.com` for a one-time password.
- **Limits:** 10 failed sign-ins per account (and 40 per address) every 15 minutes, 10 sign-ups per address an hour,
  and 120 questions per person an hour.

## Deploying to Railway

1. **New project → Deploy from GitHub repo**, pick this repository and the branch with `app/`.
2. In the service's **Settings**:
   - **Root Directory:** `app`. Railway runs `npm run build` and `npm start` from `package.json` (Node 24).
   - **Healthcheck Path:** `/api/health`.
   - **Replicas:** 1. Background jobs and the database live in the one process.
3. **Add a Volume** mounted at `/data` (5 GB is plenty). Without it, every deploy starts from an empty database.
4. **Variables:** `POLICYPILOT_DATA_DIR=/data`, `OWNER_EMAIL=you@example.com`, `ANTHROPIC_API_KEY=…`
   (optionally `ALLOWED_EMAIL_DOMAINS`). Railway sets `PORT` itself.
5. **Networking → Custom Domain:** enter your domain and add the DNS record Railway shows at your domain registrar.
   HTTPS is set up automatically once the record resolves.
6. After the first deploy, sign up with the `OWNER_EMAIL` address straight away, then in Settings choose the models,
   load the PAL library (about 15 minutes) and make invitation links for schools.

Allow about 1–1.5 GB of memory: the search model runs inside the app, and loading PAL is CPU-heavy for a while.
A copy of the database is kept for each of the last 7 days in `/data/backups`; download one now and then from
Settings → Platform → Backups and store it elsewhere.

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
