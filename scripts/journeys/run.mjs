import { mkdir, readFile, stat, writeFile, copyFile, realpath } from "node:fs/promises"
import { createHash } from "node:crypto"
import { createInterface } from "node:readline/promises"
import { dirname, join, resolve, relative, isAbsolute } from "node:path"
import { fileURLToPath } from "node:url"
import { journeys } from "./steps/index.mjs"
import { assertCanaryRepository, ensureCanaryRepository } from "./canary-repo.mjs"
import { githubActors } from "./github-actors.mjs"
import { outsideSave } from "./outside-save.mjs"
import { startBrowserStep, startMacRecording, startRemoteMacRecording } from "./record.mjs"
import { cli, isMain, required, createStepLog } from "./lib.mjs"
import { verifyActivation, verifyCredentialSoak } from "./evidence.mjs"
import { githubApi } from "./github-api.mjs"
import { duplicateLaunch, restartBackend } from "./faults.mjs"

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
export { createStepLog } from "./lib.mjs"
const THEMES = ["light", "dark"]
const CHECK_ID = /^C-(?:J\d+|UI|REL)-\d{2}$/
export const checksOf = (step) => [step.check, ...(step.checks ?? [])]

export function publicOrigin(value) {
  const url = new URL(value)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Origin must be an http or https origin without credentials, path or query")
  return url.origin
}

export function parseArgs(argv) {
  const options = { dryRun: false }
  const seen = new Set()
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    if (seen.has(flag)) throw new Error(`Duplicate option ${flag}`)
    seen.add(flag)
    if (flag === "--dry-run") options.dryRun = true
    else if (flag === "--help") options.help = true
    else if (["--theme", "--journey", "--origin"].includes(flag)) {
      const value = argv[++index]
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`)
      options[flag.slice(2)] = flag === "--origin" ? publicOrigin(value) : value
    } else throw new Error(`Unknown option ${flag}`)
  }
  buildSchedule(options)
  return options
}

export function buildSchedule({ theme, journey } = {}) {
  if (theme !== undefined && !THEMES.includes(theme)) throw new Error("Theme must be light or dark")
  if (journey !== undefined && !journeys.some((item) => item.id === journey)) throw new Error("Journey must be J1–J8, J10 or J11; J9 is out of scope")
  return (theme ? [theme] : THEMES).flatMap((color) => journeys.filter((item) => !journey || item.id === journey).map((item) => ({
    journey: item.id, title: item.title, theme: color, browsers: ["chromium", "webkit"], steps: structuredClone(item.steps)
  })))
}

export function acceptanceChecks(ticket) {
  const acceptance = ticket.match(/^## Acceptance\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1]
  if (!acceptance) throw new Error("Ticket has no Acceptance section")
  const result = new Set()
  const range = /\b(C-(?:J\d+|UI|REL)-)(\d{2})(?:\s+to\s+(?:\1)?(C-(?:J\d+|UI|REL)-)?(\d{2}))?/g
  for (const match of acceptance.matchAll(range)) {
    const [, prefix, first, endPrefix, last] = match
    if (endPrefix && endPrefix !== prefix) throw new Error("Acceptance range crosses check families")
    const start = Number(first)
    const end = last ? Number(last) : start
    if (end < start || end - start > 50) throw new Error("Invalid Acceptance range")
    for (let number = start; number <= end; number++) result.add(`${prefix}${String(number).padStart(2, "0")}`)
  }
  if (!result.size) throw new Error("Ticket Acceptance names no checks")
  return [...result].sort()
}

export async function validateDefinitions({ root = ROOT, definitions = journeys } = {}) {
  const acceptanceIds = acceptanceChecks(await readFile(join(root, ".specs/engineering/tickets/T-REL-02.md"), "utf8"))
  const checkIds = new Set()
  const stepIds = new Set()
  const journeyIds = new Set()
  for (const definition of definitions) {
    if (!journeys.some((item) => item.id === definition.id) || journeyIds.has(definition.id)) throw new Error("Invalid or duplicate journey definition")
    journeyIds.add(definition.id)
    if (!definition.steps?.length) throw new Error(`Missing steps for ${definition.id}`)
    for (const step of definition.steps) {
      if (!step.id?.startsWith(`${definition.id}.`) || stepIds.has(step.id)) throw new Error("Invalid or duplicate step ID")
      stepIds.add(step.id)
      if (!["browser", "evidence"].includes(step.kind) || !step.procedure?.length || step.procedure.some((text) => typeof text !== "string" || !text.trim())) throw new Error(`Incomplete step ${step.id}`)
      for (const id of checksOf(step)) {
        if (!CHECK_ID.test(id)) throw new Error(`Invalid check ID ${id}`)
        checkIds.add(id)
      }
    }
  }
  for (const id of acceptanceIds) if (!checkIds.has(id)) throw new Error(`Acceptance coverage missing ${id}`)
  for (const id of checkIds) {
    const source = await readFile(join(root, ".specs/engineering/checks", `${id}.md`), "utf8")
    if (!source.startsWith(`# ${id} `)) throw new Error(`Check file identity mismatch: ${id}`)
    for (const heading of ["Setup", "Steps", "Pass when", "Fail when", "Evidence"]) if (!source.includes(`## ${heading}`)) throw new Error(`${id} lacks ${heading}`)
  }
  return { checkIds: [...checkIds].sort(), acceptanceIds }
}

