---
name: Legacy resource-scope backfill
description: Maintains useful School and Department Chat results when explicit resource scope is introduced.
---

When introducing a persisted resource scope to an existing document corpus, backfill every legacy null record before enforcing narrow scope filters. Preserve the prior Department authority heuristic, recognise government/PAL sources as Department, treat URL-based crawler records as External, and treat remaining local records as School.

**Why:** Leaving historic records null makes School and Department Chat appear empty or incomplete immediately after release, even though the documents are still indexed.

**How to apply:** Keep the migration idempotent by updating only null scopes. New uncertain classifications must use the explicit `unknown` value so the legacy backfill never overwrites them.