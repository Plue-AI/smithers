---
title: "Cutover installer recovery"
description: "Authorization and ownership rules for restoring Worker versions and preview settings."
---

## Restore ownership

`scripts/cutover/install.ts prepare` reads provider state and saves a plan. It
does not acquire ownership of preview settings. Calling `restore` after only
`prepare` preserves independently changed previews, including when no gate hook
is configured.

Preview restoration requires a verified `previews-off` journal step from this
execution that has not already been restored. It separately requests
`SMITHERS_CUTOVER_AUTHORIZE` with phase `restore`, action `restore-previews`,
and the original preview step index, worker, and plan digest. A version rollback
authorization does not authorize this setting change. The installer fsyncs the
preview restore intent before writing, verifies the result, and records its
completion. A preview-only change reports `restored` even if the original
version was already live.

Completed restoration retires preview ownership. Later calls preserve foreign
preview changes. If previews are already enabled, pending ownership is retired
without a provider write.

## Refusals and recovery

`CF_RESTORE_PREVIEWS_DRIFT` preserves a changed workers.dev setting.
`CF_RESTORE_PREVIEWS_UNCERTAIN` preserves disabled previews when a disable or
restore write has an unknown outcome. An intent alone cannot establish that
this execution owns the current setting. Inspect the journal and provider
history before resolving the setting through separately authorized operations;
do not fabricate a successful journal receipt to force a retry.

The provider exposes preview booleans without a mutation revision or conditional
write in this installer. Identical-value foreign changes between observations
cannot be distinguished. The gate's deployment lock must exclude competing
writers throughout execution and recovery.

## Local validation

```sh
bun test apps/server/scripts/cutover/install.test.ts
pnpm --filter smithers-server run check
```

The tests call the production prepare, apply, and restore functions against the
repository's in-memory Cloudflare control-plane fixture. They inspect durable
journal entries before intercepted writes. This avoids changing a real account;
it is not evidence of a deployed fix or a live provider rehearsal.
