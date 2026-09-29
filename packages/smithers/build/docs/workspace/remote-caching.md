---
title: "Remote caching"
description: "The two caches that carry the word remote, what each stores, and the /ac and /cas services behind them."
---

Two independent caches carry the word "remote". They store different things,
speak different protocols, and are wired in different places. Read this page
before choosing one.

|                 | CLI result cache                                   | Engine step cache and artifact CAS                                             |
| --------------- | -------------------------------------------------- | ------------------------------------------------------------------------------ |
| Stores          | The success value of one executed target           | Keyed step results, plus the files a declared `TreeArtifact` boundary produced |
| Keyed by        | The planner content key                            | The engine step key                                                            |
| Local tier      | JSON files under `<cacheDirectory>/cache`          | The Smithers local step cache and artifact store                               |
| Remote tier     | HTTP `/ac`, read-through                           | HTTP `/ac` and `/cas`                                                          |
| Wired by        | The CLI's cache module, when one is configured     | Not composed by the smithers-build CLI today                                   |
| Configured with | Root `RemoteCache`; `SMITHERS_CACHE_URL` overrides | `RemoteCacheStore` and `RemoteArtifacts` layer options                         |

## The CLI result cache remote tier

The root `PACKAGE.ts` declares the HTTPS endpoint without carrying a credential:

```ts
import { Smithers } from "@smthrs/targets"

export const remoteCache = Smithers.RemoteCache.make({
  endpoint: "https://build.smithers.sh"
})
```

`token` is a `Secret` declaration and defaults to `Secret("SMITHERS_CACHE_TOKEN")`.
It may name another environment variable, but the bearer-token value must only
arrive through that variable; never put it in `PACKAGE.ts`.

### Read and write credentials

One token that both reads and publishes is the shape a cache-poisoning path
needs: any job holding it can replace an entry every later job trusts. A
declaration may therefore split the credential in two, and the server enforces
the split rather than trusting the client to respect it.

```ts
export const remoteCache = Smithers.RemoteCache.make({
  endpoint: "https://build.smithers.sh",
  read: Smithers.Secret("SMITHERS_CACHE_READ_TOKEN"),
  write: Smithers.Secret("SMITHERS_CACHE_WRITE_TOKEN")
})
```

`read` names the same slot as `token`, so a declaration passes one or the
other, never both. `write` is optional: omitting it means the read credential
publishes too, which is the single-token model above.

Give the read credential to every job that only consumes the cache, which is
most of them, and the write credential only to the jobs that are trusted to
publish. A request presenting the read credential is refused with `403` for
every `PUT` and `DELETE`, on `/ac` and `/cas` alike, before the request body is
read. `GET`, `HEAD`, and `POST /cas/findMissing` are open to both credentials.

`infra/CACHE-TRUST.md` records the trust model the split exists to enforce, and
what still has to land before a pull-request job on a fork can be given cache
access at all. Every tool the CLI
spawns gets an environment with `SMITHERS_CACHE_URL` and the declared token
variable removed, so a target's own commands never see the credential. The
`smithers-build` process itself clears the two default names from its own environment
before it loads any `PACKAGE.ts` file. It does not delete any other variable from
the environment it was given, because the programmatic API runs inside a
caller's process and must not corrupt it.

```sh
export SMITHERS_CACHE_TOKEN='<token>'
smithers-build ci //...
```

`SMITHERS_CACHE_URL` is an optional process override and has precedence over
the declared endpoint. It requires HTTPS except for `http://localhost`,
`http://127.0.0.1`, and `http://[::1]`, which are admitted for a cache running
on the same host.

Behavior:

- A local hit never touches the remote.
- A local miss queries the remote. A remote hit hydrates the local file, so the
  next read stays on disk.
- A put writes both tiers.
- Any remote failure prints one warning line to standard error and degrades the
  store to local-only for the rest of the process. A run never fails because the
  remote cache failed.
- A `429` means the remote is busy or the credential spent its budget. The
  client warns once, treats that GET as a miss or drops that one publication,
  and keeps the remote enabled.
- A `PUT` returning `201` inserted the entry, `200` found an identical entry,
  and `409` found a different result under the same key. A `409` warns without
  failing the run or disabling subsequent remote reads.

The client sends the richer action-cache envelope used by the self-hosted
service and accepts either that envelope or the CLI `CachedResult` JSON returned
by older compatible services. Authentication is `Authorization: Bearer`; the
token is never part of the body, a cache key, or a stored entry.

