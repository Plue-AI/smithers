# Cache trust model

The remote build cache is a shared oracle: a target that finds its content key
in the cache does not run, and its stored result is reported green. Whoever can
publish under a key therefore decides the outcome of every later build that
computes that key.

## Trust model

A remote build cache has untrusted readers and trusted writers. This is how
remote caches are deployed generally, in Bazel, Buck2, Nx, and Turborepo alike,
and the reason is the same everywhere: reading a result is harmless, publishing
one is a claim about what a build produces.

- A **reader** is any job that pulls. That includes a job building an
  unreviewed branch, so a read credential is expected to be widely held and is
  treated as public within the organization.
- A **writer** is a job whose inputs were reviewed before it ran. Only
  post-merge jobs on the trunk branch qualify.

The realistic failure does not need an attacker. A target whose real input is
not in its declared inputs computes the same key from different content. Run it
in a pull request, publish the green result, and the next trunk build reads a
result produced from code nobody merged. One credential makes that a routine
accident. Two credentials make publishing an authorization, not a side effect
of having read access.

Two mechanisms enforce it, and only the first is a control:

1. **The server refuses.** `worker/protocol.ts` classifies the presented bearer
   token as `write`, `read`, or `none`, and refuses `PUT` and `DELETE` on
   anything but `write` with `403`, before the request body is read. This is
   not configuration; a job holding the read credential cannot publish.
2. **The client namespaces its publications.** A job that sets
   `SMITHERS_CACHE_NAMESPACE` publishes under `<namespace>/<key>` and still
   reads at the bare key, so its results are invisible to trunk while it keeps
   every trunk cache hit. This is defence in depth, not a control: it binds
   nothing on the server, and a holder of the write credential can decline to
   use it. What it buys is a correct posture for a deployment that has not
   split its secrets yet, and containment of the accidental case above.

## Which secret goes in which job

| Secret                       | Value            | Rendered into        |
| ---------------------------- | ---------------- | -------------------- |
| `SMITHERS_CACHE_URL`         | Endpoint         | Every job            |
| `SMITHERS_CACHE_READ_TOKEN`  | Read credential  | Every job            |
| `SMITHERS_CACHE_WRITE_TOKEN` | Write credential | Post-merge jobs only |

A `pull_request`-triggered job receives the read credential and no write
credential. It pulls at full speed and publishes nothing.

The write secret lives in a GitHub environment, not in the repository. A
repository secret reaches any workflow that a branch of the repository
defines. A branch that edits `ci.yml` can therefore read it, whatever the
publishing job's `if:` guard says. An environment whose deployment branch
policy admits only `main` withholds the secret from every other ref. Fork pull
requests receive no secrets at all, and no workflow here uses
`pull_request_target`.

## Repository CI adoption

`packages/smithers/build/targets/src/GithubCiGen.ts` carries the split. Beside
`cacheTokenSecret`, the read credential, the attrs declare an optional
`cacheWriteTokenSecret`, and the `Job` struct declares an optional
`publishesToCache` boolean. `render` still computes the shared entries
(endpoint and read token) once and spreads them onto every generated step; the
write entry is rendered only into a job that declares `publishesToCache`, and
that job is emitted with
`if: ${{ github.event_name == 'push' && github.ref == 'refs/heads/<branch>' }}`
over the declared push branches, so a `pull_request` run of it never starts,
let alone holds the credential.

The generator refuses the half-declared shapes rather than rendering them: a
`publishesToCache` job with no declared write credential, a declared write
credential no job publishes with, read and write secrets naming one variable,
a publishing job in a workflow with no push branches, and a gate that only a
publishing job would satisfy (its guard means GitHub skips it on every pull
request, so it proves nothing).

The root `PACKAGE.ts` declares `SMITHERS_CACHE_READ_TOKEN` and
`SMITHERS_CACHE_WRITE_TOKEN`. Every target step receives the read credential;
only `cache-publish`, guarded to pushes on `main` and bound to the
`cache-publish` environment (`cacheWriteEnvironment`), receives the write
credential. That job runs the workspace package CI targets. The required PR
jobs remain unconditional. Release gates receive only the read credential.

The existing `.smithers/WORKSPACE.ts` declares `cache.remote` with those same
read and write names. This declaration is necessary: with only an endpoint
override and no declared remote, the CLI would use the shared
`SMITHERS_CACHE_TOKEN` default instead of the split credentials. The CLI reads
`Workspace.cache.remote`; a standalone `RemoteCache` export in `PACKAGE.ts`
does not configure it. Another repository adopts the split with the same
wiring. The complete example includes the required repository and Node
toolchain declarations. Keep your repository's identity and existing toolchain
options when adding the cache configuration:

