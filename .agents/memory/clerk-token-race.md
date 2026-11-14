---
name: Clerk browser authentication
description: Why the former explicit-token workaround must not be restored to the web client.
---

Use the current Clerk skill's canonical cookie-based web authentication and production proxy wiring, not an explicit browser token getter.

**Why:** An earlier attempt treated preview 401s as a token-registration race and added a layout-effect/token-refresh workaround. That is superseded by the managed Clerk integration requirements. A working preview did not establish production readiness: missing production proxy wiring left the published app stuck waiting for authentication.

**How to apply:** Reload the Clerk setup and troubleshooting guidance before changing authentication. Investigate browser cookies and middleware for web 401s; reserve bearer-token handling for standalone/mobile clients. Validate preview and production separately, since only production uses the managed proxy.