For generated CI, `cacheUrlSecret` optionally emits `SMITHERS_CACHE_URL`, so it
has the same endpoint precedence as local use. `cacheTokenSecret` emits the
bearer token under `cacheTokenEnv`, which defaults to `SMITHERS_CACHE_TOKEN`.

## The Smithers Cloud-hosted cache

> **Coming soon.** Smithers Cloud has not been released yet; the discovery, the committed read token, and the endpoint below describe the interface ahead of general availability.

Smithers Cloud serves this same protocol per repository at
`https://api.jjhub.tech/api/repos/<owner>/<name>/build-cache`. Two things
differ from the two services below. A checkout of a Smithers Cloud repository needs no
declaration at all: with no `RemoteCache` and no `SMITHERS_CACHE_URL`, the CLI
discovers the repository from the git remote and reads anonymously. And the
read credential can be committed: `Smithers.RemoteCache.smithersCloud({ repo,
publicReadToken })` carries a per-repository public read token that can only
read that one cache, so every clone and every pull-request job reads without a
secret while publishing still needs `SMITHERS_CACHE_TOKEN`. See
[The Smithers Cloud-hosted cache](smithers-cloud-cache.md).

## The engine step cache services

The Smithers engine has its own two-store split: `RemoteCacheStore` for keyed step
entries and `RemoteArtifacts` for content-addressed blobs. Both speak one HTTP
protocol.

| Request                  | Behavior                                                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `GET /ac/{keyDigest}`    | Returns the stored entry JSON, or `404`.                                                                                         |
| `PUT /ac/{keyDigest}`    | First writer wins: `201` new, `200` identical, `409` different.                                                                  |
| `DELETE /ac/{keyDigest}` | Deletes an entry. Supplying `recordedRunId` and `recordedEventSeq` together makes it a fenced delete.                            |
| `GET /cas/{digest}`      | Streams the blob as `application/octet-stream`, or `404`.                                                                        |
| `PUT /cas/{digest}`      | Hashes the complete upload before publication; a digest mismatch returns `400`. A `Content-Range` request is refused with `400`. |
| `HEAD /cas/{digest}`     | Existence probe.                                                                                                                 |
| `POST /cas/findMissing`  | Takes `{"digests":[...]}` and returns the missing ones in request order.                                                         |

Publication order is blobs before metadata: probe with `findMissing`, upload what
is missing, write the local row, then publish the entry. A shared entry must
never be observable while a blob it references is missing.

Both backends enforce the same request bounds before they allocate anything, and
both refuse the same way:

| Bound                                          | Refusal |
| ---------------------------------------------- | ------- |
| `PUT /ac` body, 1 MiB                          | `413`   |
| `PUT /cas` body, the configured artifact bound | `413`   |
| `POST /cas/findMissing` body, 256 KiB          | `413`   |
| `POST /cas/findMissing` digests, 1000          | `413`   |
| `Content-Length` that is not a decimal count   | `400`   |
| Body that is not UTF-8 JSON                    | `400`   |
| Wrong content type                             | `415`   |
| Malformed percent-encoding in the path         | `400`   |

`PUT /ac` requires `application/json` or a `+json` media type, and `PUT /cas`
requires `application/octet-stream`. The bound is enforced against the stream, so
a chunked upload that declares no length is refused at the same point as one that
declares a false length. A storage failure is always `503`, never a `404`: the
client retries a refusal and must never read one as a miss.

Neither backend implements the resumable `Content-Range`/`308` upload sequence
`RemoteArtifacts.Options.chunkBytes` can speak. Both answer a ranged
`PUT /cas` with `400` before reading the body, the answer RFC 9110 gives a
resource that does not support partial `PUT`, and the client reads that as its
cue to send the blob in one request. One artifact body is therefore bounded by
the configured artifact cap, at most 16 MiB on either tier, so a larger
artifact cannot be published to these services in either mode.

An action-cache document is stored and returned verbatim. Two shapes are
accepted: the `CacheEntry` envelope `RemoteCacheStore` publishes, and the CLI's
bare `CachedResult` JSON. A document is an envelope only when both `keyDigest`
and `result` are present, and the key must match the route. Conflict is decided
on that envelope's `result` and on the whole document otherwise, compared with
object members in sorted order, so a re-publication that only reordered its
members is `200` rather than `409`.

The endpoint and its bearer token arrive as layer construction options. They are
capabilities, so they never enter a step key or the journal.

