---
name: Scope-aware RAG retrieval
description: Ensures Chat scope filters do not lose relevant documents during vector candidate selection.
---

When a RAG filter defines a user-visible corpus (such as School or Department), include it in the SQL `WHERE` clause before vector ranking and `LIMIT`. Keep any in-memory filtering only as a defensive check, not as the primary filter.

**Why:** Applying scope after fetching a globally limited set can return no matching documents even when relevant, lower-ranked scoped documents exist just outside that candidate window.

**How to apply:** Add parameterized predicates to every retrieval query that contributes context, including both document chunks and wiki sections. Omit the predicate only for the unrestricted All scope.