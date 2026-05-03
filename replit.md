# PolicyPilot

## Overview

AI-powered school policy intelligence platform for Australian K-12 schools. pnpm workspace monorepo using TypeScript. Upload PDF/DOCX/TXT policy documents, AI auto-tags them via Claude, RAG-powered chat with citations, document library with filters, and an admin review queue.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **Frontend**: React + Vite (artifact: `policy-pilot`, port from `$PORT`, preview `/`)
- **Auth**: Clerk (`@clerk/react` v6 + `@clerk/express`) — uses `useAuth()` hook (no `SignedIn`/`SignedOut` components in v6)
- **Backend**: Express 5 (artifact: `api-server`, port 8080)
- **Database**: PostgreSQL + Drizzle ORM (lib: `@workspace/db`)
- **AI**: Anthropic Claude via Replit AI Integrations (`@workspace/integrations-anthropic-ai`)
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from `lib/api-spec/openapi.yaml` → `@workspace/api-client-react` + `@workspace/api-zod`)
- **File parsing**: `pdf-parse`, `mammoth`, built-in Buffer for TXT
- **Build**: esbuild (ESM bundle for api-server)

## Database Tables

- `documents` — uploaded policy files with AI-generated metadata (title, domain, type, audience, confidence score, status)
- `document_chunks` — chunked text for RAG retrieval (800 words, 100 overlap)
- `chat_sessions` — per-user conversation threads
- `chat_messages` — messages with citations JSON

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec (also fixes api-zod/src/index.ts barrel)
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

## API Routes (all under /api)

- `GET /healthz` — health check
- `GET /documents` — list with filters (domain, documentType, audience, status, search)
- `POST /documents/upload` — multer multipart upload; AI tagging runs async via setImmediate
- `GET /documents/review-queue` — pending (low confidence) docs
- `GET /documents/:id` — single doc
- `PATCH /documents/:id` — update metadata + status
- `DELETE /documents/:id` — delete
- `GET /chat/sessions` — list sessions for user
- `POST /chat/sessions` — create session
- `GET /chat/sessions/:id` — session with messages
- `POST /chat/sessions/:id/messages` — send message (triggers RAG)
- `GET /stats/summary` — total/approved/pending/processing counts
- `GET /stats/by-domain` — counts per domain

## AI Pipeline

- **Auto-tagging**: Claude claude-opus-4-5 extracts title, issuing authority, domain, type, audience, confidence score from first 4000 chars. Docs with score ≥ 0.7 auto-approved; others go to review queue.
- **RAG chat**: Keyword search over `document_chunks` → top 8 chunks as context → Claude claude-opus-4-5 answers with numbered citations.

## Codegen Notes

Orval generates `lib/api-zod/src/index.ts` with extra barrel exports that don't exist. The codegen script (`lib/api-spec/package.json`) uses a `node -e` inline script to rewrite the barrel to only `export * from "./generated/api"` after orval runs.

## Frontend Pages

- `/` — Dashboard (stats cards + domain bar chart)
- `/library` — Document library with multi-filter search
- `/upload` — Drag-and-drop upload with per-file status
- `/chat` — RAG chat with session sidebar and source citations
- `/review` — Admin review queue with edit dialog
