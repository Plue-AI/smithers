import { cloudflareApiBase } from "./cloudflareApi"
/**
 * Deploy preflight for `smithers-mvp-web`: the live script must agree with
 * src/workerIdentity.ts and wrangler.jsonc before `wrangler deploy` runs.
 *
 *   bun scripts/adopt-durable-objects.ts   # report only; exits 1 on a mismatch
 *
 * It never deploys. `bun scripts/deploy.ts` is the one deploy path: it builds
 * the site, stamps it with the sha it records, runs this preflight, deploys
 * with wrangler, and writes the receipt the canary probes grade the
 * deployment against. A deploy from here would skip all four.
 *
 * Why this exists. wrangler uploads the Durable Object bindings and the
 * migrations wrangler.jsonc declares. A declared binding the live script
 * lacks deploys as a fresh, EMPTY class; a live binding the declaration lacks
 * is deleted with its storage; a class renamed under a binding is a
 * migration. Each is data loss, and wrangler reports none of them as an
 * error. This script reads the live script settings and refuses unless
 * src/workerIdentity.ts, wrangler.jsonc, and Cloudflare agree.
 *
 * Secrets are NOT a deploy input. wrangler uploads with
 * `keep_bindings: ["secret_text"]`, so every secret set on the live script
 * with `wrangler secret put` survives a deploy from a shell that does not
 * carry it. The report lists each declared secret as live or not, FAILs on
 * a missing required one, and never prints a value: only names, kinds, and
 * presence.
 *
 * With CLOUDFLARE_API_TOKEN unset it prints what it would check and exits 0,
 * marked INCONCLUSIVE, so a credential-less shell can still read the plan.
 *
 * Read-only, always: only GETs, the same endpoints
 * scripts/canary/rollback-probe.ts uses (shapes read back live 2026-08-18).
 */
import { readWranglerConfig } from "../src/wranglerConfig"
import type { WranglerConfig } from "../src/wranglerConfig"
import { WORKER_IDENTITY } from "../src/workerIdentity"
import type { DurableObjectIdentity } from "../src/workerIdentity"


export type Level = "PASS" | "FAIL" | "WARN" | "INFO" | "SKIP"
export interface Finding {
  readonly level: Level
  readonly check: string
  readonly detail: string
}

/** A binding as `GET .../workers/scripts/{name}/settings` reports it. */
export interface LiveBinding {
  readonly type: string
  readonly name: string
  readonly class_name?: string
  readonly script_name?: string
  readonly text?: string
}

const pair = (binding: DurableObjectIdentity): string => `${binding.binding}=${binding.className}`

/**
 * The one comparison that gates the deploy: the live locally-owned Durable
 * Object bindings and the declared ones must be the same set of
 * (binding name, class name) pairs. Order does not matter to wrangler.
 */
