---
title: "Subscription seats"
description: "Select a subscription login with an account-pinned seat."
---

Use `<seat>@<account>` to select a local subscription login:
`claude-code:opus@claude-9`, `opus@claude-2`, `sol@codex-3`, or
`openai:gpt-6.1-sol@codex-default`.

`SMITHERS_ACCOUNTS_DIR` defaults to `~/.smithers/accounts`. Claude accounts
select `CLAUDE_CONFIG_DIR`; Codex accounts select `CODEX_HOME` with
`SMITHERS_OPENAI_AUTH=chatgpt`. `codex-default` uses `~/.codex`.
Pinned seats bypass ambient API keys, pools, and proxies. Unknown accounts,
missing logins, and incompatible seats fail with `SeatUnresolved` naming the
account. The declared seat ID remains unchanged in the journal.

Login status is cached for 30 seconds. After signing in or out, retry seat
resolution once that cache expires; execution still reports authentication
failures from the selected account.