export function assertLiveModels(config) {
  let models = 0
  const forbidden = /(?:scripted|fixture|mock|fake|replay|deterministic|canned)/i
  const visit = (value, key = "", parents = "") => {
    const path = `${parents}.${key}`
    if (forbidden.test(key) && value !== false && value !== null && value !== undefined) throw new Error("Scripted or fixture model configured; real journeys require live models")
    if (Array.isArray(value)) { value.forEach((item) => visit(item, key, path)); return }
    if (value && typeof value === "object") { for (const [name, item] of Object.entries(value)) visit(item, name, path); return }
    if (typeof value === "string" && (/(?:model|provider|endpoint|base.?url|adapter|transport|protocol|mode|driver|backend)/i.test(key) || /(?:models?|providers?|routing|seats?)/i.test(parents) && /^(?:id|name|type)$/i.test(key))) {
      if (forbidden.test(value)) throw new Error("Scripted or fixture model configured; real journeys require live models")
      if (value.trim() && /^model(?:_?id|Name)?$/i.test(key)) models++
    }
  }
  visit(config)
  if (!models) throw new Error("Live model configuration is absent or unrecognizable; refusing the run")
  return config
}

export function verifyInstallRepository(install, expected) {
  assertCanaryRepository(expected)
  const value = install?.repository ?? install?.repo
  const repository = typeof value === "string" ? value : value?.full_name ?? value?.fullName ??
    (value?.name && (typeof value.owner === "string" ? value.owner : value.owner?.login) ? `${typeof value.owner === "string" ? value.owner : value.owner.login}/${value.name}` : undefined)
  assertCanaryRepository(repository)
  if (repository !== expected) throw new Error("The install wraps a different canary repository")
  return repository
}

export function formatSchedule(schedule, validation, origin) {
  return [
    `PLANNED ONLY — ${schedule.length} journey/theme runs; ${validation.acceptanceIds.length} Acceptance checks; ${validation.checkIds.length} check files validated.`,
    `Origin: ${origin ?? "required for a live run (owner's Settings address)"}`,
    "Prerequisites: released tap, erased reference Mac mini, second Mac, canary org/template, three distinct GitHub tokens, live model configuration, 24 h credential-soak receipts.",
    ...schedule.flatMap((item) => [`${item.journey} ${item.theme} [Chromium + WebKit] ${item.title}`,
      ...item.steps.map((step) => `  ${step.id} → ${checksOf(step).join(", ")} [${step.kind}] ${step.procedure.join(" ")}`)]),
    "No journey checks executed; no pass/fail evidence created."
  ].join("\n") + "\n"
}

