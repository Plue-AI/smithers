---
title: "The Smithers Cloud-hosted cache"
description: "Zero-configuration cache discovery from a Smithers Cloud remote, the committed public read token, and how publishing stays credentialed."
---

> **Coming soon.** Smithers Cloud has not been released yet. This page describes the interface ahead of general availability; nothing here is reachable on a public account today.

Smithers Cloud hosts a build cache for every repository it serves. It
speaks the same `/ac` and `/cas` protocol as `build.smithers.sh` and the
self-hosted Postgres service, so the CLI, the engine, and their tests do not
know which backend answered. What Smithers Cloud adds is the credential model: a
repository commits a public read token, every clone and every CI job reads the
shared cache with no secret at all, and publishing still needs a real
credential.

## Local first

Nothing changes about the local tier. A local hit never touches the remote, a
remote hit hydrates the local file, a put writes both, and any remote failure
prints one warning and degrades the run to local-only. The Smithers Cloud cache is the
remote tier of the same read-through store.

## Zero configuration in a Smithers Cloud checkout

When the root `PACKAGE.ts` declares no remote cache and `SMITHERS_CACHE_URL` is
unset, `smithers-build` looks at the workspace's git remotes (the colocated
`.git/config`, then the jj git backend's config) for a Smithers Cloud host and uses
that repository's cache endpoint. Reads go out anonymously, which a public
repository answers; a private repository refuses them with 401, and the store
degrades to local-only with the usual single warning. The first time this
happens in a process the CLI says so on standard error and names the command
that makes it permanent:

```text
smthrs: using the Smithers Cloud build cache for acme/app (no declaration; anonymous reads, SMITHERS_CACHE_TOKEN publishes). Run `smthrs cache connect` to commit a read token.
```

`SMITHERS_CACHE_DISCOVERY=0` turns discovery off. `SMITHERS_CLOUD_HOSTS` adds
the hosts of a self-hosted deployment, and `SMITHERS_CLOUD_API_URL` its API
base.

## Committing a read token

```sh
smithers cache connect
```

mints a public read token for the repository and writes one line into the
root `PACKAGE.ts`, after the imports:

```ts
export const remoteCache = Smithers.RemoteCache.smithersCloud({
  repo: "acme/app",
  publicReadToken: "smithers_cachero_…"
})
```

Commit it. The token has exactly one power: reading `acme/app`'s cache. It is
refused with `403` on every `PUT` and `DELETE` before the body is read, it is
not accepted on any other repository's cache, and the general token loader
never accepts its shape, so it authenticates nothing else on Smithers Cloud. A leaked
one costs a rotation (`smthrs cache token revoke`, then `connect` again) and
nothing more. This is the posture of an Nx read-only access token.

`Smithers.RemoteCache.make` accepts the same `publicReadToken` option for a
non-Smithers-Cloud endpoint that enforces the same split. The literal is the only
credential that may appear in `PACKAGE.ts`: any string that is not a public read
token is refused at declaration time, so a personal token pasted by mistake
never lands in a committed file.

## Publishing

Writes need a credential with `write:repository` on the repository. The
declaration's `write` secret names the environment variable, and it defaults
to `SMITHERS_CACHE_TOKEN`:

```sh
export SMITHERS_CACHE_TOKEN='<a smithers_ token with write:repository>'
smithers-build ci //...
```

An agent computer reads the cache and publishes nothing. Its per-run
repository token is bound to `SMITHERS_CACHE_TOKEN` through the egress proxy,
and `SMITHERS_CACHE_URL` names the repository cache. The server treats every
system-issued run credential as a reader, whatever its scopes, because the run
executes code nobody has reviewed. A publication from the run is refused with
`403`, and the run's reads carry on.

## Generated CI

`GithubCiGen` needs no cache secret for reads when the root declaration
carries a public read token, because the workflow evaluates `PACKAGE.ts` and
finds the literal there. Declare `cacheWriteTokenSecret` and mark the trunk
jobs `publishesToCache: true` for publication; the read credential is the
committed token, and the write credential is an environment secret
(`cacheWriteEnvironment`) rendered only into those jobs. The trust model is unchanged: readers are untrusted, writers
are post-merge trunk jobs.

## Managing tokens

```sh
smithers cache token create --repo acme/app --name ci
smithers cache token list --repo acme/app
smithers cache token revoke --repo acme/app --id 3
```

The token creation API also accepts an optional `namespace_prefix` such as
`pr-1/`. A token with that prefix reads only action-cache keys under it;
requests for `main/`, `pr-2/`, or bare keys return `403`. Artifact URLs carry
no namespace, so a scoped token receives `403` from `/cas` too. Use the
repository-wide read token for builds that need artifact outputs.

Token management calls need a first-class credential with write permission on
the repository; the cache routes themselves never accept one.

## Where the bytes live

Action entries are rows in Smithers Cloud's Postgres, artifacts are objects in its blob
store under a repository-scoped key, and every row carries the repository id,
so two repositories never share a namespace even when their keys collide. The
bounds, status codes, first-writer-wins conflict semantics, fenced deletes,
`findMissing`, admission caps, and the 503-never-404 rule are the ones
[Remote caching](remote-caching.md) documents for the other two services.