```ts
import { Smithers as S } from "@smthrs/targets"

const runtime = S.Runtime.Node({ version: ">=26.4.0" })

export const Workspace = S.Workspace("smithers", {
  // Use your repository URL and retain your existing toolchain declarations.
  repository: "git+https://github.com/smithersai/smithers.git",
  runtime,
  packageManager: S.PackageManager.Pnpm({ version: "11.25.0", runtime }),
  nodeModules: S.Npm.NodeModules({
    packageJson: S.file("//package.json"),
    workspaces: S.file("//pnpm-workspace.yaml")
  }),
  cache: S.Cache({
    directory: ".flows",
    remote: S.RemoteCache.make({
      endpoint: "https://build.smithers.sh",
      read: S.Secret("SMITHERS_CACHE_READ_TOKEN"),
      write: S.Secret("SMITHERS_CACHE_WRITE_TOKEN")
    })
  })
})
```

The workflow is generated and drift-gated. Regenerate and check it together
with the declarations. Temporarily set the root CI declaration to
`mode: "write"`, run the build, restore `mode: "check"`, then run lint:

```sh
pnpm exec smithers-build build '//:ci'
pnpm exec smithers-build lint '//:ci'
```

Production runs the split. On 2026-09-24 the Worker was deployed to
`https://build.smithers.sh` with a freshly minted read and write pair, and the
repository secrets `SMITHERS_CACHE_URL`, `SMITHERS_CACHE_READ_TOKEN`, and
`SMITHERS_CACHE_WRITE_TOKEN` were set to match. No shared credential was
carried over: the only deployment that held one, the legacy
`tsflows.smithers.sh` Worker, served no build (its store held two deploy
verification rows and none was ever read back) and was deleted with its D1
database and R2 bucket, so step 4 below has nothing left to rotate.

The target cache publishes only results a confined run produced. This
repository's `.smithers/WORKSPACE.ts` declares `S.Sandbox.None()` as the
default sandbox, so its CI jobs, `cache-publish` included, read from the remote
and publish nothing until target confinement is enabled there.

As an interim guard, `GithubCiGen` emits this environment entry on target steps
in non-publishing jobs when the workflow enables PRs and declares cache access:

```yaml
SMITHERS_CACHE_NAMESPACE: "${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || '' }}"
```

PR publications stay under `pr-<number>/<key>`; pushes retain the bare trunk
keyspace. The publisher carries no namespace. The guard also applies to
shared-token declarations, but remains client-side containment, not server
authorization. Missing split secrets do not fall back to the old shared token.

See the [remote-cache guide](https://smithers.sh/docs/guides/remote-cache/)
for declaration and publication/reuse verification. `SMITHERS_CACHE_URL`
overrides the endpoint without changing the declared credential names.

## Operational step, and deployment ordering

Provision the split credentials in this order for any deployment that still
serves a shared credential. Until provisioning finishes, builds may lose remote
cache reuse and publication but must not receive the old shared credential:

1. **Configure the Worker with both secrets.** Set
   `SMITHERS_CACHE_READ_TOKEN` and `SMITHERS_CACHE_WRITE_TOKEN` in the
   deploying shell and run the deploy. Both are required: `alchemy.run.ts`
   fails the deployment when either is missing, rather than starting a Worker
   that answers on one credential. They must also differ. Both implementations
   refuse two equal digests at construction, because one secret configured for
   both directions is one credential wearing two names and every reader holding
   it can publish. To keep every existing client working during the rollout,
   set the **write** token to the current `SMITHERS_CACHE_TOKEN` value and mint
   a new read token: a client that still sends the old single credential
   classifies as `write` and nothing it does changes.
2. **Add the secrets.** Add `SMITHERS_CACHE_READ_TOKEN`, holding the newly
   minted read token, as a repository secret. Create the `cache-publish`
   environment with a deployment branch policy that admits only `main`. Add
   `SMITHERS_CACHE_WRITE_TOKEN`, holding the current value, to that
   environment and not to the repository.
3. **Verify the adopted declarations.** Confirm the generated CI and release
   workflows use the read secret and only the main-push `cache-publish` job
   receives the write secret. Confirm `.smithers/WORKSPACE.ts` declares the
   same split.
4. **Rotate.** Only now generate a new write credential, redeploy the Worker
   with the new `SMITHERS_CACHE_WRITE_TOKEN` and the unchanged read token, and
   update the `cache-publish` environment secret. Rotating before step 3 breaks every job that
   still sends the old value as its write credential.

If the Worker does not have both secrets configured before the client change
ships, the deployment fails at step 1 and no Worker is replaced. If the
repository secrets are added out of order, the failure is a build that publishes
nothing: the client sends an absent or stale write credential, the Worker
answers `401` or `403`, and the CLI warns
`remote cache publication refused; this credential may only read` once and
keeps reading for the rest of the run. That is the read-only posture, which is
exactly what a pull-request job should have. Builds stay correct and lose only
publication, and authorized cache hits still land.

The self-hosted stack under `../terraform/` serves the same protocol and now
carries the same split: `SMITHERS_CACHE_READ_TOKEN` and
`SMITHERS_CACHE_WRITE_TOKEN`, refused when they are equal, classified by method
before the route is parsed. Its loopback-only development mode, which
configures no token at all, is the one deployment shape without the split, and
`variables.tf` cannot produce it.

A read token may also carry one action-cache namespace prefix, such as `pr-1/`.
The hosted cache stores it with each public read token (`namespace_prefix` on
token creation); the Worker and self-hosted service accept
`SMITHERS_CACHE_READ_NAMESPACE_PREFIX` for their configured read token. An
empty prefix preserves the existing repository-wide read access. A scoped
token gets `403` for bare keys and every other prefix, including `main/` and
`pr-2/`. Because `/cas/{digest}` has no namespace, scoped tokens cannot read
or probe artifacts; those routes answer `403`. Use an unrestricted read token
when a build needs to hydrate artifact outputs.

## What a leaked read credential can cost

The read credential is public within the organization, so the question is not
whether it leaks but what a holder can make the service spend. Two reader
routes are metered out of proportion to their request size:

- `POST /cas/findMissing` probes up to 1000 digests per request, one R2 `HEAD`
  each, so one 67 KB request is a thousand Class B operations.
- `GET /ac/{key}` maintains the `last_accessed_at` the retention sweep orders
  by. It reads the row and writes it only when the last access is more than
  1 day old (`readTouchDays` in `worker/D1ActionCache.ts`), so a hot key costs its
  readers row reads and one row write a day, whatever the request rate.

The Worker's per-isolate ceilings (64 requests, 8 `findMissing`, 2 artifact
transfers) bound what one isolate holds in memory, not what a credential may
cost over time: Cloudflare scales isolates per location. The budget is
therefore per credential. `alchemy.run.ts` declares two Cloudflare Rate
Limiting bindings from the constants in `deployment.ts`, and
`worker/protocol.ts` charges every admitted request to the SHA-256 of the
credential that presented it, keyed under the deployment stage so stages whose
namespaces collide never share a counter, after the credential is classified
and the method authorized, and before any store is touched:

