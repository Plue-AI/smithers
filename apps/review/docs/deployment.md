---
title: Review Worker deployment
description: Qualification and outstanding Cloud rollout requirements for the review Worker.
---

## Qualification

`pnpm -C apps/review deploy` refuses publication. The package command cannot
establish a Cloud lease or authenticate qualification receipts. There is no
local environment-variable or file-receipt bypass.

The Cloud host composes `qualifiedWorkerHost("review", artifact, ports)` from
`flows/rollout/worker.ts` with the existing `flows/rollout/host.ts`
`executionLayer`. The host must read its own trusted receipts; the adapter
validates their identity relationships, not their authenticity. Never construct
qualification from request JSON or an operator-supplied receipt file.

Before publication, the host reconciles interrupted releases, verifies its
exclusive lease and captured live version, and reads qualification again:

- A passing `//apps/review/...` gate for the exact main revision.
- An immutable artifact with that revision and SHA-256, published without rebuilding.
- Adoption evidence for that artifact preserving the existing Worker, D1, R2
  and API hostname, with no replacement of data-bearing resources.
- D1 readback of every migration in `src/server/migrations.ts`, including
  `0002_repository_identity.sql` and `0003_allowed_workflow_refs.sql`.

The adapter inserts a required deployed-artifact check into the shared rollout
and requires a `service-response` check. The host reads the deployed version's
source and digest, never the newest upload. It records gate, artifact, adoption,
migration, deployment and restoration evidence durably with the existing run
output. A successful launch is not successful deployment.

## Containment and restoration

Prioritize the host-denial source without waiting for a new content domain.
Temporary publishing unavailability is accepted. Required live checks include
404 without uploaded HTML on the API and workers.dev hosts, preview settings
readback, denial on an old-version preview, and cached and fresh upload URLs.
Retain cache-purge evidence where applicable; previously downloaded or cached
HTML cannot be recalled. The private host must prevent restoration of a version
that serves uploaded HTML on a product origin, even when service probes fail.
These checks and restoration policy are private host obligations, not checks
implemented by the qualification adapter.

## Remaining deployment evidence

[#2276](https://github.com/smithersai/smithers/issues/2276) owns leased Cloud
execution, interruption reconciliation and run-card publication.
[#1907](https://github.com/smithersai/smithers/issues/1907) owns duplicate-name
resolution and verified repository identity backfill before migration. Keep
credentials, actual resource inventories and hosted configuration in the
private deployment repository.

[#1906](https://github.com/smithersai/smithers/issues/1906) remains open until
resource adoption, migration readback, exact-source deployment and service
checks succeed through that Cloud host. The adapter and local tests do not
prove production deployment or containment. Full publishing restoration also
requires the separate content domain, session publish/inference and deletion
checks described in the private runbook.