export const compareDurableObjects = (
  declared: ReadonlyArray<DurableObjectIdentity>,
  live: ReadonlyArray<LiveBinding>,
  scriptName: string
): ReadonlyArray<Finding> => {
  const owned = live.filter(
    (binding) =>
      binding.type === "durable_object_namespace" &&
      (binding.script_name === undefined || binding.script_name === scriptName)
  )
  const liveByName = new Map(owned.map((binding) => [binding.name, binding.class_name ?? ""]))
  const declaredByName = new Map(declared.map((binding) => [binding.binding, binding.className]))
  const findings: Finding[] = []
  for (const binding of declared) {
    const liveClass = liveByName.get(binding.binding)
    if (liveClass === undefined) {
      // Authorized additive v5 cutover (DEPLOY.md). No existing class, rename
      // or removal is exempted. This lets main deploy before the vault exists.
      if (scriptName === WORKER_IDENTITY.name && binding.binding === "MODEL_VAULTS" && binding.className === "AccountModelVault" &&
        WORKER_IDENTITY.migrations.some(migration => migration.tag === "v5" && migration.newSqliteClasses.includes(binding.className))) {
        findings.push({ level: "INFO", check: "binding MODEL_VAULTS", detail: "Authorized v5 addition: creates AccountModelVault; existing namespaces are unchanged (DEPLOY.md)." })
        continue
      }
      findings.push({
        level: "FAIL",
        check: `binding ${binding.binding} exists on the live script`,
        detail: `${pair(binding)} is declared but the live script has no binding named ${binding.binding}; the deploy would CREATE an empty class ${binding.className} (new_sqlite_classes)`
      })
    } else if (liveClass !== binding.className) {
      findings.push({
        level: "FAIL",
        check: `binding ${binding.binding} names the same class live`,
        detail: `declared ${pair(binding)} but live is ${binding.binding}=${liveClass}; the deploy would RENAME the class (renamed_classes)`
      })
    } else {
      findings.push({ level: "PASS", check: `binding ${binding.binding}`, detail: `${pair(binding)} matches live` })
    }
  }
  for (const [name, className] of liveByName) {
    if (!declaredByName.has(name)) {
      findings.push({
        level: "FAIL",
        check: `live binding ${name} is declared`,
        detail: `the live script binds ${name}=${className} but src/workerIdentity.ts does not; the deploy would DELETE class ${className} and its storage (deleted_classes)`
      })
    }
  }
  return findings
}

/** wrangler.jsonc (the bridge) must say what src/workerIdentity.ts says. */
export const compareBridge = (config: WranglerConfig = readWranglerConfig()): ReadonlyArray<Finding> => {
  const bridge = config.durable_objects.bindings.map((binding) => `${binding.name}=${binding.class_name}`).sort()
  const declared = WORKER_IDENTITY.durableObjects.map(pair).sort()
  const same = bridge.length === declared.length && bridge.every((entry, index) => entry === declared[index])
  return [
    same
      ? { level: "PASS", check: "wrangler.jsonc agrees with src/workerIdentity.ts", detail: declared.join(", ") }
      : { level: "FAIL", check: "wrangler.jsonc agrees with src/workerIdentity.ts", detail: `wrangler: ${bridge.join(", ")}; identity: ${declared.join(", ")}` },
    config.name === WORKER_IDENTITY.name
      ? { level: "PASS", check: "wrangler.jsonc name", detail: config.name }
      : { level: "FAIL", check: "wrangler.jsonc name", detail: `${config.name} != ${WORKER_IDENTITY.name}` },
    config.observability?.enabled === WORKER_IDENTITY.observability.enabled
      ? { level: "PASS", check: "wrangler.jsonc observability", detail: `enabled=${config.observability.enabled}` }
      : { level: "FAIL", check: "wrangler.jsonc observability", detail: `wrangler: ${JSON.stringify(config.observability ?? null)}; identity: ${JSON.stringify(WORKER_IDENTITY.observability)}` }
  ]
}

/** Workers Logs on the live script: off means every console line is lost unless someone is tailing. */
export const compareObservability = (live: unknown): Finding => {
  const enabled = typeof live === "object" && live !== null && (live as { enabled?: unknown }).enabled === true
  return enabled
    ? { level: "PASS", check: "Workers Logs", detail: "enabled on the live script" }
    : { level: "WARN", check: "Workers Logs", detail: `live observability is ${JSON.stringify(live ?? null)}, so the live script keeps no logs; the deploy turns them on` }
}

/**
 * Vars, secrets and knobs.
 *
 * `WORKER_IDENTITY.vars` are wrangler.jsonc `vars` and deploy as
 * `plain_text`; wrangler replaces the plain-text set wholesale, so a frozen
 * var that drifted live is a FAIL and an undeclared live var is dropped.
 * Secrets and the optional knobs are `secret_text`, set once with
 * `wrangler secret put` and KEPT by every deploy (`keep_bindings`), so this
 * function only reports whether each is live: a missing required secret is a
 * FAIL, because a core route already refuses every user. A knob that a Wrangler-era
 * deploy bound as `plain_text` is the one exception: it is not in `vars`, so
 * the deploy drops it, and re-adding it is `wrangler secret put`.
 */
