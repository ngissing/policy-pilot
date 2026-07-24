---
name: Clerk token race condition fix
description: Root cause and fix for intermittent 401s on API calls in the PolicyPilot frontend
---

**Rule:** Use `useLayoutEffect` (not `useEffect`) to register the Clerk token getter, and always call `getToken({ skipCache: true })`.

**Why:** React Query schedules its initial fetch as a microtask, which runs after `useLayoutEffect` but before `useEffect`. Without `useLayoutEffect`, the token getter is null on first load → 401. Without `skipCache: true`, Clerk reuses a cached JWT that may expire mid-session (60-second window) → intermittent 401s at ~60s intervals.

**How to apply:** In `ClerkTokenSync` (App.tsx), both conditions must hold simultaneously. Changing either one alone does not fully fix the issue.

**Backend side:** Custom `requireAuth` middleware in `middlewares/requireAuth.ts` uses `clerkGetAuth(req, { acceptsToken: "any" })` — returns 401 JSON, never redirects. The `{ acceptsToken: "any" }` option is required; omitting it silently rejects Bearer tokens.
