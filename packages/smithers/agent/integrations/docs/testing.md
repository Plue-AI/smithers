---
title: "Testing"
description: "Local GitHub fixtures, durable replay, and opt-in live tests."
---

Run `pnpm --filter @smthrs/integrations test`. The suite uses local HTTP
fixtures for GitHub transport, shared channel verification and replay,
and real SQLite storage for durable crash recovery.

The opt-in `GitHubLive.test.ts` needs a test repository and GitHub credentials.
Run a single file with `--coverage.enabled=false`; the full suite retains its
coverage thresholds.