export const compareVars = (live: ReadonlyArray<LiveBinding>): ReadonlyArray<Finding> => {
  const findings: Finding[] = []
  const livePlain = new Map(live.filter((b) => b.type === "plain_text").map((b) => [b.name, b.text ?? ""]))
  for (const [name, value] of Object.entries(WORKER_IDENTITY.vars)) {
    const liveValue = livePlain.get(name)
    if (liveValue === undefined) findings.push({ level: "WARN", check: `var ${name}`, detail: `declared (${value}) but not on the live script; the deploy adds it` })
    else if (liveValue !== value) findings.push({ level: "FAIL", check: `var ${name}`, detail: `live is ${liveValue}, declared is ${value}; the deploy would change a frozen var` })
    else findings.push({ level: "PASS", check: `var ${name}`, detail: value })
  }
  const knobNames = new Set<string>(WORKER_IDENTITY.optionalVars)
  for (const [name] of livePlain) {
    if (name in WORKER_IDENTITY.vars) continue
    if (knobNames.has(name)) findings.push({ level: "WARN", check: `knob ${name}`, detail: "bound as plain_text on the live script, which the deploy replaces; set it again with `wrangler secret put` to keep it" })
    else findings.push({ level: "WARN", check: `live var ${name}`, detail: "not declared by src/workerIdentity.ts; the deploy DROPS it" })
  }
  const liveSecrets = new Set(live.filter((b) => b.type === "secret_text").map((b) => b.name))
  for (const [name, secret] of Object.entries(WORKER_IDENTITY.secrets)) {
    if (liveSecrets.has(name)) findings.push({ level: "PASS", check: `secret ${name}`, detail: "live; the deploy keeps it (value never read)" })
    else findings.push({ level: secret.required ? "FAIL" : "INFO", check: `secret ${name}`, detail: `not live: ${secret.absent}; \`wrangler secret put ${name}\` sets it` })
  }
  for (const name of WORKER_IDENTITY.optionalVars) {
    if (liveSecrets.has(name)) findings.push({ level: "PASS", check: `knob ${name}`, detail: "live; the deploy keeps it (value never read)" })
  }
  /*
   * An UNDECLARED live secret is kept too, but flagged: a name outside
   * src/workerIdentity.ts feeds nothing the Worker reads (the legacy
   * `GATEWAY_*` names) and is retired by hand with `wrangler secret delete`.
   */
  for (const name of liveSecrets) {
    if (knobNames.has(name) || Object.hasOwn(WORKER_IDENTITY.secrets, name)) continue
    findings.push({ level: "WARN", check: `live secret ${name}`, detail: "not declared by src/workerIdentity.ts; the deploy keeps it, `wrangler secret delete` retires it (DEPLOY.md \"1.0 gateway migration\")" })
  }
  return findings
}

const argOf = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

