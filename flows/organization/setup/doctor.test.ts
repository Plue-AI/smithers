import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"
import { atLeast, command, doctor, type DoctorOptions, hypervisorLine, type Line, render } from "./doctor.ts"
import { init } from "./init.ts"
import type { Install } from "./microsandbox.ts"
import { reactionScopes, teamChannelScopes } from "./templates.ts"
import type { System as NodeSystem } from "./node.ts"
import type { Io } from "./settings.ts"

const scratch = mkdtempSync(join(tmpdir(), "org-doctor-"))
after(() => rmSync(scratch, { recursive: true, force: true }))

const root = join(scratch, "wiki"), stateDir = join(scratch, "state"), checkout = join(scratch, "checkout")
const repo = join(scratch, "repo")
// Rosters whose workspace roles are granted no repository, or two.
const noWorkspace = join(scratch, "no-workspace-wiki"), twoRepos = join(scratch, "two-repos-wiki")
const botToken = "xoxb-test-bot-secret", appToken = "xapp-test-app-secret", modelKey = "sk-test-model-secret"

// A stand-in `msb`: `--version`, and `image inspect` of the one cached image.
const fakeCli = join(scratch, "msb.mjs")
const install: Install = { packageDir: scratch, version: "0.0.0-test", cli: [process.execPath, fakeCli] }

// A Slack Web API fixture: the bot token passes auth.test in team T1, the app
// token opens a socket; anything else is `invalid_auth`.
const calls: Array<string> = []
let slack: Server
let slackUrl = ""