| Budget                  | Binding                     | Per credential, per minute, per Cloudflare location |
| ----------------------- | --------------------------- | --------------------------------------------------- |
| Every cache request     | `CACHE_REQUEST_BUDGET`      | 12000 requests                                      |
| `POST /cas/findMissing` | `CACHE_FIND_MISSING_BUDGET` | 600 findMissing probes, on top of the request       |

A request over budget is answered `429` with `Retry-After: 10` and its body is
discarded unread; the CLI treats it as a miss for that target or drops that
one publication, and keeps the remote enabled for the rest of the run. A `401`
or `403` charges nothing, so a caller
without the credential cannot spend its budget. Both limits sit above a job's
legitimate rate: the default pull policy never probes, and a publication
probes at most twice per target.

What the budget bounds is the bill. At the deployed limits one credential can
drive at most 600 x 1000 = 600000 R2 `HEAD` operations a minute at one
location, about 36 million an hour, plus 12000 other metered operations a
minute. Multiply by the Cloudflare locations the holder can reach and by the
read credentials issued; that product is what a leaked read token can cost
until it is rotated.

The binding counts per location and per Worker, so it is not a global
ceiling. A deployment that needs one, or that must refuse a source address
outright, needs an account-level WAF rate rule on `build.smithers.sh`.
`alchemy.run.ts` does not declare one, and nothing in this package can.

Retention is the other thing a reader can spend. The sweep deletes entries
last read more than 30 days ago, and a read renews that clock, so a holder of
the read credential can keep any entry alive indefinitely by reading it once
a month. The conditional touch makes that cost one row write a day rather
than one per request; it does not remove the ability, which is inherent in
last-access retention. The artifact bucket's own lifecycle, 90 days from
upload, is the backstop a reader cannot extend: an entry kept alive past it
dangles and answers a miss.

## Public read tokens on Smithers Cloud

The Smithers Cloud-hosted cache makes the read credential a committed literal: a
per-repository `smithers_cachero_…` token that can only read that
repository's cache. That is the reader posture above taken to its conclusion.
A reader is untrusted and the read credential is public within the
organization already; publishing it in `PACKAGE.ts` changes who can see it, not
what it can do. The server enforces the same split (`403` on every `PUT` and
`DELETE` before the body is read), the token is refused on any other
repository, and the general token loader never accepts its shape, so a leak
costs a rotation and nothing else. The write credential stays where it was: a
`write:repository` token in the environment of post-merge trunk jobs. A
system-issued run credential never publishes, whatever its scopes. That
includes the per-run token an agent computer holds through the egress proxy. It
reads the repository's cache like any other reader.
