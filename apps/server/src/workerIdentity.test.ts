import { readFileSync } from "node:fs"
import { describe, expect, test } from "bun:test"
import { WORKER_IDENTITY } from "./workerIdentity"
import { readWranglerConfig, WRANGLER_CONFIG_PATH } from "./wranglerConfig"

const bridge = readWranglerConfig()

/*
 * DEPLOY.md "Frozen identity": the Worker's name and its Durable Object
 * bindings are what its state is keyed to. A rename, a dropped binding, or a
 * renamed class deploys a fresh Worker with empty storage and orphans the
 * old one, so every one of those is pinned here and a change to any of them
 * is a deliberate decision recorded in DEPLOY.md, never a diff that slips
 * through with a deploy. wrangler.jsonc is what deploys, and the tests below
 * hold it to WORKER_IDENTITY, so pinning the object pins the deploy.
 */
describe("the Worker identity stays frozen", () => {
  test("the name, the entry module, and the account", () => {
    expect(WORKER_IDENTITY.name).toBe("smithers-mvp-web")
    expect(WORKER_IDENTITY.entry).toBe("src/edge.ts")
    expect(bridge.main).toBe(WORKER_IDENTITY.entry)
    expect(WORKER_IDENTITY.accountId).toBe("dd3525a4132493566aeb38de533c8827")
  })

  test("the compatibility date and flags", () => {
    expect(WORKER_IDENTITY.compatibility).toEqual({ date: "2026-08-01", flags: ["nodejs_compat"] })
  })

  test("the canary custom domain stays attached, pinned to the smithers.sh zone", () => {
    expect(WORKER_IDENTITY.domain).toEqual({ name: "canary.smithers.sh", zoneId: "8ebd98d2f0dc7d8db2e61f31ebc19c14" })
  })

  test("one zone route claims every apex path, so the app page and its /_astro chunks come from one build", () => {
    expect(WORKER_IDENTITY.routes).toEqual([
      { pattern: "smithers.sh/*", zoneId: "8ebd98d2f0dc7d8db2e61f31ebc19c14" },
      { pattern: "www.smithers.sh/*", zoneId: "8ebd98d2f0dc7d8db2e61f31ebc19c14" }
    ])
  })

  test("no workers.dev surface", () => {
    expect(WORKER_IDENTITY.workersDev).toBe(false)
  })

  test("the six Durable Object bindings and their classes, both names frozen", () => {
    expect(WORKER_IDENTITY.durableObjects).toEqual([
      { binding: "TURN_CANCELS", className: "TurnCancelRegistry" },
      { binding: "GATEWAY_SESSIONS", className: "GatewaySessionRegistry" },
      { binding: "TURN_LIMITS", className: "TurnRateLimiter" },
      { binding: "CLIENT_ERRORS", className: "ClientErrorLog" },
      { binding: "RECOMMEND_LOG", className: "RecommendLog" },
      { binding: "MODEL_VAULTS", className: "AccountModelVault" }
    ])
  })

  test("the migration history introduces exactly those classes, in order", () => {
    expect(WORKER_IDENTITY.migrations).toEqual([
      { tag: "v1", newSqliteClasses: ["TurnCancelRegistry"] },
      { tag: "v2", newSqliteClasses: ["GatewaySessionRegistry"] },
      { tag: "v3", newSqliteClasses: ["TurnRateLimiter", "ClientErrorLog"] },
      { tag: "v4", newSqliteClasses: ["RecommendLog"] },
      { tag: "v5", newSqliteClasses: ["AccountModelVault"] }
    ])
    const migrated = WORKER_IDENTITY.migrations.flatMap((migration) => migration.newSqliteClasses)
    expect(new Set(migrated)).toEqual(new Set(WORKER_IDENTITY.durableObjects.map((binding) => binding.className)))
  })

  test("the assets are the site build, served with its 404 page (the second deliberate identity change)", () => {
    expect(WORKER_IDENTITY.assets.directory).toBe("../site/dist")
    expect(WORKER_IDENTITY.assets.binding).toBe("ASSETS")
    expect(WORKER_IDENTITY.assets.notFoundHandling).toBe("404-page")
  })

  test("the plain vars", () => {
    expect(WORKER_IDENTITY.vars).toEqual({
      SMITHERS_BACKEND_ORIGIN: "https://api.jjhub.tech"
    })
  })

  test("every secret and every optional knob is a name only, never a value", () => {
    const secrets = Object.keys(WORKER_IDENTITY.secrets)
    for (const name of [...secrets, ...WORKER_IDENTITY.optionalVars]) expect(name).toMatch(/^[A-Z][A-Z0-9_]+$/)
    // No name is both a secret and a knob, or the preflight would report it twice.
    for (const name of WORKER_IDENTITY.optionalVars) expect(secrets).not.toContain(name)
  })

  test("every secret states its own absent state for the preflight", () => {
    const absent = Object.values(WORKER_IDENTITY.secrets).map((secret) => secret.absent)
    for (const text of absent) expect(text.length).toBeGreaterThan(0)
    expect(new Set(absent).size).toBe(absent.length)
  })

  test("the stateless edge requires no product credentials", () => {
    expect(Object.values(WORKER_IDENTITY.secrets).every(secret => !secret.required)).toBe(true)
  })
})