before(async () => {
  await init({ dir: root, stateDir, appName: "Smithers Org" })
  for (const [dir, builder, checker] of [[noWorkspace, "[]", "[]"], [twoRepos, "[example/demo]", "[example/other]"]] as const) {
    await init({ dir, stateDir: `${dir}-state`, appName: "Smithers Org" })
    for (const [role, repositories] of [["builder", builder], ["checker", checker]] as const) {
      const file = join(dir, "Org", "Roles", `${role}.md`)
      writeFileSync(file, readFileSync(file, "utf8").replace("repositories: [example/demo]", `repositories: ${repositories}`))
    }
  }
  mkdirSync(join(checkout, "target", "release"), { recursive: true })
  writeFileSync(join(checkout, ".node-version"), "26.4.0\n")
  writeFileSync(join(checkout, "target", "release", "smithers-jj-export"), "#!/bin/sh\n")
  chmodSync(join(checkout, "target", "release", "smithers-jj-export"), 0o755)
  writeFileSync(fakeCli, [
    "const [a, b, c] = process.argv.slice(2)",
    "if (a === '--version') { console.log('msb 0.0.0-test'); process.exit(0) }",
    "if (a === 'image' && b === 'inspect') process.exit(c === 'node:26-bookworm' ? 0 : 1)",
    "if (a === 'pull') process.exit(b === 'pullable:1' ? 0 : 1)",
    "process.exit(3)"
  ].join("\n"))
  mkdirSync(codexHome)
  writeFileSync(join(codexHome, "auth.json"), "{}\n")
  mkdirSync(repo)
  spawnSync("git", ["init", "-q", repo])
  spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"])
  slack = createServer((request, response) => {
    calls.push(request.url!)
    const token = request.headers.authorization
    const body = request.url === "/api/auth.test" && token === `Bearer ${botToken}`
      ? { ok: true, team_id: "T1", user_id: "UBOT" }
      : request.url === "/api/apps.connections.open" && token === `Bearer ${appToken}`
      ? { ok: true, url: "wss://fixture" }
      : { ok: false, error: "invalid_auth" }
    response.setHeader("content-type", "application/json")
    // An app installed from the current manifest holds every team-channel and reaction scope;
    // `xoxb-old` predates both, `xoxb-unreacting` the reactions only.
    const scopes = token === `Bearer ${botToken}`
      ? [...teamChannelScopes, ...reactionScopes]
      : token === "Bearer xoxb-unreacting"
      ? teamChannelScopes
      : ["chat:write"]
    if (request.url === "/api/auth.test") response.setHeader("x-oauth-scopes", scopes.join(","))
    const older = token === "Bearer xoxb-old" || token === "Bearer xoxb-unreacting"
    response.end(JSON.stringify(older && request.url === "/api/auth.test" ? { ok: true, team_id: "T1", user_id: "UBOT" } : body))
  })
  await new Promise<void>((resolve) => slack.listen(0, "127.0.0.1", resolve))
  const address = slack.address()
  slackUrl = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}/api`
})
after(() => slack.close())

// A ChatGPT login where the codex CLI keeps it, for the `openai:*` seats.
const codexHome = join(scratch, "codex")

const healthyEnv = () => ({
  CODEX_HOME: codexHome,
  // A stale key the subscription mode must not use.
  OPENAI_API_KEY: modelKey,
  SMITHERS_SLACK_BOT_TOKEN: botToken,
  SMITHERS_SLACK_APP_TOKEN: appToken,
  SMITHERS_SLACK_TEAM_IDS: "T1",
  SMITHERS_SLACK_USER_IDS: "UOWNER",
  SMITHERS_SLACK_API_BASE_URL: slackUrl
})

/** One Homebrew Node reporting `version`, and nothing else installed. */
const fakeNode = (version: string): NodeSystem => ({
  exists: (path) => path === "/fake/node" || path === "/opt/homebrew/bin/brew",
  list: () => [],
  version: () => version,
  real: (path) => path,
  homebrew: ["/fake/node"]
})

const healthy = (overrides: Partial<DoctorOptions> = {}): DoctorOptions => ({
  root,
  repos: [`example/demo=${repo}`],
  stateDir,
  env: healthyEnv(),
  checkout,
  node: fakeNode("26.5.0"),
  install,
  hypervisor: () => ({ name: "hypervisor", status: "pass", detail: "fixture" }),
  probe: async (image) => ({ ok: true, detail: `${image} booted`, durationMs: 1 }),
  ...overrides
})

const byName = (lines: ReadonlyArray<Line>, name: string) => lines.filter((line) => line.name === name)
const one = (lines: ReadonlyArray<Line>, name: string) => {
  const found = byName(lines, name)
  assert.equal(found.length, 1, name)
  return found[0]!
}

/** A hire's charter sections, from the package's fixture roster. */
const charter = readFileSync(
  new URL("../../../packages/smithers/agent/organization/test/fixtures/org/Specialists/lead.research.md", import.meta.url),
  "utf8"
).split("\n---\n")[1]!

const specialist = (slug: string, status: "active" | "retired") => `---
id: lead.${slug}
name: ${slug}
kind: specialist
status: ${status}
version: 1.0.0
reportsTo: lead
seat: openai:gpt-6-sol
grants:
  tools: ${status === "retired" ? "[]" : "[wiki-read]"}
  connections: []
  knowledge: ${status === "retired" ? "[]" : "[\"Org/Roles/\"]"}
  repositories: []
  personalAccounts: false
  contact: via-parent
budget: { tokensPerTask: 1000, tasksPerDay: 1, concurrency: 1 }
memory: { namespace: agent-lead.${slug} }
skills: []
cases: []
identities: {}
hiredBy: lead
hiredAt: 2026-09-20T16:00:00Z
${status === "retired" ? "retiredAt: 2026-09-21T16:00:00Z\n" : ""}---
${charter}`

test("counts roles and hires apart, and leaves retired hires out", async () => {
  const dir = join(scratch, "hired-wiki")
  await init({ dir, stateDir: `${dir}-state`, appName: "Smithers Org" })
  writeFileSync(join(dir, "Org", "Specialists", "lead.active.md"), specialist("active", "active"))
  writeFileSync(join(dir, "Org", "Specialists", "lead.gone.md"), specialist("gone", "retired"))
  const lines = await doctor(healthy({ root: dir }))
  assert.match(one(lines, "org").detail, /^4 roles, 1 hired, 1 skills, 0 gates/)
})

test("every check passes on a complete setup, in a stable order, without printing a secret", async () => {
  const lines = await doctor(healthy())
  assert.deepEqual(lines.map((line) => line.name), [
    "node", "microsandbox", "hypervisor", "org", "image", "boot", "jj", "jj-export", "seats", "slack", "slack team", "slack reactions", "slack socket", "repo", "state"
  ])
  assert.deepEqual(lines.filter((line) => line.status !== "pass"), [])
  assert.equal(one(lines, "slack team").detail, "#smithers-team")
  assert.match(one(lines, "org").detail, /^4 roles, 1 skills, 0 gates/)
  assert.equal(one(lines, "slack").detail, "auth.test ok (team T1)")
  const printed = render(lines).join("\n")
  for (const secret of [botToken, appToken, modelKey]) assert.ok(!printed.includes(secret))
  assert.ok(calls.includes("/api/auth.test") && calls.includes("/api/apps.connections.open"))
})

test("Slack is skipped without tokens and each Slack misconfiguration fails with its fix", async () => {
  const { SMITHERS_SLACK_BOT_TOKEN: _b, SMITHERS_SLACK_APP_TOKEN: _a, ...noTokens } = healthyEnv()
  const skipped = await doctor(healthy({ env: noTokens }))
  assert.deepEqual(byName(skipped, "slack").concat(byName(skipped, "slack socket")).map((line) => [line.status, line.detail]), [
    ["skip", "no tokens"], ["skip", "no tokens"]
  ])
  assert.ok(skipped.every((line) => line.status !== "fail"))
  const cases: Array<[Record<string, string>, RegExp]> = [
    [{ SMITHERS_SLACK_BOT_TOKEN: "" }, /SMITHERS_SLACK_BOT_TOKEN is missing/],
    [{ SMITHERS_SLACK_APP_TOKEN: "xoxb-wrong-kind" }, /SMITHERS_SLACK_APP_TOKEN .*xapp-/],
    [{ SMITHERS_SLACK_TEAM_IDS: "" }, /SMITHERS_SLACK_TEAM_IDS is empty; auth\.test team is T1/],
    [{ SMITHERS_SLACK_USER_IDS: "" }, /SMITHERS_SLACK_USER_IDS is empty/],
    [{ SMITHERS_SLACK_TEAM_IDS: "T2" }, /team T1 is not in SMITHERS_SLACK_TEAM_IDS/],
    [{ SMITHERS_SLACK_BOT_TOKEN: "xoxb-revoked" }, /auth\.test: invalid_auth/]
  ]
  for (const [change, expected] of cases) {
    const line = one(await doctor(healthy({ env: { ...healthyEnv(), ...change } })), "slack")
    assert.equal(line.status, "fail", String(expected))
    assert.match(line.detail, expected)
    assert.ok(line.fix)
  }
  assert.equal(one(await doctor(healthy({ env: { ...healthyEnv(), SMITHERS_SLACK_TEAM_IDS: "" } })), "slack").fix, "set SMITHERS_SLACK_TEAM_IDS=T1")
  const socket = one(await doctor(healthy({ env: { ...healthyEnv(), SMITHERS_SLACK_APP_TOKEN: "xapp-revoked" } })), "slack socket")
  assert.equal(socket.status, "fail")
  assert.match(socket.detail, /apps\.connections\.open: invalid_auth/)
  const old = one(await doctor(healthy({ env: { ...healthyEnv(), SMITHERS_SLACK_BOT_TOKEN: "xoxb-old" } })), "slack team")
  assert.equal(old.status, "fail")
  assert.match(old.detail, /missing scopes channels:history, channels:join, channels:manage, channels:read, chat:write\.customize, chat:write\.public/)
  assert.equal(old.fix, "reinstall the app from the updated manifest")
  const unreacting = await doctor(healthy({ env: { ...healthyEnv(), SMITHERS_SLACK_BOT_TOKEN: "xoxb-unreacting" } }))
  assert.equal(one(unreacting, "slack team").status, "pass")
  const reactions = one(unreacting, "slack reactions")
  assert.equal(reactions.status, "fail")
  assert.equal(reactions.detail, "missing scope reactions:write; acknowledgements are posted as text until then")
  assert.equal(reactions.fix, "reinstall the app from the updated manifest")
  const offline = await doctor(healthy({ fetch: async () => { throw new Error("offline") } }))
  assert.match(one(offline, "slack").detail, /offline/)
  assert.match(one(offline, "slack socket").detail, /offline/)
})

test("seats resolve on the ChatGPT login, never on a key, and a missing login fails naming the sign-in", async () => {
  const seats = one(await doctor(healthy()), "seats")
  assert.equal(seats.status, "pass")
  assert.equal(seats.detail, `openai:gpt-6-sol, openai:gpt-6-luna resolve on subscriptions (ChatGPT login ${join(codexHome, "auth.json")})`)
  const signedOut = one(await doctor(healthy({ env: { ...healthyEnv(), CODEX_HOME: join(scratch, "no-codex") } })), "seats")
  assert.equal(signedOut.status, "fail")
  assert.match(signedOut.detail, /codex login/)
  assert.doesNotMatch(signedOut.detail, new RegExp(modelKey))
  assert.match(signedOut.fix!, /codex login/)
})

test("api-key mode resolves on keys, a missing key fails naming the variable, and an unknown mode is refused", async () => {
  const keyed = one(await doctor(healthy({ env: { ...healthyEnv(), SMITHERS_ORG_AUTH: "api-key" } })), "seats")
  assert.equal(keyed.status, "pass")
  assert.match(keyed.detail, /resolve on API keys$/)
  const { OPENAI_API_KEY: _key, ...env } = healthyEnv()
  const missing = one(await doctor(healthy({ env: { ...env, SMITHERS_ORG_AUTH: "api-key" } })), "seats")
  assert.equal(missing.status, "fail")
  assert.match(missing.detail, /OPENAI_API_KEY/)
  assert.equal(missing.fix, "add the key to the .env file doctor read")
  const unknown = one(await doctor(healthy({ env: { ...healthyEnv(), SMITHERS_ORG_AUTH: "keys" } })), "seats")
  assert.equal(unknown.status, "fail")
  assert.match(unknown.detail, /SMITHERS_ORG_AUTH must be/)
})

test("a missing jj fails naming the install", async () => {
  const jj = one(await doctor(healthy({ jj: join(scratch, "no-jj") })), "jj")
  assert.equal(jj.status, "fail")
  assert.match(jj.fix!, /install jj/)
})

test("host prerequisites fail with the command that fixes them", async () => {
  const old = await doctor(healthy({ node: fakeNode("26.3.9") }))
  assert.match(one(old, "node").detail, /^v26\.3\.9 is older than 26\.4\.0$/)
  assert.equal(one(old, "node").fix, "brew install node")
  const none = await doctor(healthy({ node: { ...fakeNode("26.5.0"), homebrew: [] } }))
  assert.match(one(none, "node").detail, /^no Node >= 26\.4\.0$/)
  const missing = await doctor(healthy({ install: null }))
  assert.equal(one(missing, "microsandbox").status, "fail")
  assert.match(one(missing, "microsandbox").fix!, /pnpm -C .* install/)
  // Without a working microsandbox the probe is not attempted, and says why.
  assert.match(one(missing, "boot").detail, /not attempted: microsandbox failed/)
  const noHypervisor = await doctor(healthy({ hypervisor: () => ({ name: "hypervisor", status: "fail", detail: "none", fix: "x" }) }))
  assert.match(one(noHypervisor, "boot").detail, /not attempted: hypervisor failed/)
  const bootFails = await doctor(healthy({ probe: async () => ({ ok: false, detail: "guest crashed", durationMs: 1 }) }))
  assert.equal(one(bootFails, "boot").status, "fail")
  assert.match(one(bootFails, "boot").fix!, /msb\.mjs doctor$/)
  const bare = join(scratch, "bare-checkout")
  mkdirSync(bare, { recursive: true })
  writeFileSync(join(bare, ".node-version"), "26.4.0\n")
  const helper = one(await doctor(healthy({ checkout: bare })), "jj-export")
  assert.equal(helper.status, "fail")
  assert.match(helper.fix!, /^cargo \+1\.98\.0 build --release --locked -p smithers-ffi --bin smithers-jj-export/)
  const configured = one(await doctor(healthy({ checkout: bare, env: { ...healthyEnv(), SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: join(checkout, "target", "release", "smithers-jj-export") } })), "jj-export")
  assert.equal(configured.status, "pass")
  assert.equal(hypervisorLine("win32").status, "fail")
  assert.ok(atLeast("26.10.0", "26.4.0") && !atLeast("25.99.0", "26.0.0") && atLeast("26.4", "26.4.0"))
})

test("the image must be configured and cached or pullable", async () => {
  const org = join(scratch, "image-wiki")
  await init({ dir: org, stateDir: join(scratch, "image-state"), appName: "Smithers Org" })
  const page = join(org, "Org", "Organization.md")
  const text = readFileSync(page, "utf8")
  const progress: Array<string> = []
  const withImage = async (image: string) => {
    writeFileSync(page, text.replace("image: node:26-bookworm", `image: ${image}`))
    return doctor(healthy({ root: org, progress: (line) => progress.push(line) }))
  }
  const unset = await withImage("null")
  assert.match(one(unset, "image").detail, /vm\.image is unset/)
  assert.match(one(unset, "boot").detail, /not attempted: image failed/)
  assert.deepEqual(progress, [])
  assert.equal(one(await withImage("pullable:1"), "image").detail, "pullable:1 pulled")
  // A pull can take minutes; the command says so before it starts.
  assert.deepEqual(progress, ["pulling pullable:1…"])
  const absent = one(await withImage("absent:1"), "image")
  assert.equal(absent.status, "fail")
  assert.match(absent.fix!, /msb\.mjs pull absent:1$/)
})

test("the Org, repositories and state directory are checked", async () => {
  const noOrg = await doctor(healthy({ root: join(scratch, "nowhere") }))
  assert.match(one(noOrg, "org").fix!, /^init /)
  assert.match(one(noOrg, "seats").detail, /no organization loaded/)
  const broken = join(scratch, "broken-wiki")
  await init({ dir: broken, stateDir: join(scratch, "broken-state"), appName: "Smithers Org" })
  rmSync(join(broken, "Org", "Skills"), { recursive: true })
  const invalid = one(await doctor(healthy({ root: broken })), "org")
  assert.equal(invalid.status, "fail")
  assert.match(invalid.detail, /skills/)
  const repos = await doctor(healthy({ repos: [`example/demo=${repo}`, `other=${scratch}`] }))
  assert.deepEqual(byName(repos, "repo").map((line) => line.status), ["pass", "fail"])
  assert.match(byName(repos, "repo")[0]!.detail, /^example\/demo = .* \(builder, checker\)$/)
  assert.match(byName(await doctor(healthy({ repos: [] })), "repo")[0]!.fix!, /^set SMITHERS_ORG_REPOS=example\/demo=<path>/)
  const empty = join(scratch, "empty-repo")
  spawnSync("git", ["init", "-q", empty])
  assert.match(one(await doctor(healthy({ repos: [empty] })), "repo").detail, /has no commit/)
  // A bare path is named by its directory; no role is granted that name, so every delivery would block.
  const bare = one(await doctor(healthy({ repos: [repo] })), "repo")
  assert.equal(bare.status, "fail")
  assert.equal(bare.detail, `repo (${repo}) is granted to no active role holding workspace`)
  assert.equal(bare.fix, `set SMITHERS_ORG_REPOS=example/demo=${repo}`)
  // A relative path resolves against the caller's directory.
  assert.equal(one(await doctor(healthy({ repos: ["example/demo=repo"], cwd: scratch })), "repo").status, "pass")
  // A roster that grants the repository to no workspace role says so.
  const ungranted = await doctor(healthy({ root: noWorkspace, repos: [`example/demo=${repo}`] }))
  assert.match(one(ungranted, "repo").fix!, /^grant example\/demo to a role with workspace/)
  // Several granted names are listed.
  const several = one(await doctor(healthy({ root: twoRepos, repos: [repo] })), "repo")
  assert.match(several.fix!, /^set SMITHERS_ORG_REPOS=<name>=.* \(granted: example\/demo, example\/other\)$/)
  const open = join(scratch, "open-state")
  mkdirSync(open, { mode: 0o755 })
  chmodSync(open, 0o755)
  assert.match(one(await doctor(healthy({ stateDir: open })), "state").fix!, /^chmod 700/)
  const file = join(scratch, "state-file")
  writeFileSync(file, "")
  assert.equal(one(await doctor(healthy({ stateDir: join(file, "sub") })), "state").status, "fail")
})

test("the command reads the state dir's .env, exits 1 on a failure, and renders fixes", async () => {
  const out: Array<string> = []
  const io: Io = { out: (line) => out.push(line), err: (line) => out.push(line), env: { SMITHERS_ORG_STATE_DIR: stateDir }, cwd: scratch }
  // The seeded .env names the root and no repository, and has no model key.
  const code = await command.run([], io)
  assert.equal(code, 1)
  assert.equal(out[0], `env    ${join(stateDir, ".env")}`)
  assert.equal(out[1], `root   ${root}`)
  assert.ok(out.some((line) => /^FAIL {2}repo +no repository configured$/.test(line)))
  assert.ok(out.some((line) => /^ +fix: set SMITHERS_ORG_REPOS/.test(line)))
})

test("each repository with an environment gets its base and tools lines, with machines only for declared tools on a host that boots", async () => {
  const dir = join(scratch, "environment-wiki")
  await init({ dir, stateDir: `${dir}-state`, appName: "Smithers Org" })
  const page = join(dir, "Org", "Organization.md")
  const locked = join(scratch, "locked-repo")
  mkdirSync(locked)
  spawnSync("git", ["init", "-q", locked])
  writeFileSync(join(locked, "deps.lock"), "x\n")
  spawnSync("git", ["-C", locked, "add", "-A"])
  spawnSync("git", ["-C", locked, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"])
  const environment = (tools: string) =>
    readFileSync(page, "utf8").replace(
      /\nwiki:\n/,
      `\nrepositories:\n  example/demo:\n    base: origin/main\n    prepare:\n      run: "true"\n      key: [deps.lock]\n      network: none\n${tools}wiki:\n`
    )
  const seen: Array<{ readonly name: string; readonly machines: boolean; readonly base: string | undefined }> = []
  const bases: DoctorOptions["bases"] = async (check) => {
    seen.push({ name: check.name, machines: check.machines !== undefined, base: check.environment.base })
    return [{ name: "base", status: "pass", detail: `${check.name}: origin/main → fixture` }]
  }
  writeFileSync(page, environment(""))
  const plain = await doctor(healthy({ root: dir, bases, repos: [`example/demo=${locked}`] }))
  assert.deepEqual(plain.map((line) => line.name).slice(-4), ["repo", "env", "base", "state"])
  assert.deepEqual(seen, [{ name: "example/demo", machines: false, base: "origin/main" }])
  // Declared tools on a host that does not boot: no machines to look in.
  writeFileSync(page, environment("      tools: [rg]\n"))
  await doctor(healthy({
    root: dir,
    bases,
    repos: [`example/demo=${locked}`],
    probe: async () => ({ ok: false, detail: "no", durationMs: 1 })
  }))
  assert.deepEqual(seen.at(-1), { name: "example/demo", machines: false, base: "origin/main" })
  // A repository whose environment line failed gets no base line.
  const missingKey = await doctor(healthy({ root: dir, bases, repos: [`example/demo=${scratch}`] }))
  assert.equal(byName(missingKey, "base").length, 0)
})