async function modelPreflight(config, origin, log, { fetchImpl = fetch, env = process.env } = {}) {
  const paths = config.modelConfigPaths
  if (!Array.isArray(paths) || !paths.length) throw new Error("JOURNEY_CONFIG must name read-only modelConfigPaths covering all configured model roles, routing and repository overrides")
  const models = []
  for (const path of paths) {
    const url = new URL(path, origin)
    if (url.origin !== origin || !url.pathname.startsWith("/api/") || url.username || url.password || url.search || url.hash) throw new Error("Model configuration probe must be an API path on the recorded install origin")
    const response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${required(env.JOURNEY_INSTALL_TOKEN, "JOURNEY_INSTALL_TOKEN")}` } })
    if (!response.ok) throw new Error(`Cannot inspect the install's model configuration: HTTP ${response.status}`)
    models.push(await response.json())
  }
  assertLiveModels(models)
  const installUrl = new URL(config.installStatePath ?? "/api/install", origin)
  if (installUrl.origin !== origin || !installUrl.pathname.startsWith("/api/") || installUrl.username || installUrl.password || installUrl.search || installUrl.hash) throw new Error("Install state probe must stay on the recorded origin")
  const install = await fetchImpl(installUrl, { redirect: "error", signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${env.JOURNEY_INSTALL_TOKEN}` } })
  if (!install.ok) throw new Error(`Cannot verify the install's canary repository: HTTP ${install.status}`)
  verifyInstallRepository(await install.json(), config.repository)
  await log({ event: "models.live", paths, digest: createHash("sha256").update(JSON.stringify(models)).digest("hex") })
}

async function existingEvidence(config, step, directories, log) {
  const files = config.evidence?.[step.id]
  if (!Array.isArray(files) || !files.length) throw new Error(`No external receipts for ${step.id}; cannot pass from an acknowledgment`)
  const result = []
  for (const [index, file] of files.entries()) {
    if (typeof file !== "string" || !(await stat(file)).isFile() || !(await stat(file)).size) throw new Error(`Missing evidence for ${step.id}`)
    for (const directory of directories) {
      const path = join(directory, `receipt-${index}-${file.split("/").at(-1)}`)
      await copyFile(file, path)
      result.push(path)
    }
  }
  await log({ event: "evidence.receipts", step: step.id, paths: result })
  return result
}

// Dependencies are a programmatic unit-test boundary, never a CLI option.
// Injected runs can only write isolated unit artifacts and cannot certify a check.
export async function liveRun(options, schedule, deps = {}) {
  const unit = Object.keys(deps).length > 0
  let root = ROOT
  if (unit) {
    const allowed = await realpath(join(ROOT, ".artifacts/journey-unit"))
    root = await realpath(required(deps.root, "unit artifact root"))
    const path = relative(allowed, root)
    if (!path || path.startsWith("..") || isAbsolute(path) || !(await stat(root)).isDirectory()) throw new Error("Injected runs require an isolated directory under .artifacts/journey-unit")
  }
  const env = deps.env ?? process.env
  const runtime = deps.runtime ?? { platform: process.platform, arch: process.arch, isTTY: process.stdin.isTTY }
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? (() => new Date())
  const output = deps.output ?? ((text) => process.stdout.write(text))
  const preflight = (log) => modelPreflight(config, options.origin, log, { fetchImpl, env })
  const evidenceLayer = unit ? "unit" : "recorded live journey"
  const status = (value) => unit && ["pass", "fail", "incomplete"].includes(value) ? `unit-${value}` : value
  required(options.origin, "--origin")
  // One fresh install/repository per theme. Two separate invocations also
  // keep an erased-host recording from silently reusing the light install.
  required(options.theme, "--theme for a live run; run both themes on fresh installs")
  if (!THEMES.includes(options.theme)) throw new Error("Theme must be light or dark")
  if (runtime.platform !== "darwin" || runtime.arch !== "arm64") throw new Error("Live journeys require an Apple Silicon browser Mac and reference Mac mini")
  if (!runtime.isTTY) throw new Error("Live recorded journeys require an unassisted operator at a terminal")
  const config = JSON.parse(await readFile(required(env.JOURNEY_CONFIG, "JOURNEY_CONFIG JSON file"), "utf8"))
  assertCanaryRepository(config.repository)
  if (!["chromium", "webkit"].includes(config.browser)) throw new Error("JOURNEY_CONFIG.browser must be chromium or webkit; use a fresh campaign for each browser and theme")
  if (publicOrigin(config.origin) !== options.origin) throw new Error("Origin must match the owner's configured Settings address in JOURNEY_CONFIG")
  for (const field of ["installVersion", "commit", "hostProfile", "macOSBuild", "browserMachine", "referenceHost", "quickstart"]) if (!config[field]) throw new Error(`JOURNEY_CONFIG lacks ${field}`)
  if (!config.hostRecording && !config.hostRecorder) throw new Error("JOURNEY_CONFIG lacks hostRecording or hostRecorder")
  if (config.referenceHost === config.browserMachine) throw new Error("The browser runner must be on a second Mac")
  if (config.scripted !== undefined || config.models !== undefined) assertLiveModels(config)
  for (const [key, value] of Object.entries(env)) if (/SCRIPTED|FIXTURE|MOCK_MODEL/i.test(key) && value && value !== "0" && value !== "false") throw new Error("Scripted model environment configured")
  // Validate all three tokens before the first network request or GitHub write.
  for (const actor of ["OWNER", "BEN", "ALICE"]) required(env[`JOURNEY_${actor}_TOKEN`], `JOURNEY_${actor}_TOKEN`)
  if (!schedule.length || schedule.some((item) => item.theme !== options.theme || !item.steps.length)) throw new Error("Live schedule must contain steps for the requested theme")
  for (const item of schedule) for (const step of item.steps) {
    if (!/^J\d+\.[a-zA-Z0-9-]+$/.test(step.id) || checksOf(step).some((id) => !CHECK_ID.test(id))) throw new Error("Invalid live step or check identity")
  }
  const expectedSteps = new Map()
  for (const item of schedule) for (const step of item.steps) for (const id of checksOf(step)) expectedSteps.set(id, (expectedSteps.get(id) ?? 0) + 1)
  const stamp = new Date(now()).toISOString()
  const firstCheck = schedule[0].steps[0].check
  const runDirectory = join(root, ".artifacts/checks", firstCheck, stamp, options.theme, "run")
  const appendRunLog = await createStepLog(runDirectory, { now })
  const runLog = (event) => appendRunLog({ ...event, evidenceLayer })
  const summary = { timestamp: stamp, evidenceLayer, origin: options.origin, repository: config.repository, theme: options.theme,
    installVersion: config.installVersion, commit: config.commit, hostProfile: config.hostProfile,
    macOSBuild: config.macOSBuild, referenceHost: config.referenceHost, browserMachine: config.browserMachine, browser: config.browser,
    checks: Object.fromEntries(schedule.flatMap((item) => item.steps.flatMap(checksOf)).map((id) => [id, { status: "not-run", steps: [] }])) }
  await writeFile(join(runDirectory, "run.json"), JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 })
  let terminal
  let recording
  let hostRecording
  let fatal
  const browserStates = { ...config.storageState }
  try {
    if (!config.freshInstall) await preflight(runLog)
    else {
      if (schedule[0].journey !== "J1") throw new Error("A fresh install starts with J1")
      // An existing install cannot use freshInstall to bypass the model guard.
      let reachable = false
      try { await fetchImpl(new URL("/readyz", options.origin), { redirect: "error", signal: AbortSignal.timeout(5_000) }); reachable = true } catch (error) {
        if (error.name === "TimeoutError") throw new Error("Fresh-host readiness probe timed out; state is unknown")
      }
      if (reachable) throw new Error("Fresh install already responds; erase it before J1")
    }
    const actors = await (deps.githubActors ?? githubActors)({ repository: config.repository, log: runLog, verifyAccess: false, env, fetchImpl })
    await (deps.ensureCanaryRepository ?? ensureCanaryRepository)({ repository: config.repository, log: runLog, token: env.JOURNEY_OWNER_TOKEN, fetchImpl })
    await actors.verifyAccess()
    terminal = (deps.createTerminal ?? (() => createInterface({ input: process.stdin, output: process.stdout })))()
    if (config.hostRecorder) hostRecording = await (deps.startRemoteMacRecording ?? startRemoteMacRecording)({ ...config.hostRecorder, path: join(runDirectory, "reference-host.mov"), log: runLog })
    recording = await (deps.startMacRecording ?? startMacRecording)({ path: join(runDirectory, "browser-mac.mov"), log: runLog })
    const playwright = deps.browserTypes ?? await import("playwright")
    const browserType = playwright[config.browser]
    for (const item of schedule) {
      for (const step of item.steps) {
        const directories = await Promise.all(checksOf(step).map(async (id) => {
          const directory = join(root, ".artifacts/checks", id, stamp, item.theme, step.id)
          await mkdir(directory, { recursive: true })
          return directory
        }))
        const directory = directories[0]
        const stepLogs = await Promise.all(directories.map((output) => createStepLog(output, { now })))
        const log = async (event) => {
          const entry = { journey: item.journey, theme: item.theme, step: step.id, checks: checksOf(step), origin: options.origin, ...event, evidenceLayer }
          await runLog(entry)
          for (const output of stepLogs) await output(entry)
        }
        const source = (await Promise.all(checksOf(step).map((id) => readFile(join(ROOT, ".specs/engineering/checks", `${id}.md`), "utf8")))).join("\n\n")
        await Promise.all(directories.map((output) => writeFile(join(output, "criteria.md"), source)))
        await log({ event: "step.started" })
        output(`\n${step.id} (${checksOf(step).join(", ")})\n${step.procedure.join("\n")}\n`)
        try {
          if (!config.freshInstall || !["J1.soak", "J1.install", "J1.setup"].includes(step.id)) await preflight(log)
          if (step.kind === "browser") {
            const capturedActors = []
            try {
              for (const actor of ["owner", "ben", "alice"]) {
                const captured = await (deps.startBrowserStep ?? startBrowserStep)({ browserType, directory: join(directory, config.browser, actor), origin: options.origin, theme: item.theme, storageState: browserStates[actor], navigate: step.id !== "J1.install", log })
                capturedActors.push({ actor, captured })
              }
              if (step.id === "J1.setup") {
                await terminal.question("Complete Address, GitHub App, owner claim and model access only. Press Enter BEFORE the first model call or Source-ready question: ")
                await preflight(log)
              }
              await terminal.question(`${config.browser}: perform the step in the independent owner/Ben/Alice windows. Tab through every touched card. Press Enter when ready for teammate actions: `)
              for (const action of config.actions?.[step.id] ?? []) {
                if (!step.actorActions?.includes(action.action)) throw new Error(`Undeclared GitHub actor action at ${step.id}`)
                await terminal.question(`Press Enter to run ${action.actor}.${action.action}: `)
                await actors[action.action](action.actor, action.input)
              }
              if (step.operation === "outside-save") await (deps.outsideSave ?? outsideSave)({ ...config.outsideSave, evidenceDirectory: directory, log, beforeSave: async (kind) => {
                const answer = await terminal.question(`${kind}: owner only outside session, no agent active, both typists ready. Type SAVE: `)
                if (answer !== "SAVE") throw new Error("Outside save cancelled")
              } })
              if (step.operation === "restart") {
                const answer = await terminal.question("Working TODO mid-step, reference backend PID verified, recording active. Type RESTART: ")
                if (answer !== "RESTART") throw new Error("Restart cancelled")
                await (deps.restartBackend ?? restartBackend)({ ...config.restart, log })
                await terminal.question("Wait for launchd recovery, then export the no-completed-step-re-run receipt. Press Enter after recovery: ")
              }
              if (step.operation === "duplicate-launch") {
                await terminal.question("Press Enter to submit the configured canary command twice with one Idempotency-Key: ")
                await (deps.duplicateLaunch ?? duplicateLaunch)({ ...config.duplicateLaunch, origin: options.origin, token: env.JOURNEY_INSTALL_TOKEN, log })
              }
              const verdict = await terminal.question(`${config.browser}: verify every live Pass when and Fail when in ${directory}/criteria.md. Type PASS or FAIL with a reason: `)
              const receipt = { event: "step.verified", browser: config.browser, verdict, verifier: unit ? "unit boundary" : "unassisted operator", layer: evidenceLayer }
              if (verdict !== "PASS") throw new Error(verdict || "No observed verdict")
              await log(receipt)
            } catch (error) { fatal = error; throw error } finally {
              const closed = await Promise.allSettled(capturedActors.map(async ({ actor, captured }) => {
                const artifacts = await captured.stop()
                browserStates[actor] = artifacts.storageState
              }))
              const failed = closed.filter((result) => result.status === "rejected").map((result) => result.reason)
              if (failed.length) throw new AggregateError([...(fatal ? [fatal] : []), ...failed], "Browser step cleanup failed", { cause: fatal ?? failed[0] })
            }
          }
          await existingEvidence(config, step, directories, log)
          if (step.check === "C-REL-05") {
            const soak = JSON.parse(await readFile(required(config.credentialSoak, "credentialSoak JSON receipt"), "utf8"))
            await log({ event: "soak.verified", ...verifyCredentialSoak(soak, config) })
            await copyFile(config.credentialSoak, join(directory, "credential-soak.json"))
          }
          if (step.check === "C-J1-04") {
            const pr = config.activation?.pr
            if (!Number.isSafeInteger(pr) || pr < 1) throw new Error("Activation requires a canary PR number")
            const api = (deps.githubApi ?? githubApi)({ token: env.JOURNEY_OWNER_TOKEN, log, fetchImpl })
            const pull = await api("GET", `/repos/${config.repository}/pulls/${pr}`)
            if (pull.head?.repo?.full_name !== config.repository || pull.base?.repo?.full_name !== config.repository) throw new Error("Activation PR must belong to the canary repository")
            const activation = verifyActivation(config.activation, pull)
            await writeFile(join(directory, "activation.json"), JSON.stringify(activation, null, 2) + "\n")
            await log({ event: "activation.verified", ...activation })
          }
          if (step.id === "J1.setup") { await preflight(log); config.freshInstall = false }
          for (const id of checksOf(step)) {
            const check = summary.checks[id]
            check.steps.push({ step: step.id, evidence: directories, status: status("pass") })
            check.status = status(check.steps.length === expectedSteps.get(id) ? "pass" : "incomplete")
          }
          await log({ event: "step.completed", status: status("pass") })
        } catch (error) {
          for (const id of checksOf(step)) {
            const check = summary.checks[id]
            Object.assign(check, { status: status("fail"), step: step.id, reason: error.message, evidence: directories })
            check.steps.push({ step: step.id, evidence: directories, status: status("fail") })
          }
          await log({ event: "step.completed", status: status("fail"), reason: error.message })
          throw error
        }
      }
    }
  } catch (error) { fatal = error } finally {
    const cleanupErrors = []
    try { terminal?.close() } catch (error) { cleanupErrors.push(error) }
    const recordings = await Promise.allSettled([hostRecording, recording].filter(Boolean).map((recorder) => Promise.resolve().then(() => recorder.stop())))
    for (const result of recordings) if (result.status === "rejected") cleanupErrors.push(result.reason)
    if (!hostRecording && config.hostRecording) {
      try {
        if (!(await stat(config.hostRecording)).isFile() || !(await stat(config.hostRecording)).size) throw new Error("Reference host screen recording is missing")
        await copyFile(config.hostRecording, join(runDirectory, "reference-host.mov"))
      } catch (error) { cleanupErrors.push(error) }
    }
    if (cleanupErrors.length) {
      for (const result of Object.values(summary.checks)) if (result.steps.length && result.status !== status("fail")) {
        result.status = status("fail")
        result.reason = "Run recording or cleanup failed"
        for (const step of result.steps) {
          step.status = status("fail")
          step.reason = result.reason
        }
      }
      fatal = new AggregateError([...(fatal ? [fatal] : []), ...cleanupErrors], "Run recording or cleanup failed", { cause: fatal ?? cleanupErrors[0] })
    }
    summary.status = fatal ? "failed" : "complete"
    if (fatal) {
      summary.reason = fatal.message
      summary.errors = (fatal.errors ?? [fatal]).map((error) => error.message)
    }
    summary.finishedAt = new Date(now()).toISOString()
    summary.hostRecording = join(runDirectory, "reference-host.mov")
    summary.browserRecording = recording?.path
    await runLog({ event: "run.completed", status: summary.status, reason: summary.reason })
    await writeFile(join(runDirectory, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 })
    for (const result of Object.values(summary.checks)) {
      for (const step of result.steps ?? []) for (const directory of step.evidence) await writeFile(join(directory, "recordings.json"), JSON.stringify({ evidenceLayer, origin: options.origin, browser: config.browser, theme: options.theme, summary: join(runDirectory, "summary.json"), host: summary.hostRecording, browserMac: summary.browserRecording, step: step.step }, null, 2) + "\n")
    }
    output(`Evidence: ${runDirectory}/summary.json\n`)
  }
  if (fatal) throw fatal
  return summary
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) { process.stdout.write("run.mjs [--theme light|dark] [--journey J1..J8|J10|J11] [--origin <url>] [--dry-run]\n"); return }
  const validation = await validateDefinitions()
  const schedule = buildSchedule(options)
  if (options.dryRun) { process.stdout.write(formatSchedule(schedule, validation, options.origin)); return }
  await liveRun(options, schedule)
}

if (isMain(import.meta.url)) await cli(main)
