# Public repository reads

Public repository data is readable without an account. Writes and reads of
account or workspace data continue through the authenticated app API. The
Cloud backend decides whether a repository is public; anonymous requests
never borrow a user's bearer token or cookie.

## Available repositories

`GET /api/public/repos` is the public site's catalog, served by the app Worker
at `https://canary.smithers.sh`. The shared roster in
`src/publicRepoCatalog.ts` lists `smithersai/smithers` alone at launch. The
roster grows as maintainers register their repositories — sign in with GitHub,
then install the Smithers GitHub App on the repository — and the response keeps
the roster order. Repository requests do not change this roster. Each entry
carries a curated `summary` written in the roster.

The response also carries `comingSoon`, an array of `{ name, title, url,
stats }` after `repos`. `COMING_SOON_REPOS` in `src/publicRepoCatalog.ts`
lists Smithers' direct production dependencies and the VCS the engine runs on
(`Effect-TS/effect`, `wevm/incur`, `bombshell-dev/clack`, `jj-vcs/jj`), in
card order. The landing page shows them after Smithers with a "Coming soon"
badge, a GitHub link, and the same stats slots, but no app link: they are not
in `AVAILABLE_REPOS`, so the app page redirects for them and the Cloud mirror
lookup has no entry. They carry no `summary`. Moving a repository from
`COMING_SOON_REPOS` to `AVAILABLE_REPOS` (with its `summary` and `cloudRepo`)
is how a maintainer's registration ships. The `repos` array is unchanged by this
field, so a site built before it shipped keeps working.

The endpoint fetches public GitHub repository metadata on the server, one
concurrent request per repository in both arrays, using the same upstream
resource as the app's account-scoped GitHub metadata route. It never borrows a
visitor's credentials. Product GitHub App authentication belongs to the shared
backend and reads the install's sealed PostgreSQL credential store.
It projects only stars, forks, open issues plus pull requests, language, and
license. GitHub's `open_issues_count` includes pull requests, so the card labels
that statistic **Issues + PRs**.

Successful metadata is cached for five minutes in the Worker and Cloudflare's
edge cache. Concurrent requests share a fetch. Metadata failures return the
affected repository with `stats: null` while the other repositories keep their
counts; the whole catalog is then cached for 30 seconds, whether the failing
repository is available or coming soon. Availability does not
disappear and missing counts are never presented as zero. This endpoint
allows credential-free cross-origin GETs from the landing page.

The Astro card fetches at runtime. Set `PUBLIC_AVAILABLE_REPOS_URL` at site
build time to select a preview app backend. Deploy the app Worker before the
site so the public endpoint is present when the card loads.

Each card's primary link opens the repository in the web app at
`<PUBLIC_APP_ORIGIN>/?repo=owner/name`; the default origin is
`https://canary.smithers.sh`. The web app honours the name only when this
catalog carries it, makes that repository the active selection, and states it
as the active repository in the agent's per-turn runtime context. It strips
the `repo` parameter from the URL either way, so a reload does not reselect.
Set `PUBLIC_APP_ORIGIN` at site build time to point the cards at a preview app.

## Existing repository APIs

Anonymous GETs to the app's repository metadata, contents, topics,
bookmarks, changes, issues, labels, and Git object read routes now reach the
Cloud backend without an identity-service round trip. Both `/api/repos/...`
and `/api/cloud/api/repos/...` use this path. Every read checks the Cloud
backend, so a repository becoming private takes effect on the next request.
These mutable documents and their refusals use `private, no-store`; upstream
`Vary` headers are preserved. Only the separate curated catalog is cached.

The Cloud backend serves each catalog repository's public mirror under its
own namespace, not under the GitHub name: `smithersai/smithers` is mirrored as
`smithers-canary/smithers`, and the backend refuses the GitHub name without
credentials. Each `AVAILABLE_REPOS` entry names that mirror in `cloudRepo`,
and anonymous reads substitute it for the owner and name segments before
forwarding; the document path and query are unchanged, and the catalog name
matches case-insensitively. A repository outside the catalog is forwarded
under the name the browser asked for. `cloudRepo` is server-side only and
never appears in the `GET /api/public/repos` response. Signed-in requests
keep the GitHub name and the user's own bearer.

The mirror follows `main` through `.github/workflows/mirror-sync.yml`: every
push to `main` on GitHub pushes the same history to
`https://api.jjhub.tech/smithers-canary/smithers.git` `main`, so the factory
projection under `.smithers/`, the wiki, the flow catalog and the docs a
visitor reads signed out are the ones on `main`. The push authenticates with
the `SMITHERS_CLOUD_MIRROR_TOKEN` repository secret, a Smithers Cloud personal
access token for the `smithers-canary` user scoped to that repository, sent as
the Basic password of the HTTPS push. A checkout without the secret skips the
push with a notice that names it; a rejected push fails the run and is never
forced. `apps/server/scripts/canary/mirror-sync-wiring.test.ts` pins the
workflow to the `cloudRepo` in `src/publicRepoCatalog.ts`.

Requests carrying a session use the existing authenticated path, preserving
access to private repositories. An expired session falls back to an
anonymous repository read. Authenticated answers never enter the public
cache. The existing same-origin rule applies to these app APIs; only the
curated catalog is cross-origin.

Workspace sessions, gateway provisioning, account data, secrets, and write
methods remain outside the anonymous read routes. The app's existing UI
sign-in requirements are independent of this API policy.

## Anonymous turns

A signed-out visitor at `https://smithers.sh/smithersai/smithers` talks to
Smithers about that repository without an account. `POST /api/agent/turn`
admits a request with no valid session only when the turn's runtime context
names a catalog repository (`context.activeRepository`, the selection the
`/owner/name` path made); any other such turn keeps its `401` sign-in
refusal. The turn carries no login, so the chat upstream meters it to the
deployment and it never reaches a user's billing account.

Anonymous turns spend from two buckets in the same `TURN_LIMITS` Durable
Object as the per-login ceiling, and either refuses. One is keyed by a
salted SHA-256 of the client address (`cf-connecting-ip`, salted with the
`ANONYMOUS_TURN_SALT` secret; an IPv6 address is masked to its /64 first, so
one visitor's allocation is one bucket) with a ceiling of
`ANONYMOUS_TURN_MAX` turns per day. The other is the deployment-wide
`anonymous:all` bucket with a ceiling of `ANONYMOUS_ALL_TURN_MAX` turns per
day (`turnLimit.ts`), which caps what exploring can cost when a caller
rotates addresses. The refusal is the existing `429 turn_rate_limited`
response, worded to name sign-in as the way to keep going. `POST /api/agent/turn/cancel` answers the same
callers too, because cancelling spends nothing and an owned turn refuses
anyone but its owner.

The model's tool calls run in the browser, against this Worker. What a
signed-out turn can therefore reach is exactly the anonymous surface above:
the public repository reads. The model relay (`/api/model/stream`), the
workflow seam, the browser tool, and every write method through the
platform proxy still answer `401` without a session. In the web app the
visitor's file reads (`files.list`, `files.read`) are open on the selected
catalog repository; every flow that writes keeps its sign-in requirement and
renders the sign-in step instead.

## Checks

```sh
bun test ./apps/server/src/publicRepos.test.ts ./apps/server/src/publicRepositoryReads.test.ts ./apps/server/src/index.test.ts
pnpm --filter smithers-server run typecheck
pnpm --filter @smithers/site run check
pnpm --filter @smithers/site run build
```