**The smithers-build CLI does not compose these engine layers.** Its target result
cache uses the same `/ac` service directly. The executor builds its runtime from
the install layer, `ExecLive`, the catalog action layers, and an in-memory flow
engine. Using remote engine artifacts still means composing
`RemoteCacheStore` and `RemoteArtifacts` into a flows runtime yourself.

### Self-hosted stack

`terraform/` runs the service on one machine with no cloud account. The module
starts Postgres and a Bun HTTP service on a private Docker network, publishing
only the service port on loopback.

```sh
cd terraform/examples/docker
terraform init
terraform apply \
  -var 'postgres_password=<password>' \
  -var 'read_auth_token=<read token>' \
  -var 'write_auth_token=<write token>' \
  -var 'postgres_image=postgres@sha256:<digest>' \
  -var 'bun_image=oven/bun@sha256:<digest>'
```

The module publishes a loopback HTTP endpoint. A local CLI may point
`SMITHERS_CACHE_URL` at it directly; put TLS in front of it before using it in a
checked-in `RemoteCache` declaration, because declarations require HTTPS.
Engine layers may also use the module output directly on the trusted local
host.

Terraform deployments require a `read_auth_token` and a different
`write_auth_token`, each 16-4096 printable ASCII characters, and immutable
`name@sha256:digest` references for both container images. The service
classifies every request against the two: a request presenting the read
credential is refused with `403` for every `PUT` and `DELETE`, before its body
is read, which is the same model the hosted Worker enforces. `postgres_password`
must be at least 12 characters; ports and `max_body_bytes` must be integers,
and one artifact is capped at 16 MiB. The service still supports empty tokens
when run directly for development, but then it binds itself to `127.0.0.1`; the
Terraform module never enables that mode, and it refuses the old single
`SMITHERS_CACHE_TOKEN` rather than accepting it as both credentials. Startup validates the same values, checks the database schema version
before binding, and refuses a bad configuration rather than turning it into a
request-time `503`. `/healthz` is unauthenticated so the container runtime can
probe it, but it performs a database/schema readiness check and reveals no
cache state.

The service admits at most 64 cache requests at once and, within that bound,
at most four action publications, eight `findMissing` requests, and two large
artifact uploads or downloads. Excess work receives `429` with
`Retry-After: 1`; refused request bodies are cancelled without waiting for a
hostile cancellation promise. The Terraform container is limited to 256 MiB with no swap,
runs as the image's unprivileged user on a read-only root filesystem, drops all
Linux capabilities, and enables `no-new-privileges`. Postgres is limited to
512 MiB with no swap, and the service's SQL pool uses at most eight connections.

Requests cancel on client disconnect or a route deadline: five seconds for
readiness, 60 seconds for artifact uploads and downloads, and 15 seconds for
other routes. Dependency timeouts answer `503`. Response streams retain their
admission permits until completion, cancellation, or the route deadline.
Storage receives the request's abort signal; cancelled SQL statements and
publication rollback settle before their permits are released. Each SQL
connection enforces a ten-second statement timeout, a two-second lock timeout,
a ten-second idle-transaction timeout, and a five-second connection timeout.
Readiness probes share one bounded check and cache successful checks for one
second. Startup readiness and each shutdown wait are bounded to five seconds;
a stalled listener is force-stopped and database connections are force-closed.

Terraform marks credentials and the database URL sensitive, which suppresses
ordinary CLI display but does not encrypt Terraform state or Docker container
inspection output. Keep state in an encrypted, access-controlled backend and
restrict access to the Docker daemon. For a managed production deployment,
inject credentials through the platform's secret manager instead of treating
this local Docker module as a secret-distribution system.

The Postgres schema lives in `terraform/modules/cache/migrations/0001_initial.sql`:
`smithers_build_cache_entry` for step entries, `smithers_build_artifact` for blobs,
`smithers_build_cache_entry_artifact` for references, and two explicit release functions
for eviction. Nothing deletes on its own. An entry row keeps the published
document in `body`, its conflict discriminator in `result_canonical`, and journal
provenance in `recorded_run_id` and `recorded_event_seq`, which are null together
for a client that publishes none and are what a fenced `DELETE` compares.

There is no in-place migration runner. Postgres applies that file once, when it
initializes an empty data directory, so a change to it reaches an existing
deployment only by recreating the `<name_prefix>-cache-pgdata` volume. That
discards the cache, which is reconstructible by definition. The service checks
`smithers_build_cache_schema` before listening, so an old volume fails closed rather
than running new code against an old layout.