/*
 * wrangler.jsonc stays checked in as the adoption bridge: it is what Wrangler
 * last deployed, and scripts/adopt-durable-objects.ts compares the live
 * script to both. The two must say the same thing about every frozen fact.
 */
describe("wrangler.jsonc, the adoption bridge, agrees with the identity", () => {
  test("name and compatibility", () => {
    expect(bridge.name).toBe(WORKER_IDENTITY.name)
    expect(bridge.compatibility_date).toBe(WORKER_IDENTITY.compatibility.date)
    expect(bridge.compatibility_flags).toEqual([...WORKER_IDENTITY.compatibility.flags])
  })

  test("the canary custom domain and the apex zone route", () => {
    expect(bridge.routes[0]).toEqual({ pattern: WORKER_IDENTITY.domain.name, custom_domain: true })
    expect(bridge.routes.slice(1)).toEqual(WORKER_IDENTITY.routes.map((route) => ({ pattern: route.pattern, zone_id: route.zoneId })))
  })

  test("the Durable Object bindings, class names, and migrations", () => {
    expect(bridge.durable_objects.bindings).toEqual(
      WORKER_IDENTITY.durableObjects.map((binding) => ({ name: binding.binding, class_name: binding.className }))
    )
    expect(bridge.migrations).toEqual(
      WORKER_IDENTITY.migrations.map((migration) => ({ tag: migration.tag, new_sqlite_classes: [...migration.newSqliteClasses] }))
    )
  })

  test("the assets directory, binding, 404 handling, and run_worker_first list, byte for byte", () => {
    expect(bridge.assets.directory).toBe(WORKER_IDENTITY.assets.directory)
    expect(bridge.assets.binding).toBe(WORKER_IDENTITY.assets.binding)
    expect(bridge.assets.not_found_handling).toBe(WORKER_IDENTITY.assets.notFoundHandling)
    expect(bridge.assets.run_worker_first).toEqual([...WORKER_IDENTITY.assets.runWorkerFirst])
  })

  test("the plain vars", () => {
    expect(bridge.vars).toEqual({ ...WORKER_IDENTITY.vars })
  })
})

test("all requests reach the Worker before asset navigation for repository slugs, headers, and host redirects", () => {
  expect(WORKER_IDENTITY.assets.runWorkerFirst).toEqual(["/*"])
})

/*
 * The comments in wrangler.jsonc are read under incident pressure, so they may
 * only name a rollback that still runs. The canary route's comment named a
 * `wrangler deploy` from a `smithersai/ui` checkout until that repository
 * dropped the route from its own config (smithersai/ui 56ffafab); the command
 * still exits 0 there, publishes routeless, and re-attaches nothing.
 */
test("wrangler.jsonc names a rollback that still exists", () => {
  const comments = readFileSync(WRANGLER_CONFIG_PATH, "utf8")
    .split("\n")
    .filter((line) => line.trimStart().startsWith("//"))
    .join("\n")
  expect(comments).toContain("bun apps/server/scripts/deploy.ts")
  expect(comments).toContain("bun x wrangler rollback")
  expect(comments).not.toContain("smithersai/ui")
})

/*
 * Workers Logs. The live script had `observability: null` and no logpush or
 * tail consumer, so an outage left nothing to read afterwards. wrangler applies
 * this block on every deploy.
 */
test("wrangler.jsonc turns on Workers Logs, so an outage leaves logs to read", () => {
  expect(bridge.observability).toEqual({ enabled: true })
})
