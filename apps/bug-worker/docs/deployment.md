---
title: Bug Worker deployment
description: Qualification and outstanding Cloud rollout requirements for the bug Worker.
---

`pnpm -C apps/bug-worker deploy` refuses publication until the leased Cloud
rollout supplies trusted qualification. There is no local receipt-file or
environment-variable bypass.

Compose `qualifiedWorkerHost("bug-worker", artifact, ports)` from
`flows/rollout/worker.ts` with the existing rollout execution layer. The host
must authenticate its own passing `//apps/bug-worker/...` gate and immutable
artifact at the exact main revision, and retain adoption evidence for that
artifact. Preserve the Worker, KV namespace, custom domains and the rate-limit Durable
Object namespace; a resource replacement refuses qualification. The review
Worker's D1 migration requirements do not apply to this Worker.

Before publication, reconcile interrupted releases and verify the exclusive
lease and captured live version. Publish the qualified bytes without rebuilding.
The required deployed-artifact check reads the live version's source and digest;
`service-response` verifies this Worker's response. Persist provider resource
IDs, deployed/restored identities and probe receipts in the existing Cloud run
output. Keep credentials and hosted configuration in the private deployment
repository.

[#2276](https://github.com/smithersai/smithers/issues/2276) still owns the leased
Cloud host and interruption recovery. [#1906](https://github.com/smithersai/smithers/issues/1906)
requires an actual adoption plan without data replacement and a successful
source-matched Cloud rollout before completion. Local qualification tests are
not rollout evidence.

The community repository nomination lifecycle is retired in
[#3407](https://github.com/smithersai/smithers/issues/3407). Its completion
namespace and historical KV records must remain intact during rollout;
removing runtime access is not authorization to destroy stored data.