The service is `terraform/modules/cache/service`: `protocol.js` is the protocol,
`storage.js` is its Postgres translation, `config.js` is the environment
contract, and `server.js` is startup and nothing else. Its tests run without a
database or a listener:

```sh
cd terraform/modules/cache/service
bun test
```

Publishing an entry is one transaction at Postgres' default `READ COMMITTED`
isolation. It takes a transaction-scoped advisory lock folded from the key,
which serializes every publisher of that key, and it holds the row it
classified with `FOR NO KEY UPDATE` until it commits. That is what makes the
`201`, `200`, and `409` a claim about a row that still exists when the client
reads the answer, and what keeps one publication's artifact references off
another's result. The two release functions select their candidates
`FOR UPDATE SKIP LOCKED`, so eviction never blocks behind a publication and
never reports a count it did not take. `storage.js` states the assumptions in
full.

`postgres_test.js` runs the same storage against a real Postgres, which is the
only thing that checks the locking statements and the schema rather than a
fake of them. It skips itself unless `SMITHERS_CACHE_TEST_DATABASE_URL` names
a database. The `cacheServicePostgres` target supplies one: a `postgres`
container pinned by digest, declared as a service, published on loopback port
55434, with the URL in the target's environment. The suite therefore runs under
`smithers-build test` and in the CI lane that invokes the package graph, and a
statement Postgres rejects fails the build rather than a deployed cache.

```sh
smithers-build test //packages/smithers/build:cacheServicePostgres
```

To run it by hand instead, set `SMITHERS_CACHE_TEST_DATABASE_URL` to a
throwaway database: setup drops and recreates every `smithers_build_` object
the migration defines.

```sh
docker run --rm -d -p 55432:5432 -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=smithers_build_cache_test --name smithers-build-cache-test \
  'postgres@sha256:<digest>'
SMITHERS_CACHE_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/smithers_build_cache_test \
  bun test
```

```sh
terraform destroy
```

removes the containers and the named cache volume.

### Hosted stack

`infra/` deploys the same protocol to Cloudflare with Alchemy: a Worker storing
action-cache JSON in D1 and blobs in R2, served at `https://build.smithers.sh`.
It is the `@smthrs/build-infra` workspace package, so the ordinary workspace
install covers it and it has no lockfile of its own. Cloudflare authentication
and the credential rollout order are in `infra/README.md`.
The deployment wrapper releases its remote state lock if pulling or reading the
local baseline fails. Resolve the read failure and retry; remove a lock by hand
only after confirming that its named deployment process is gone.

```sh
pnpm install --frozen-lockfile --offline
cd infra
export SMITHERS_CACHE_READ_TOKEN="$(openssl rand -hex 32)"
export SMITHERS_CACHE_WRITE_TOKEN="$(openssl rand -hex 32)"
CI=1 pnpm exec alchemy plan alchemy.run.ts --stage prod
CI=1 pnpm run deploy -- --yes
```

`alchemy.run.ts` reads those two names, not `SMITHERS_CACHE_TOKEN`: the Worker
hashes both and classifies every request against them.

`GET` and `HEAD /healthz` are public readiness probes over D1 and R2 and reveal
no cache state. Every `/ac` and `/cas` route requires a bearer token, and the
publishing methods require the write one. A client
switches between the hosted and self-hosted services by changing the endpoint
and token; cache keys and payloads do not change. Hosted migrations live in
`infra/worker/migrations/`; the second migration bounds legacy and future D1
rows before the Worker serves them.

## The current engine boundary

The CLI result cache publishes to the shared tier only what an enforced
confinement produced. `CacheStore.put` takes `shared: false` and both
surfaces pass it whenever the run was not confined: the target opted out with
`sandbox: "none"`, the workspace declared `S.Sandbox.None()`, or the
`PACKAGE.ts` workspace never declared a policy. Such a result is evidence for
the machine that produced it and stays in `<cacheDirectory>/cache`. A
confined run (see [Hermeticity](../concepts/actions-and-boundaries.md#hermeticity))
publishes as before.

Fetch declares `.flows/store/<manager>` as a `TreeArtifact`. The shipped
filesystem boundary can execute that action, capture the declared tree, and
replay it locally. The install actions still run outside the tool sandbox, so
that evidence stays run-local and no fetch result is admitted to the engine's
shared tier. The action is designed to be admissible, and becomes admissible
when the install flow runs under the same confinement the exec action does.

## Next

- [Caching](caching.md)
- [Actions and boundaries](../concepts/actions-and-boundaries.md)
- [GithubCiGen](../reference/targets/github-ci-gen.md)
