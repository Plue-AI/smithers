---
title: "Share results through a remote cache"
description: "Declare a shared cache, choose a credential shape, publish from CI under a trust domain, and diagnose a remote that is not answering."
sidebar:
  order: 3
---

A remote cache turns one machine's work into every machine's cache hit. This
is how to wire one up and how to tell whether it is working.

## Declare the remote

The remote is the `remote` field of the workspace cache declaration:

```ts
import { Smithers as S } from "@smthrs/targets"

export const Workspace = S.Workspace("demo", {
  repository: "git+https://example.invalid/demo.git",
  cache: S.Cache({
    directory: ".flows",
    remote: S.RemoteCache.make({
      endpoint: "https://cache.example.com",
      read: S.Secret("SMITHERS_CACHE_READ_TOKEN"),
      write: S.Secret("SMITHERS_CACHE_WRITE_TOKEN")
    })
  })
  // the rest of the declaration
})
```

The endpoint must be an absolute HTTPS URL with no userinfo, query, or
fragment. Anything else fails the declaration.

## Choose a credential shape

Pick the one that matches who is allowed to publish.

**One credential for both directions.** Everyone who can read can publish.

```ts
S.RemoteCache.make({ endpoint, token: S.Secret("SMITHERS_CACHE_TOKEN") })
```

Omitting `token` entirely defaults to that same name, so this is also what a
bare `S.RemoteCache.make({ endpoint })` means.

**Split read and write.** Developers get the read credential; CI gets both.
Use `read` plus `write`, as in the declaration above. `token` and `read` name
the same slot and are mutually exclusive.

**A committed public read token.** Reads use a literal committed to the
repository, and only writes need a credential from the environment:

```ts
S.RemoteCache.make({
  endpoint,
  publicReadToken: "smithers_cachero_0123456789abcdef0123456789abcdef01234567",
  write: S.Secret("SMITHERS_CACHE_WRITE_TOKEN")
})
```

The literal can only read that one repository's cache, which is the same
posture as a read-only access token in other build caches. It is exclusive
with `token` and `read`.

## Point one machine somewhere else

`SMITHERS_CACHE_URL` overrides the declared endpoint for one process:

```bash
SMITHERS_CACHE_URL=https://cache.staging.example.com \
  pnpm exec smithers-build ci '//packages/...'
```

The override changes the endpoint only. Which credentials the workspace
declared is unchanged, so a split read and write pair survives it.

The process entry point reads `SMITHERS_CACHE_URL` and `SMITHERS_CACHE_TOKEN`
once and deletes both from the environment before any declaration evaluates,
so no workspace module can read them, and both are stripped from every spawned
tool's environment.

## Publish from an untrusted job under a namespace

A pull-request build should read the trusted cache and publish somewhere that
cannot poison it. `SMITHERS_CACHE_NAMESPACE` is that boundary:

```bash
SMITHERS_CACHE_NAMESPACE="pr-${PR_NUMBER}" \
  pnpm exec smithers-build ci '//packages/...'
```

Set, results publish under `<namespace>/<key>`. Unset means the trusted
domain, which is what a post-merge build has. Which domain a job belongs to is
a property of the job rather than of the workspace it builds, which is why it
is an environment variable rather than a declaration.

A job whose credential may not publish still reads everything. A refused
publication stops publication only; it never fails the run.

## Decide whether to publish from CI

Publishing pays only when results are shareable. A result is shared only when a
confined run produced it, so a workspace whose default sandbox is
`S.Sandbox.None()` publishes nothing, and the runner warns once that
publication was skipped. Most targets (formatters, typecheck, test suites) are
not cacheable at all, so a remote saves little on them.

Smithers' own CI reads the remote and has no publishing job for that reason.
Restore one only after the CI targets run sandboxed and a dry run shows
publications: declare `publishesToCache` on a trunk-only job and pair it with
the write credential and environment described above.

## Tell whether it is working

The transport reads through HTTP `/ac`. A local hit avoids the network, a
remote hit hydrates the local entry, and a put publishes to both tiers.

| Symptom                                        | What it means                                                                      |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| One warning, then no further remote activity   | A remote failure disabled the remote for the rest of the process.                  |
| A `409` warning                                | Two jobs published the same key. The first result stands.                          |
| Everything runs on a machine you expect to hit | The key moved. Compare `--plan` key previews between the two machines.             |
| A `publication skipped` warning                | A result ran unconfined (`sandbox: "none"` or `S.Sandbox.None()`) and stays local. |

To compare keys across machines, run the same pattern with `--plan` on both
and diff the key previews, or set `SMTHRS_DEBUG_KEYS=<file>` to append every
node's full key material to a file. The usual culprits are in `ambient`: a
different Node version, platform, or architecture, or a different lockfile
digest.

## Related

- [Caching](../concepts/caching.md): what a key covers, and what the
  content-addressed store guarantees.
- [Target execution](../concepts/execution.md): why an unconfined result stays
  local.
