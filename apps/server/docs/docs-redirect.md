# `smithers-docs-redirect`: the retired library docs sites

T-DOC-04 ([#3510](https://github.com/smithersai/smithers/issues/3510)) retires the 48
generated `<slug>.smithers.sh` library sites. A small separate Worker answers their
hostnames with a 301 to the package's colocated `docs/` folder on GitHub:

```
https://engine.smithers.sh/concepts/retries/
  -> 301 https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/engine/docs
```

| Piece | File |
| --- | --- |
| Slug roster and map, from the workspace package list | `scripts/package-docs.mjs` (`node scripts/package-docs.mjs` prints it) |
| The Worker's copy of the map (generated) | `src/docsRedirectMap.ts` (`node scripts/package-docs.mjs --write`) |
| Handler (pure decision, pass-through, DNS check) | `src/docsRedirect.ts` |
| Entry (default export only; workerd refuses other exports) | `src/docsRedirectWorker.ts` |
| Config: name, 48 routes, `UNKNOWN_SLUGS` switch | `wrangler.docs-redirect.jsonc` |
| Unit and workerd tests | `src/docsRedirect.test.ts`, `src/docsRedirect.workerd.test.ts` |
| Live acceptance probe (5 URLs, 301 + exact Location) | `node scripts/package-docs-redirect-probe.mjs` |

This Worker is not `smithers-mvp-web`. The Deploy apps workflow does not deploy it,
and deploying it never touches the shared edge.

## Design

```
                       route <slug>.smithers.sh/*  (48, one per retired site)
  flow.smithers.sh ──▶ smithers-docs-redirect ──▶ 301 DOCS_REDIRECTS.get("flow")
                       (outranks the old site Worker's Custom Domain)

  any other host ────▶ not routed here; unchanged
```

1. **One route per retired site, no wildcard route.** The routes are exactly the 48
   hostnames that served a docs site. Cloudflare: "Routes can `fetch()` Custom Domains
   and take precedence if configured on the same hostname"
   ([routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)).
   A deploy therefore cuts every site over at once, and the old site Workers can be
   destroyed afterwards. A `*.smithers.sh/*` route would run this Worker on every
   subdomain without a more specific route, including the build cache, status and
   the preview hosts.
2. **The slugs are frozen; the directories are not.** Deriving slugs from today's
   package list would claim `build.smithers.sh` (the build cache, `401` with
   `www-authenticate: Bearer realm="smithers-build-cache"`). `legacySites` lists the
   retired hostnames; each npm name is looked up in the package list, so a moved
   package moves its target. A slug whose package or `docs/` folder disappears fails
   the build.
3. **The Location comes from the map only.** The Host selects a key; the path, query
   and every header are dropped. Every target is under
   `https://github.com/smithersai/smithers/`, so this is not an open redirect.
4. **Unknown slugs are off by default** (`UNKNOWN_SLUGS: "off"`). Today an unknown name
   has no DNS record (NXDOMAIN) and never reaches Cloudflare. See "Unknown slugs".

## Hostname inventory, 2026-10-06

No Cloudflare read access was available (the wrangler OAuth login had expired). The
inventory combines certificate transparency (`crt.sh`, `%.smithers.sh`), every
`*.smithers.sh` name in this repository and in `plue` origin/main, the docs-site
roster, and 60 common names, 167 candidates in all, each resolved against 1.1.1.1 and
fetched over HTTPS. A name with no public record was not reachable before and is not
captured now.

**Claimed by this Worker (47 live docs sites, plus `plan-store`, which never deployed and
has no DNS record):** agent, artifacts, canonical, capability, chain, cli, control, core,
crypto, database, engine, engine-store, errors, evals, flow, flows, fs, gateway, harness,
integrations, jj, journal, kernel, keys, mcp, memory, migrate, model, notifications,
observability, plan, plan-store, platform-browser, platform-bun, platform-node, plugin,
registry, run-store, sandbox, scorers, smithers-patterns, smithers-sync, smthrs, std,
step-cache, testing, time-travel, triggers. Each live one served
`<title>@smthrs/<name>` (or `smthrs`) with status 200.

**Every other live hostname (unchanged by this Worker; `src/docsRedirect.test.ts` asserts
none is routed):**

| Host | DNS | `GET /` |
| --- | --- | --- |
| `smithers.sh`, `www`, `canary` | proxied | 200, 301 to apex, 200 (`smithers-mvp-web`) |
| `api` | A 34.111.230.45, not proxied | 404 |
| `build` | proxied | 401 (build cache) |
| `bug`, `bugs`, `chat`, `connectors`, `identity`, `reco`, `sync` | proxied | 404 |
| `billing`, `cron-schedules`, `webhooks` | proxied | 403 |
| `cron` | proxied | 522 |
| `aomi`, `backend.aomi`, `automate`, `baml-unplugin-pr`, `capabilities-and-segments`, `code`, `ddd`, `docs-next`, `eliza`, `ferric`, `hermes`, `init`, `kimibenchmarks`, `monitor`, `openclaw`, `plugins`, `self-healing`, `signal`, `status`, `storybook`, `telegram`, `ui`, `ui-preview` | proxied | 200 |
| `deck`, `technical-deck`, `download` | CNAME `cname.vercel-dns-016.com` | 307 (Vercel) |

The zone has no wildcard record: a random name is NXDOMAIN. Certificates also exist for
second-level wildcards (`*.connectors`, `*.ui-preview`, `*.status`, and others); no
route here matches a second-level name. MX is `smtp.google.com`, not a subdomain.

Rerun the snapshot before and after any deploy and diff it:

```sh
for h in smithers.sh www canary api build bug status connectors cron deck download ui-preview; do
  host=$h; [ $h = smithers.sh ] || host=$h.smithers.sh
  curl -s -o /dev/null -D - --max-time 20 https://$host/ | tr -d '\r' |
    awk -v h=$host 'NR==1{s=$2} tolower($1)=="server:"{v=$2} END{print h, s, v}'
done
```

## Deploy (needs a token holder)

Agents never mutate Cloudflare (`AGENTS.md`). The holder of a token with Workers
Scripts and Workers Routes edit on account `dd3525a4132493566aeb38de533c8827` runs,
from a clean `apps/server` checkout of origin/main:

```sh
bun test src/docsRedirect.test.ts src/docsRedirect.workerd.test.ts
CLOUDFLARE_API_TOKEN=<token> bun x wrangler deploy -c wrangler.docs-redirect.jsonc
node ../../scripts/package-docs-redirect-probe.mjs   # 4/5: the unknown slug needs DNS
```

Then rerun the snapshot above and compare it with the inventory. After the probe
passes, the old site Workers (`smithers-docs-<slug>-smithers-docs-<slug>-williamcory`)
can be destroyed. **Before destroying one, keep a DNS record for its hostname:**
removing a Worker Custom Domain may remove the record it created, and a route alone
needs a proxied record. Give each slug a proxied `AAAA 100::` record first, or keep the
Custom Domains attached to the retired Workers.

`plan-store` needs the same record before its redirect answers:

```sh
curl -X POST "https://api.cloudflare.com/client/v4/zones/8ebd98d2f0dc7d8db2e61f31ebc19c14/dns_records" \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  --data '{"type":"AAAA","name":"plan-store","content":"100::","proxied":true,"comment":"T-DOC-04 docs redirect"}'
```

**Rollback:** `CLOUDFLARE_API_TOKEN=<token> bun x wrangler delete -c wrangler.docs-redirect.jsonc`
removes the Worker and its routes; the docs-site Custom Domains under them answer again,
as long as those Workers have not been destroyed.

## Unknown slugs

The ticket sends unknown slugs to the README. An unknown name has no DNS record, so
it needs a wildcard record, and the Worker needs a `*.smithers.sh/*` route, which runs
it on every proxied subdomain without a more specific route. The Worker passes every
such request through with `fetch(request)` unless DNS proves the name is unclaimed:

- Cloudflare: "A wildcard record applies only when no exact record exists at the queried
  name", of any type
  ([wildcard records](https://developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records/)).
- So a wildcard TXT record `*.smithers.sh TXT "smithers-unclaimed=docs-redirect"` is
  visible at a name only when nothing else claims it. The Worker asks
  `cloudflare-dns.com` for the name's TXT (2 s deadline, 5-minute cache) and sends the
  README only when that exact marker answers for that exact name. Any DNS failure
  passes through.

The cost is real: every other proxied subdomain then runs through this Worker (one
pass-through `fetch`, plus one cached DNS query per host), sharing its CPU, request
quota and failure modes. That is a product call for the token holder, not a default.
To turn it on, in one change:

1. DNS: proxied `AAAA * 100::` and `TXT * "smithers-unclaimed=docs-redirect"`.
2. `wrangler.docs-redirect.jsonc`: add `{ "pattern": "*.smithers.sh/*", "zone_id": "8ebd98d2f0dc7d8db2e61f31ebc19c14" }`
   and set `UNKNOWN_SLUGS` to `"txt-marker"`; update the config test.
3. Deploy, run the probe (5/5), rerun the snapshot and compare every inventoried host.
