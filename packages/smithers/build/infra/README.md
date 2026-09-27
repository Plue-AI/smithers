# Hosted remote cache

This directory deploys the hosted smithers build remote cache to Cloudflare with
[Alchemy](https://alchemy.run). Production serves
`https://build.smithers.sh`. The Worker stores action-cache JSON in D1 and
content-addressed blobs in R2.

The hosted service and the self-hosted service under [`../terraform/`](../terraform/)
serve the same HTTP routes, and cache keys and payloads do not change between
them. Both carry the read and write credential split and both refuse two equal
credentials. They are two implementations, not one: the self-hosted
`protocol.js` is written by hand, imports nothing from this Worker, and is not
generated from it. Its exported bounds are held equal to the Worker's by
`../test/CacheProtocolParity.test.ts`, and the black-box corpus in
`../terraform/modules/cache/service/test/conformance_test.js` runs the same
requests through both handlers. The tiers differ by contract on journal
provenance, which the self-hosted tier stores and this Worker refuses (see
"Hosted arbitration contract"). Treat this file as the contract for the
hosted service alone.

The service has two credentials: one that may read and one that may publish.
[`CACHE-TRUST.md`](./CACHE-TRUST.md) states the trust model, which secret
belongs in which CI job, and the order to roll the two out in.

## Before you begin

This directory is the `@smthrs/build-infra` workspace package at
`packages/smithers/build/infra`. Use Node.js 26.4.0 or later with pnpm 11.25.0, and
install from the repository root:

```sh
pnpm install --frozen-lockfile --offline
```

Provide these credentials in the deploying shell:

- `SMITHERS_CACHE_READ_TOKEN` and `SMITHERS_CACHE_WRITE_TOKEN`: The two bearer
  tokens used to derive the Worker's Cloudflare `secret_text` verifiers. Use at
  least 32 random bytes each. The deployment enforces that floor: it refuses a
  value shorter than 32 or longer than 4096 printable ASCII bytes, one with a
  space, or one drawn from a single character class (only digits, only
  lowercase, only uppercase, or only punctuation). The Worker receives only
  their SHA-256 digests, which are unsalted and live in Alchemy state (the
  local `.alchemy/` copy and its R2 snapshot) and in the Worker's secret
  binding, so a guessable value is recoverable offline from any copy; do not put a bearer value in an `.env` file or source
  control. Both are required and they must differ. The deployment reads the pair before it
  applies any resource and fails when either is missing or the two are equal,
  because one value under two names lets every reader publish. To roll the
  split out without breaking a client that still sends one credential, set
  the write token to the current shared value and mint a new read token;
  [`CACHE-TRUST.md`](./CACHE-TRUST.md) gives the full order, including when
  to rotate the write token.
- Cloudflare authentication: Set `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID` for non-interactive deployments, or authenticate
  interactively with Cloudflare OAuth. You can use `wrangler whoami` to check
  an existing Wrangler OAuth login. Alchemy currently keeps its own OAuth
  profile, so run `pnpm exec alchemy login --configure` and choose OAuth on the
  first Alchemy deployment if you do not set an API token.

Generate the bearer tokens in the current shell without writing them to disk:

```sh
export SMITHERS_CACHE_READ_TOKEN="$(openssl rand -hex 32)"
export SMITHERS_CACHE_WRITE_TOKEN="$(openssl rand -hex 32)"
```

Production already runs with one pair. The repository secret
`SMITHERS_CACHE_READ_TOKEN` and the `cache-publish` environment secret
`SMITHERS_CACHE_WRITE_TOKEN` hold it. GitHub never returns their values, so
keep the pair in your own secret store. A redeploy either exports that same
pair or rotates both: mint a new pair, deploy, then run
`gh secret set SMITHERS_CACHE_READ_TOKEN` and
`gh secret set SMITHERS_CACHE_WRITE_TOKEN --env cache-publish`. A deploy with a new pair
and no secret update leaves CI with credentials the Worker refuses.

The Cloudflare account must already contain the `smithers.sh` zone. The API
token or OAuth grant needs permission to manage Workers, D1, R2, and the
Worker custom domain in that zone.

### Where the state lives

Alchemy knows which physical Worker, D1 database, and R2 bucket belong to this
stack only through its state. Lose the state and the next deploy creates a
second production beside the first. The durable copy of the state is therefore
one object in R2, `smithers-build-infra-state/alchemy/SmithersBuildRemoteCache.json`,
and the ignored `.alchemy/` directory is a working copy of it.

`scripts/deploy.ts` owns the round trip. Before Alchemy starts it takes a lock
object (the state key with `.lock` appended) with a conditional write, and
pulls the snapshot over the local state directory. After Alchemy exits it
redacts, then publishes the snapshot back with a compare-and-swap on the
version it pulled, whether or not Alchemy succeeded, because a failed run can
still have created resources that only its state records. It then deletes the
lock. A held lock, an unreachable bucket, or a snapshot that changed during the
run fails the command and names the cause. A lock left by a killed deployment
names its host and process id; delete that object only once that process is
gone.

The wrapper reaches R2 through its S3 API with credentials derived from
`CLOUDFLARE_API_TOKEN` (the token id and the SHA-256 of its value), so it needs
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` and no second secret.
Cloudflare's REST object API ignores conditional headers, so it cannot hold the
lock. The shared `alchemy-state-store` Worker is not used because reading its
bearer needs Cloudflare Secrets Store access.

The compare-and-swap needs the object's plain ETag. R2 serves a GET that
accepts gzip compressed, with a weak ETag (`W/"…"`) that no `If-Match`
satisfies, so the wrapper reads state with `accept-encoding: identity` and
refuses a weak ETag with `WeakEtagError` instead of reporting a false
concurrent change.

The stack program refuses to run unless the wrapper started it
(`SMITHERS_BUILD_INFRA_STATE_SYNCED`), so `alchemy deploy` or `alchemy plan`
run directly fail before they read unsynced local state. The state bucket is
created once by hand, outside the stack, because the stack's state cannot
record the bucket that holds it.

The wrapper also runs `scripts/redact-state.ts` after every Alchemy command,
including a failed one, and publishes nothing that failed redaction.
Redaction fails closed: a credential binding may hold the redaction sentinel or
a verifier derived from a currently configured bearer, every other value is
replaced whatever its type, and a credential binding in a shape the script
cannot read is refused rather than reported clean. A rotated-away credential
therefore cannot survive a run that claims success. Current state contains
only the one-way verifier.

Redaction inspects every `CacheWorker.json*` file under the stack state
directory, including Alchemy temporary siblings left by an interrupted write.
It refuses duplicate JSON member names, including escaped spellings, and audits
credential bindings in every decoded root, including arrays. Published
replacements fit the 16 MiB read limit; indentation falls back to compact JSON
when needed, and oversized replacements are refused before publication.

## Deploy production

Run both commands from `packages/smithers/build/infra`. Preview the production
plan against the state pulled from R2:

```sh
CI=1 pnpm run plan
```

Apply it:

```sh
CI=1 pnpm run deploy --yes
```

The `CI=1` prefix is for the environment-token path. Omit it when you use an
interactive Alchemy OAuth profile.

Alchemy creates a stage-specific D1 database and R2 bucket, applies every SQL
file in `worker/migrations/` in order, applies the bucket's artifact lifecycle
rules, deploys the Worker with its eight bindings and its retention cron
trigger, and attaches `build.smithers.sh` as its custom domain. Migration
`0001_initial.sql` creates the table;
`0002_bound_cache_rows.sql` bounds every insert and every update of the
guarded columns. It does not revalidate rows written before it, and the read
path's access-metadata update deliberately does not fire it. The production
Worker does not expose a `workers.dev` URL.

## Deploy a development stage

Run the development script without `--stage`:

```sh
pnpm run deploy:dev
```

Alchemy uses its default `dev_$USER` stage. Development stages get independent
D1, R2, and Worker resources and use a `workers.dev` URL instead of claiming
the production custom domain.

## Verify the service

`GET` and `HEAD /healthz` are public readiness probes. They check D1 and R2,
return no cache state, and coalesce successful probes for one second. They
do not consume cache request slots:

```sh
curl --fail-with-body https://build.smithers.sh/healthz
```

Every `/ac` and `/cas` request requires a bearer token. `GET`, `HEAD`, and
`POST /cas/findMissing` accept either credential. `PUT` and `DELETE` require the
write credential and answer `403` to the read one, before the request body is
read.

The repository's gates for this package are build targets. Run them from the
repository root:

```sh
pnpm exec smithers-build ci '//packages/smithers/build/infra/...'
```

That plans the typecheck (`:check`), the suite (`:suite`), ESLint (`:lint`),
dprint (`:fmt`), and the README parity check (`:docs`). ESLint and dprint use
the infra-local configurations, matching `pnpm run lint`. Worker and script
source globs include new modules automatically; worker tests use their own
TypeScript configuration. The fast local loop is
`pnpm exec vitest run` from `packages/smithers/build/infra`.

The suite computes coverage and fails below 100% on branches, functions,
lines, and statements, the workspace's contract for every default run.
`alchemy.run.ts` only names the Cloudflare resources; every option object and
the stack program live in `deployment.ts`, where the suite executes them, and
importing the graph under the suite covers the wiring itself.

## Protocol

All artifact digests are 64 lowercase hexadecimal SHA-256 values. Action-cache
keys are the CLI's sanitized, non-empty path segments.

| Request                  | Success response       | Behavior                                                                                                            |
| ------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `GET /ac/{keyDigest}`    | `200` JSON             | Returns the original JSON bytes; refreshes access metadata at most once per day per key. Missing entries return `404`. |
| `PUT /ac/{keyDigest}`    | `201`, `200`, or `409` | First writer wins. A new entry returns `201`; an identical result returns `200`; a different result returns `409`.  |
| `DELETE /ac/{keyDigest}` | `200`                  | Deletes an entry, or returns `404`. Supply `recordedRunId` and `recordedEventSeq` together for a fenced delete.     |
| `GET /cas/{digest}`      | `200` bytes            | Streams an R2 object as `application/octet-stream`; missing objects return `404`.                                   |
| `PUT /cas/{digest}`      | `201` or `200`         | Hashes the complete upload before an atomic R2 publication. A digest mismatch returns `400`.                        |
| `HEAD /cas/{digest}`     | `200`                  | Checks R2 without returning a body; missing objects return `404`.                                                   |
| `POST /cas/findMissing`  | `200` JSON             | Accepts `{"digests":[...]}` and returns unique missing digests in request order.                                    |

### Hosted arbitration contract

Every response, including `/healthz` and refusals, advertises
`Smithers-Cache-Contract: result-only-v1`. This tier retains one head per key
and arbitrates publications on their canonical result. It does not implement
`RemoteCacheStore`'s immutable journal-identity ledger.

The `/ac` body can be the CLI's `CachedResult` JSON verbatim or a
`CacheEntry`-shaped envelope without journal provenance. A document is an
envelope only when it contains both `keyDigest` and `result`; its key must
match the request path. Conflict
classification uses the envelope's `result`, and uses the whole document for
every other shape. Object keys are canonicalized before comparison, while the
first writer's original JSON text is preserved for reads.

A valid envelope carrying `recordedRunId` and `recordedEventSeq` is refused
with `422` and JSON code `UNSUPPORTED_PROVENANCE`, including first writes and
identical retries. Malformed provenance still returns `400`. A `GET /ac` with
either provenance query parameter also returns `422` without reading the
head. The step-cache `RemoteCacheStore` client maps `422` to
`CacheStoreError` with code `persistence_failed`, so these operations cannot
silently become `ExistingSame` or a head fallback. Use a tier implementing
`RemoteCacheStore`'s two-stage contract for provenance-bearing step entries.

Head reads and unconditional deletion remain available for existing entries.
Fenced `DELETE` remains supported for legacy rows: it compares the stored
provenance and returns `404` on a mismatch. Deletion and replacement retain
no historical journal row. Metadata and `createdAtMs` in an envelope without
journal provenance are stored but do not participate in arbitration.

The service stores an entry verbatim and does not index the artifacts its
metadata declares. Nothing consumed that reference list, so entries are not
reference counted, a digest written in any shape costs the publisher nothing,
and retention is time based rather than reference aware.

Requests use these bounds:

- `/ac` JSON body: 1 MiB.
- `/cas` upload: 16 MiB and `application/octet-stream`.
- `/cas/findMissing`: 256 KiB, at most 1,000 digests, and
  `application/json`.

JSON is also bounded to depth 64, 100,000 aggregate members, a 2 MiB canonical
conflict discriminator, and 16,384 stream chunks. Action keys and recorded run
identifiers are each at most 512 UTF-8 bytes.

A JSON body must survive its own parse. Every number is read as an IEEE-754
double, so a literal is accepted only when it is finite and is already the
shortest form that renders that double: `9007199254740993`, `1e400`, `1.0`,
and negative zero are refused with `400`, while `9007199254740992` and `1e+21`
are accepted. A duplicate member name in one object is refused for the same
reason. Both would otherwise let two mathematically different results
canonicalize to the same discriminator and answer `200` where this table
promises `409`.

One isolate admits at most 64 cache requests, with independent route ceilings
of four action-cache publications, eight `findMissing` requests, and two
artifact transfers. An artifact transfer holds its slot until the transfer
ends: a `PUT` body is buffered inside the slot, and a `GET` slot is held by
the response body until the client drains or cancels it. Excess work returns
`429` with `Retry-After: 1` and its request body is cancelled without waiting
for a hostile cancellation promise.

Admitted request bodies have a 10-second idle deadline and a 60-second total
deadline. Storage operations and readiness checks have a 30-second deadline.
During these waits, request aborts cancel body readers and release request
permits promptly; aborts and deadlines return `503`. Storage adapters receive an optional
`AbortSignal`. Operations that ignore cancellation retain separate per-method
permits until they settle, bounded by the corresponding route ceiling (64 for
action reads, deletes, and artifact presence checks; four for action
publications; eight for `findMissing`; two for artifact gets or puts).
Readiness retains at most one backend probe.
While an uncancellable operation occupies every dependency permit, retries
return `503`; they cannot accumulate more backend work.

Malformed input returns `400`, unsupported content types return `415`, and
oversized input returns `413`. A publication whose key, body, and canonical
result together exceed 1998976 bytes also returns `413`: D1 stores the body and
the result in one row, and D1 refuses a row over 2000000 bytes. Unsupported
methods return `405`. An internal storage refusal returns `503`. The
target-cache CLI treats `503` as a remote failure: it marks the remote degraded
and falls back to local caching and execution for the rest of the process,
without retrying the remote. Repair the connection or storage issue and retry
in a fresh invocation. The CLI treats a `429` as a miss for that GET or a
dropped publication for that PUT and keeps the remote enabled. The engine's
artifact and step-cache clients have separate error handling; any retries
configured in their HTTP transport or callers do not change the target-cache
CLI policy.

Programmatic `createHandler` callers retain one handler for the isolate lifetime.
`maxArtifactBytes` defaults to 16 MiB, `health` to an async no-op, and an omitted
credential budget permits requests within the isolate concurrency limits.
Construction throws `TypeError` synchronously for invalid dependency records or
methods, invalid or identical SHA-256 credential hashes, or artifact limits
outside 1..16777216. The returned function resolves an HTTP `Response`.

Worker failure logs include fixed internal `code` and `operation` fields, plus
up to four nested cause codes containing at most 32 letters, digits, underscores,
dots, or hyphens (safe integer codes are also accepted). Provider messages,
stacks, and request payloads are omitted. For example, a corrupt discriminator
logs `D1_RESULT_NON_CANONICAL` under `actionCache.put`, a lost R2 publication
logs `R2_PUBLICATION_LOST` under `contentStore.put`, and a failed readiness
sentinel logs `D1_READINESS_INVALID` under `health`. Responses remain generic `503`.

A stored R2 object whose provider checksum is absent or does not match its
content address is reported absent rather than refused. This lets the CAS
client identify the digest as missing so a publisher can republish and repair
it; a `503` fails the CAS existence probe instead of identifying missing content.

## Observability

The Worker writes one Analytics Engine datapoint at response headers to the dataset
`smithers_build_cache_requests_<stage>`: the route class (`ac`, `cas`,
`findMissing`, `healthz`, or `other`) as the index, then the route class,
method, and status as blobs and the duration in milliseconds as the first
double. Streamed hits also write a terminal `stream_complete`, `stream_failed`,
or `stream_cancelled` outcome with elapsed time through the transfer's end.
Stream failures log an allowlisted `STREAM_READ_FAILED` diagnostic for the
store read. Each retention run writes one more under `retention`, with `ok` or
`failed` as its outcome, the rows removed as the second double, and `1` as the
third double when the run stopped with stale rows left. The retention run also
logs one JSON record, `{"event":"smithers.build.retention","removed":...,
"backlog":...,"cutoff":...}`. Workers Logs keep every invocation log and
Workers Traces sample one request in ten.

## Retention and capacity

D1 holds 10 GB per database and an action-cache entry is up to 1 MiB, so an
unpruned store would refuse every publication with `503` after roughly ten
thousand entries. A cron trigger runs the Worker's `scheduled` handler daily;
it deletes entries whose `last_accessed_at` is more than 30 days old, in
batches of 500, using the LRU index the read path already maintains. Deleting
a cold entry only costs the next build a cache miss.

One run deletes batches until a batch comes back short or 60 seconds have
passed. A run that stops at the 60-second budget logs `"backlog":true`, and
the next daily run continues from the oldest remaining entry. Alert on
`backlog` staying true across runs: stale rows are then accumulating faster
than one run deletes them.

R2 has no such ceiling and no scheduled reader, so artifact retention is the
bucket's own lifecycle: an artifact expires 90 days after it was uploaded, and
an abandoned multipart upload is aborted after one day. R2 measures an object's
age from its upload rather than from its last read, which is why the artifact
window is three times the entry window. A hot entry can still outlive the
upload age of an artifact it names. When it does, `GET /cas/{digest}` answers
`404`, `@smthrs/artifacts` raises `ArtifactMissing`, and the engine's step
boundary falls back to a real execution: a dangling reference costs a cache
miss, never a corrupt restore.

`DELETE /ac/{keyDigest}` is the manual escape hatch for one entry; it removes
the D1 row and never the R2 objects the entry named.

## Roll back a deployment

Alchemy deploys every change to all traffic at once, so a bad Worker fails
every CI cache request until it is replaced. Roll back by deploying the last
good commit through the wrapper:

1. Check out the last good commit.
2. From `packages/smithers/build/infra`, run `CI=1 pnpm run deploy --yes`.
3. Confirm the rollback with the checks in [Verify the service](#verify-the-service).

Never deploy a commit older than the one that added `scripts/remote-state.ts`.
Its wrapper does not pull state from R2, so it plans against an empty local
directory and creates a second production.

Do not roll back with `wrangler rollback` or the Cloudflare dashboard. Either
restores the older script while Alchemy state still describes the newer one,
so the next plan compares against a script that is no longer live.

D1 migrations are forward-only. Deploying an older commit does not undo a
migration it lacks. Repair a bad migration with a new migration file in
`worker/migrations/`, then deploy.

## Deploy wrapper

The deploy wrapper forwards termination to the Alchemy process group and sends
SIGKILL to surviving members after a bounded grace period. After interruption,
it waits until the group is observed gone before redaction and return, even if
the leader exits first. Windows waits for the directly signalled child.
Ordinary command completion does not wait out the grace period. The wrapper
runs state redaction after success, failure, or signal, then publishes the
redacted state to R2 (see [Where the state lives](#where-the-state-lives)).
Redaction uses bounded descriptor-stable reads and atomic durable publication;
the stack refuses to run unless the wrapper started it.

The wrapper owns the state directory for the whole run, from before Alchemy
starts until redaction has published its last file, through an exclusive SQLite
transaction. The OS releases ownership if the process exits. The persistent
`.smithers-state-owner.sqlite` file must not be deleted or replaced; all callers
must lock the same file. A separate PID file supports diagnostics and older
wrappers; stale PID reclamation is serialized under the SQLite lock. A second deployment or a
standalone `scripts/redact-state.ts` run against the same state is refused
while it runs; a lock left by a process that no longer exists is reclaimed.

Programmatic redaction returns the number of changed Worker state files. A
missing state directory or already-clean state returns zero. The directory must
be absolute and resolve to a canonical directory without symbolic links.
Invalid options, paths, state shapes, or ownership reject with `TypeError`;
discovery, JSON, and byte limits reject with `RangeError`. Changed file
identities, filesystem, and ownership failures also reject. Publication is per file, so earlier
replacements remain if a later operation fails.

```ts
import { redactAlchemyState } from "./scripts/redact-state.ts"

const changed = await redactAlchemyState({ directory: "/srv/smithers/.alchemy/state/build" })
console.log(`Redacted ${changed} Worker state file(s).`)
```

## Self-host instead

Use [`../terraform/`](../terraform/) when cache data must remain on
self-managed Docker, Postgres, and local storage. That stack remains supported
and independent of these Cloudflare resources. It exposes the same `/ac` and
`/cas` routes, so no cache-data or client-protocol migration is required.
