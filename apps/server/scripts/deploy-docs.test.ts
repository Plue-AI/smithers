import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { WORKER_IDENTITY } from "../src/workerIdentity"
import { stripComments } from "./effect-policy"

const guide = readFileSync(new URL("../DEPLOY.md", import.meta.url), "utf8")
const reference = readFileSync(new URL("../../site/src/content/docs/docs/reference/http-api.mdx", import.meta.url), "utf8")
const deploy = readFileSync(new URL("./deploy.ts", import.meta.url), "utf8")
const preflight = readFileSync(new URL("./adopt-durable-objects.ts", import.meta.url), "utf8")
const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")
const workflow = readFileSync(new URL("../../../.github/workflows/apps-deploy.yml", import.meta.url), "utf8")
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
  scripts: Record<string, string>
}

test("deployment guide has one gateway migration and one upstream section", () => {
  expect(guide.match(/^### 1\.0 gateway migration$/gm)).toHaveLength(1)
  expect(guide.match(/^### Other upstream services$/gm)).toHaveLength(1)
})

test("frozen identity warning names every configured Durable Object binding", () => {
  const warning = guide.split("## Frozen identity")[1]!.split("Never edit")[0]!
  const bindings = [...config.matchAll(/"name":\s*"([A-Z_]+)",\s*"class_name":/g)]
  expect(bindings.length).toBeGreaterThan(0)
  for (const [, binding] of bindings) expect(warning).toContain(`\`${binding}\``)
})

for (const [name, source] of [["deployment guide", guide], ["HTTP reference", reference]] as const) {
  test(`${name} documents retired Worker mounts and the authenticated replacement`, () => {
    expect(source).not.toMatch(/When (?:the web Worker's )?`GATEWAY_UPSTREAM_URL` (?:is configured|is set)/)
    expect(source).not.toMatch(/relay (?:answers|fails closed with) `?501/)
    expect(source).not.toMatch(/Only ordinary `GET`|Ordinary `GET`/)
    for (const route of ["/rpc", "/projections", "/sync", "/health", "/api/workflow/provision", "/api/workflow/rpc"]) {
      expect(source).toContain(`\`${route}\``)
    }
    expect(source).toContain("gateway_proxy_removed")
    expect(source).toContain("HTTP 410")
    expect(source).toContain("validated, allowlisted session")
  })
}

test("receipt recovery is automatic even when publication identity is missing", () => {
  expect(guide).toContain("automatically restores")
  expect(guide).toContain("deploy-receipts/rollout/latest.json")
  expect(guide).not.toContain("writes no fresh receipt")
  expect(guide).not.toContain("Nothing rolls back automatically")
})

test("the deploy tool is this package's wrangler, and the guide names it", () => {
  const pin = manifest.devDependencies.wrangler
  expect(pin).toMatch(/^\^?4\./)
  expect(stripComments(deploy)).toContain("node_modules/wrangler/bin/wrangler.js")
  expect(stripComments(deploy)).not.toContain("alchemy")
  expect(manifest.dependencies.alchemy).toBeUndefined()
  expect(guide).toContain("`wrangler deploy`")
  expect(manifest.scripts["check:effect"]).toBe("bun scripts/effect-policy.ts")
  expect(manifest.scripts["deploy:preflight"]).toBe("bun scripts/adopt-durable-objects.ts")
})

/*
 * The whole point of the wrangler path: a deploy never needs a secret value
 * in the shell, so no document, script or workflow may ask for one. The
 * previous (Alchemy) path replaced the bindings wholesale, needed all eleven
 * values exported, and never ran because nobody had them.
 */
test("the guide says secrets are set once and kept by every deploy", () => {
  const section = guide.split("## Secrets")[1]!.split("## Scripted deploy")[0]!
  expect(section).toContain("`wrangler secret put`")
  expect(section).toContain("keep_bindings")
  expect(section).toContain("kept by every deploy")
  expect(guide).not.toContain("--allow-secret-drop")
  expect(guide).not.toContain("dropped by the deploy")
  expect(guide).not.toContain(".alchemy/state")
})

test("the preflight section names every way a deploy loses Durable Object data", () => {
  const section = guide.split("## The preflight")[1]!.split("## Secrets")[0]!
  expect(section).toContain("scripts/adopt-durable-objects.ts")
  for (const migration of ["new_sqlite_classes", "deleted_classes", "renamed_classes"]) expect(section).toContain(migration)
})

test("the secrets section names every secret and knob the Worker reads, and no value", () => {
  const section = guide.split("## Secrets")[1]!.split("## Scripted deploy")[0]!
  for (const name of Object.keys(WORKER_IDENTITY.secrets)) expect(section).toContain(`\`${name}\``)
  for (const name of WORKER_IDENTITY.optionalVars) expect(section).toContain(`\`${name}\``)
  const required = Object.entries(WORKER_IDENTITY.secrets).filter(([, secret]) => secret.required).map(([name]) => `\`${name}\``)
  expect(section.split("FAILs on a missing\nrequired one (")[1]?.split(")")[0]?.split(/,\s+/)).toEqual(required)
  expect(guide).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----\n[A-Za-z0-9+/=]{20,}/)
})

/*
 * CI parity: Cloudflare credentials deploy the Worker. The one additional
 * Worker secret is consumed only by CN-23's read-only allowlist probe, never
 * uploaded as a binding. apps-deploy.yml remains hand-maintained.
 */
const deployRealEnv = (): string => {
  const step = workflow.split("- name: Deploy (real)")[1]!
  return step.split("run:")[0]!
}

test("the CI deploy step exports only deployment and read-only probe credentials", () => {
  const env = deployRealEnv()
  expect(env).toContain("CLOUDFLARE_API_TOKEN:")
  expect(env).toContain("CLOUDFLARE_ACCOUNT_ID:")
  for (const name of [...Object.keys(WORKER_IDENTITY.secrets), ...WORKER_IDENTITY.optionalVars]) {
    if (name === "IDENTITY_SERVICE_TOKEN") continue // Read-only CN-23, never passed to wrangler as a binding.
    expect(`${name}: ${new RegExp(`^\\s+${name}: `, "m").test(env)}`).toBe(`${name}: false`)
  }
  expect(env).not.toContain("${{ secrets.GITHUB_TOKEN }}")
})

test("the preflight is documented as read-only, with no --apply", () => {
  expect(guide).not.toContain("--apply")
  expect(preflight).not.toContain("Bun.spawn")
})

test("the deploy reads the sha back from the build it publishes", () => {
  expect(stripComments(deploy)).toContain("__build.json")
  expect(stripComments(deploy)).toContain("Current Version ID")
})

/*
 * One deploy path: every push to main, through the production environment.
 * A local hook published unpushed and rewritten commits for ten days while the
 * guide named a tag nobody cut; the refusal in scripts/deployRevision.ts and
 * this description now say the same thing.
 */
test("the deploy tags the version with its sha and the guide names the one deploy path", () => {
  expect(stripComments(deploy)).toContain("wranglerDeployArgs")
  expect(stripComments(deploy)).toContain("judgeRevision")
  expect(readFileSync(new URL("./deployRevision.ts", import.meta.url), "utf8")).toContain('"--tag"')
  const section = guide.split("\n## CI (every push to main)")[1]!.split("\n## ")[0]!
  expect(section).toContain("push to `main`")
  expect(section).toContain("`production` environment")
  expect(section).toContain("origin/main")
  expect(guide).not.toContain("apps-v")
})

/*
 * Drift an operator acts on. The guide once told operators to set tutorial
 * secrets no code read, counted five Durable Objects after the sixth landed,
 * pinned a wrangler the lockfile had left, and sent the drill write-up to a
 * file that never existed.
 */
const deploymentNames = new Set<string>([
  ...Object.keys(WORKER_IDENTITY.secrets),
  ...WORKER_IDENTITY.optionalVars,
  ...Object.keys(WORKER_IDENTITY.vars)
])
const retiredGatewayNames = (): ReadonlySet<string> => {
  const section = guide.split("### 1.0 gateway migration")[1]!.split("\n### ")[0]!
  return new Set([...section.matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map(([, name]) => name!))
}

test("the guide names no Worker setting outside src/workerIdentity.ts", () => {
  const external = new Set(["CLOUDFLARE_API_TOKEN", "SMITHERS_AUTH_WORKER_EXCHANGE_TOKEN"])
  const retired = retiredGatewayNames()
  const settings = [...guide.matchAll(/`([A-Z][A-Z0-9_]*_(?:TOKEN|URL|KEY|SALT|SECRET))`/g)].map(([, name]) => name!)
  expect(settings.length).toBeGreaterThan(0)
  const stray = [...new Set(settings)].filter((name) => !deploymentNames.has(name) && !external.has(name) && !retired.has(name))
  expect(stray).toEqual([])
})

const numberWords = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"]

test("every count the guide states matches src/workerIdentity.ts", () => {
  const expected: Record<string, number> = {
    "durable objects": WORKER_IDENTITY.durableObjects.length,
    "bindings": WORKER_IDENTITY.durableObjects.length,
    "vars": Object.keys(WORKER_IDENTITY.vars).length,
    "declared secrets": Object.keys(WORKER_IDENTITY.secrets).length
  }
  const pattern = new RegExp(`\\b(${numberWords.join("|")})\\s+(?:frozen\\s+)?(Durable Objects|bindings|vars|declared secrets)\\b`, "gi")
  const counts = [...guide.matchAll(pattern)].map(([match, word, noun]) => ({ match, stated: numberWords.indexOf(word!.toLowerCase()), noun: noun!.toLowerCase() }))
  expect(counts.length).toBeGreaterThan(0)
  for (const { match, stated, noun } of counts) expect(`${match} = ${stated}`).toBe(`${match} = ${expected[noun]}`)
})

test("every wrangler command in the guide runs this package's wrangler", () => {
  expect(guide).not.toMatch(/wrangler@\d/)
})

test("every Markdown file the guide points at exists", () => {
  const paths = [...guide.matchAll(/`([^`\s]+\.md)`/g)].map(([, path]) => path!)
  expect(paths.length).toBeGreaterThan(0)
  const roots = [new URL("../", import.meta.url), new URL("../../../", import.meta.url)]
  const missing = paths.filter((path) => !roots.some((root) => existsSync(new URL(path, root))))
  expect(missing).toEqual([])
})

test("the rollback drill records its result in the guide", () => {
  const drill = guide.split("### The drill")[1]!.split("\n### ")[0]!
  expect(drill).toContain("\"Drill record\"")
  expect(drill).toMatch(/^#### Drill record$/m)
})

test("wrangler.jsonc lists no var among the Cloudflare secrets", () => {
  const secretNotes = config.split("Cloudflare secrets")[1]!.split("\n\t}")[0]!
  const listed = [...secretNotes.matchAll(/^\s*\/\/\s{3}([A-Z][A-Z0-9_]*)\s/gm)].map(([, name]) => name!)
  expect(listed.length).toBeGreaterThan(0)
  expect(listed.filter((name) => name in WORKER_IDENTITY.vars)).toEqual([])
  expect(listed.filter((name) => !(name in WORKER_IDENTITY.secrets) && !WORKER_IDENTITY.optionalVars.includes(name))).toEqual([])
})

test("deploy commands are unique and every documented server script exists", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> }
  const commands = Object.values(manifest.scripts)
  expect(new Set(commands).size).toBe(commands.length)
  const documented = [...guide.matchAll(/pnpm --filter smithers-server run ([\w:-]+)/g)].map(([, script]) => script!)
  expect(documented.length).toBeGreaterThan(0)
  for (const script of documented) expect(manifest.scripts[script]).toBeDefined()
})