const cloudflareGet = async (apiToken: string, path: string): Promise<{ ok: true; value: unknown } | { ok: false; detail: string }> => {
  const base = cloudflareApiBase
  try {
    const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${apiToken}` } })
    const text = await response.text()
    if (!response.ok) return { ok: false, detail: `${path} answered ${response.status}: ${text.slice(0, 200)}` }
    const body = JSON.parse(text) as { success?: boolean; result?: unknown }
    if (body.success !== true) return { ok: false, detail: `${path} answered success=false: ${text.slice(0, 200)}` }
    return { ok: true, value: body.result }
  } catch (error) {
    return { ok: false, detail: `${path}: ${error instanceof Error ? error.message : String(error)}` }
  }
}

const print = (finding: Finding): void => {
  const line = `${finding.level.padEnd(4)} ${finding.check}: ${finding.detail}`
  if (finding.level === "FAIL") console.error(line)
  else console.log(line)
}

const explain = (): void => {
  console.log(`[adopt] CLOUDFLARE_API_TOKEN is unset; INCONCLUSIVE. With a token this script would read, read-only:`)
  console.log(`  GET /accounts/${WORKER_IDENTITY.accountId}/workers/scripts/${WORKER_IDENTITY.name}/settings`)
  console.log(`      and hold its durable_object_namespace bindings to: ${WORKER_IDENTITY.durableObjects.map(pair).join(", ")}`)
  console.log(`      (a live binding missing here = deleted class; a declared binding missing live = empty new class),`)
  console.log(`      its plain_text vars to src/workerIdentity.ts, its secret_text names to WORKER_IDENTITY.secrets (a missing required one fails)`)
  console.log(`      and WORKER_IDENTITY.optionalVars (every secret_text is kept by the deploy), and its compatibility date/flags.`)
  console.log(`  GET /accounts/${WORKER_IDENTITY.accountId}/workers/domains?service=${WORKER_IDENTITY.name}`)
  console.log(`      ${WORKER_IDENTITY.domain.name} must be attached to this script or to nothing.`)
  console.log(`  GET /zones/${WORKER_IDENTITY.domain.zoneId}/workers/routes`)
  console.log(`      ${WORKER_IDENTITY.routes.map((r) => r.pattern).join(", ")} must belong to this script or to nothing; other routes of this script in the zone would be removed.`)
  console.log(`  GET /accounts/${WORKER_IDENTITY.accountId}/workers/scripts/${WORKER_IDENTITY.name}/subdomain`)
  console.log(`      reported against workersDev=${WORKER_IDENTITY.workersDev}.`)
}

const main = async (): Promise<number> => {
  const findings: Finding[] = [...compareBridge()]
  const apiToken = process.env.CLOUDFLARE_API_TOKEN
  const accountId = argOf("--account") ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? WORKER_IDENTITY.accountId
  const name = WORKER_IDENTITY.name

  if (apiToken === undefined || apiToken === "") {
    findings.forEach(print)
    explain()
    return findings.some((f) => f.level === "FAIL") ? 1 : 0
  }

  const settings = await cloudflareGet(apiToken, `/accounts/${accountId}/workers/scripts/${name}/settings`)
  if (!settings.ok) {
    findings.push({ level: "FAIL", check: "read live script settings", detail: settings.detail })
  } else {
    const result = settings.value as {
      bindings?: ReadonlyArray<LiveBinding>
      compatibility_date?: string
      compatibility_flags?: ReadonlyArray<string>
      tags?: ReadonlyArray<string>
      observability?: unknown
      logpush?: boolean
    }
    const bindings = result.bindings ?? []
    findings.push(...compareDurableObjects(WORKER_IDENTITY.durableObjects, bindings, name))
    findings.push(...compareVars(bindings))
    const flags = [...(result.compatibility_flags ?? [])].sort().join(",")
    const declaredFlags = [...WORKER_IDENTITY.compatibility.flags].sort().join(",")
    findings.push(
      result.compatibility_date === WORKER_IDENTITY.compatibility.date && flags === declaredFlags
        ? { level: "PASS", check: "compatibility", detail: `${result.compatibility_date} [${flags}]` }
        : { level: "FAIL", check: "compatibility", detail: `live ${result.compatibility_date} [${flags}] vs declared ${WORKER_IDENTITY.compatibility.date} [${declaredFlags}]` }
    )
    findings.push(compareObservability(result.observability))
    findings.push({ level: "INFO", check: "migration tag", detail: `Cloudflare does not report it here; wrangler.jsonc's last tag is ${readWranglerConfig().migrations.at(-1)?.tag}. wrangler sends only the steps after the live tag, so an unchanged list is a no-op; the binding checks above are what prove nothing is created, renamed or deleted` })
    const asset = bindings.find((b) => b.type === "assets")
    findings.push(asset ? { level: "PASS", check: "assets binding", detail: asset.name } : { level: "WARN", check: "assets binding", detail: "the live script has no assets binding; the deploy adds ASSETS" })
  }

  const domains = await cloudflareGet(apiToken, `/accounts/${accountId}/workers/domains?service=${name}`)
  if (domains.ok) {
    const attached = (domains.value as ReadonlyArray<{ hostname?: string; service?: string; zone_id?: string }>) ?? []
    const canary = attached.find((d) => d.hostname === WORKER_IDENTITY.domain.name)
    findings.push(
      canary
        ? { level: "PASS", check: `domain ${WORKER_IDENTITY.domain.name}`, detail: `attached to ${name} (zone ${canary.zone_id})` }
        : { level: "WARN", check: `domain ${WORKER_IDENTITY.domain.name}`, detail: `not attached to ${name}; the deploy attaches it, and fails if another Worker holds it` }
    )
    for (const other of attached) {
      if (other.hostname !== WORKER_IDENTITY.domain.name) findings.push({ level: "WARN", check: `domain ${other.hostname}`, detail: `attached to ${name} but not declared; wrangler leaves it alone, so retire it by hand if it is meant to go` })
    }
  } else findings.push({ level: "WARN", check: "read domains", detail: domains.detail })

  const routes = await cloudflareGet(apiToken, `/zones/${WORKER_IDENTITY.domain.zoneId}/workers/routes`)
  if (routes.ok) {
    const zoneRoutes = (routes.value as ReadonlyArray<{ id?: string; pattern?: string; script?: string }>) ?? []
    for (const route of WORKER_IDENTITY.routes) {
      const live = zoneRoutes.find((r) => r.pattern === route.pattern)
      if (live === undefined) findings.push({ level: "WARN", check: `route ${route.pattern}`, detail: "not in the zone; the deploy creates it" })
      else if (live.script !== name) findings.push({ level: "FAIL", check: `route ${route.pattern}`, detail: `belongs to ${live.script ?? "<none>"}; the deploy would take it over` })
      else findings.push({ level: "PASS", check: `route ${route.pattern}`, detail: `attached to ${name} (id ${live.id})` })
    }
    for (const live of zoneRoutes) {
      if (live.script === name && !WORKER_IDENTITY.routes.some((r) => r.pattern === live.pattern)) {
        findings.push({ level: "WARN", check: `route ${live.pattern}`, detail: `attached to ${name} but not declared; the deploy REMOVES it` })
      }
    }
  } else findings.push({ level: "WARN", check: "read zone routes", detail: routes.detail })

  const subdomain = await cloudflareGet(apiToken, `/accounts/${accountId}/workers/scripts/${name}/subdomain`)
  if (subdomain.ok) {
    const state = subdomain.value as { enabled?: boolean; previews_enabled?: boolean }
    findings.push(
      state.enabled === WORKER_IDENTITY.workersDev
        ? { level: "PASS", check: "workers.dev", detail: `enabled=${state.enabled} previews=${state.previews_enabled}` }
        : { level: "WARN", check: "workers.dev", detail: `live enabled=${state.enabled} previews=${state.previews_enabled}; declared workersDev=${WORKER_IDENTITY.workersDev}, the deploy changes it` }
    )
  } else findings.push({ level: "INFO", check: "workers.dev", detail: subdomain.detail })

  findings.forEach(print)
  const failed = findings.filter((f) => f.level === "FAIL").length
  const warned = findings.filter((f) => f.level === "WARN").length
  console.log(`[adopt] ${failed === 0 ? "GREEN" : "RED"}: ${failed} fail, ${warned} warn`)
  if (failed > 0) {
    console.error("[adopt] refusing: fix every FAIL before a deploy. A binding mismatch is Durable Object data loss; a drifted var is a route pointed at the wrong upstream.")
    return 1
  }
  console.log("[adopt] report only; this script never deploys. The deploy is `bun scripts/deploy.ts`, which builds the site, stamps it, runs this preflight, and writes the receipt.")
  return 0
}

if (import.meta.main) process.exit(await main())
