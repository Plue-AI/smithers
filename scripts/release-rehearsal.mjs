/**
 * Re-executes .github/workflows/release.yml locally without publishing.
 *
 * npm versions are immutable, so the release workflow cannot be proven by
 * running it for real. This driver reads the workflow file and executes the
 * `run:` bodies of a job in order, with the same environment expressions the
 * runner would resolve, so the rehearsal exercises the workflow's own text
 * rather than a hand-copied transcript of it. Steps that are GitHub actions
 * (`uses:`) have no local equivalent and are reported as skipped along with
 * what satisfies them on this machine.
 *
 * The publish step carries `if: env.DRY_RUN != 'true'`. A rehearsal sets
 * DRY_RUN to true through the same expression the dispatched workflow uses, so
 * publication is skipped by the workflow's own condition, not by this driver.
 *
 * Existing `.jj` colocation skips repository initialization automatically.
 *
 * usage:
 *   node scripts/release-rehearsal.mjs --tag v1.0.0-rc.0 [options]
 *
 *   --tag <v...>        release tag to rehearse (default: v1.0.0-rc.0)
 *   --workflow <path>   workflow file (default: .github/workflows/release.yml)
 *   --job <id>          job to execute (default: publish)
 *   --publish           rehearse the publishing path; refuses unless
 *                       SMTHRS_ALLOW_PUBLISH=1 is also set
 *   --only <name>       run only steps whose name contains <name> (repeatable)
 *   --skip <name>       skip a step whose name contains <name> (repeatable)
 *   --node <spec>       pin a Node toolchain bin directory the way setup-node
 *                       would: `<version>=<dir>` puts <dir> on PATH when a
 *                       setup-node step asks for <version>, and a bare <dir>
 *                       applies until the first pinned switch (repeatable)
 *   --runner-temp <dir> reuse this directory as runner.temp, so a targeted run
 *                       can read the artifacts an earlier run produced
 *   --keep-going        run every remaining step after a failure instead of
 *                       stopping the way a GitHub job would
 *   --transcript <path> write a JSON transcript here
 *   --log <path>        write the combined step output here
 */
import { spawn } from "node:child_process"
import { appendFileSync, createWriteStream, existsSync, readFileSync, writeFileSync } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import YAML from "yaml"
import { isMain, repoRoot } from "./workspace-packages.mjs"

// ---------------------------------------------------------------------------
// Workflow files are read by the same YAML 1.2 rules GitHub applies, through
// the `yaml` package pinned as an exact root devDependency, so folded blocks,
// quoted escapes and flow collections mean here what they mean on the runner.
// ---------------------------------------------------------------------------

/**
 * Parses a workflow file into plain JavaScript values and checks the shape the
 * driver relies on: a top-level mapping whose `jobs` are mappings with `steps`
 * lists of mappings. Malformed YAML, including duplicate keys, is refused.
 */
export const parseWorkflow = (source) => {
  let workflow
  try {
    workflow = YAML.parse(source)
  } catch (error) {
    throw new Error(`invalid workflow YAML: ${error.message}`, { cause: error })
  }
  const isMapping = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
  if (!isMapping(workflow)) throw new Error("invalid workflow: the document must be a mapping")
  if (workflow.jobs !== undefined) {
    if (!isMapping(workflow.jobs)) throw new Error("invalid workflow: jobs must be a mapping")
    for (const [id, job] of Object.entries(workflow.jobs)) {
      if (!isMapping(job)) throw new Error(`invalid workflow: job ${id} must be a mapping`)
      if (job.steps !== undefined && !(Array.isArray(job.steps) && job.steps.every(isMapping))) {
        throw new Error(`invalid workflow: job ${id} steps must be a list of mappings`)
      }
    }
  }
  return workflow
}

// ---------------------------------------------------------------------------
// The GitHub expression subset the release workflow uses: context lookups,
// single-quoted strings, `==`, `!=`, `!`, `&&`, `||`, and parentheses.
// ---------------------------------------------------------------------------

const tokenize = (source) => {
  const tokens = []
  let index = 0
  while (index < source.length) {
    const character = source[index]
    if (/\s/.test(character)) {
      index += 1
      continue
    }
    if (character === "'") {
      let value = ""
      index += 1
      while (index < source.length) {
        if (source[index] === "'") {
          if (source[index + 1] === "'") {
            value += "'"
            index += 2
            continue
          }
          index += 1
          break
        }
        value += source[index]
        index += 1
      }
      tokens.push({ type: "string", value })
      continue
    }
    const operator = ["==", "!=", "&&", "||"].find((candidate) => source.startsWith(candidate, index))
    if (operator !== undefined) {
      tokens.push({ type: "operator", value: operator })
      index += operator.length
      continue
    }
    if (character === "(" || character === ")" || character === "!") {
      tokens.push({ type: "operator", value: character })
      index += 1
      continue
    }
    const path = /^[A-Za-z_][\w.*-]*/.exec(source.slice(index))
    if (path === null) throw new Error(`unsupported expression syntax at: ${source.slice(index)}`)
    tokens.push({ type: "path", value: path[0] })
    index += path[0].length
  }
  return tokens
}

const truthy = (value) => value !== false && value !== 0 && value !== "" && value !== null && value !== undefined

const looseEquals = (left, right) => {
  const normalize = (value) => (value === null || value === undefined ? "" : value)
  const [a, b] = [normalize(left), normalize(right)]
  if (typeof a === "boolean" || typeof b === "boolean") return truthy(a) === truthy(b)
  return String(a) === String(b)
}

const lookup = (path, contexts) =>
  path.split(".").reduce(
    (value, segment) => (value === null || value === undefined ? undefined : value[segment]),
    contexts
  )

const parseExpression = (tokens, state, contexts) => {
  const parsePrimary = () => {
    const token = tokens[state.index]
    if (token === undefined) throw new Error("unexpected end of expression")
    state.index += 1
    if (token.value === "(") {
      const value = parseOr()
      if (tokens[state.index]?.value !== ")") throw new Error("unbalanced parentheses in expression")
      state.index += 1
      return value
    }
    if (token.value === "!") return !truthy(parsePrimary())
    if (token.type === "string") return token.value
    if (token.value === "always" && tokens[state.index]?.value === "(" && tokens[state.index + 1]?.value === ")") {
      state.index += 2
      return true
    }
    // A rehearsal that is interrupted stops outright; it never evaluates a
    // condition while cancelled.
    if (token.value === "cancelled" && tokens[state.index]?.value === "(" && tokens[state.index + 1]?.value === ")") {
      state.index += 2
      return false
    }
    if (token.value === "true") return true
    if (token.value === "false") return false
    if (token.value === "null") return null
    return lookup(token.value, contexts)
  }
  const parseComparison = () => {
    let value = parsePrimary()
    while (tokens[state.index]?.value === "==" || tokens[state.index]?.value === "!=") {
      const operator = tokens[state.index].value
      state.index += 1
      const right = parsePrimary()
      value = operator === "==" ? looseEquals(value, right) : !looseEquals(value, right)
    }
    return value
  }
  const parseAnd = () => {
    let value = parseComparison()
    while (tokens[state.index]?.value === "&&") {
      state.index += 1
      const right = parseComparison()
      value = truthy(value) ? right : value
    }
    return value
  }
  const parseOr = () => {
    let value = parseAnd()
    while (tokens[state.index]?.value === "||") {
      state.index += 1
      const right = parseAnd()
      value = truthy(value) ? value : right
    }
    return value
  }
  return parseOr()
}

/**
 * Evaluates one GitHub expression against the supplied contexts.
 */
export const evaluateExpression = (source, contexts) => {
  const tokens = tokenize(source)
  const state = { index: 0 }
  const value = parseExpression(tokens, state, contexts)
  if (state.index !== tokens.length) throw new Error(`unsupported expression: ${source}`)
  return value
}

const render = (value) => {
  if (value === null || value === undefined) return ""
  return String(value)
}

/**
 * Substitutes every `${{ … }}` in a scalar, the way the runner does before it
 * hands a value to a step.
 */
export const interpolate = (value, contexts) => {
  if (typeof value !== "string") return render(value)
  return value.replaceAll(
    /\$\{\{(.+?)\}\}/g,
    (_, expression) => render(evaluateExpression(expression.trim(), contexts))
  )
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * What satisfies a `uses:` step on a developer machine. A step whose action is
 * not listed here stops the rehearsal instead of being silently ignored.
 */
export const localEquivalents = {
  "actions/upload-artifact": "the candidate tarballs and manifests remain in the declared local pack directory",
  "actions/checkout": "this checkout is the tree under test",
  "docker://rhysd/actionlint": "the installed actionlint binary validates workflow syntax",
  "pnpm/action-setup": "pnpm on PATH",
  "actions/setup-node": "the Node toolchain bin directory pinned by --node <version>=<dir>",
  "oven-sh/setup-bun": "bun on PATH",
  "actions/setup-go": "the Go toolchain already installed on PATH",
  "Swatinem/rust-cache": "the local Cargo cache remains available",
  "foundry-rs/foundry-toolchain": "forge and anvil already installed on PATH",
  "taiki-e/install-action": "the tool already installed on PATH"
}

const localEquivalent = (uses) => {
  const action = uses.split("@")[0]
  const equivalent = localEquivalents[action]
  if (equivalent === undefined) {
    throw new Error(`no documented local equivalent for the action ${uses}`)
  }
  return equivalent
}

const runStep = (body, env, log) =>
  new Promise((resolveRun) => {
    const started = Date.now()
    const child = spawn("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", body], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    })
    const relay = (stream) => {
      stream.setEncoding("utf8")
      stream.on("data", (chunk) => {
        process.stdout.write(chunk)
        log.write(chunk)
      })
    }
    relay(child.stdout)
    relay(child.stderr)
    child.once("error", (error) => {
      log.write(`${error.message}\n`)
      resolveRun({ exitCode: 127, durationMs: Date.now() - started })
    })
    child.once("exit", (code, signal) => {
      resolveRun({ exitCode: code ?? `signal:${signal}`, durationMs: Date.now() - started })
    })
  })

const parseArguments = (argv) => {
  const options = {
    tag: "v1.0.0-rc.0",
    workflow: ".github/workflows/release.yml",
    job: "publish",
    publish: false,
    keepGoing: false,
    only: [],
    skip: [],
    runnerTemp: undefined,
    transcript: undefined,
    log: undefined,
    node: { fallback: undefined, byVersion: new Map() }
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const next = () => {
      index += 1
      if (argv[index] === undefined) throw new Error(`${argument} needs a value`)
      return argv[index]
    }
    switch (argument) {
      case "--tag":
        options.tag = next()
        break
      case "--workflow":
        options.workflow = next()
        break
      case "--job":
        options.job = next()
        break
      case "--only":
        options.only.push(next())
        break
      case "--skip":
        options.skip.push(next())
        break
      case "--runner-temp":
        options.runnerTemp = next()
        break
      case "--transcript":
        options.transcript = next()
        break
      case "--log":
        options.log = next()
        break
      case "--node": {
        const spec = next()
        const separator = spec.indexOf("=")
        if (separator === -1) options.node.fallback = spec
        else options.node.byVersion.set(spec.slice(0, separator), spec.slice(separator + 1))
        break
      }
      case "--publish":
        options.publish = true
        break
      case "--keep-going":
        options.keepGoing = true
        break
      default:
        throw new Error(`unknown option ${argument}`)
    }
  }
  return options
}

/**
 * The contexts a rehearsal evaluates the workflow's expressions against.
 *
 * A rehearsal is a dispatched dry run of one tag and is always a first
 * attempt: the workflow's re-run guard reads `github.run_attempt` and must
 * stay silent here.
 */
export const rehearsalContexts = ({ tag, publish = false, runnerTemp = "/tmp/runner", workflowName = "Release" }) => ({
  github: { event_name: "workflow_dispatch", ref_name: tag, run_attempt: "1", workflow: workflowName },
  inputs: { releaseTag: tag, dryRun: !publish },
  runner: { temp: runnerTemp },
  env: {},
  steps: {}
})

export const main = async (argv) => {
  const options = parseArguments(argv)
  if (options.publish && process.env.SMTHRS_ALLOW_PUBLISH !== "1") {
    throw new Error("--publish rehearses publication; set SMTHRS_ALLOW_PUBLISH=1 to confirm")
  }
  const workflow = parseWorkflow(readFileSync(join(repoRoot, options.workflow), "utf8"))
  const job = workflow.jobs?.[options.job]
  if (job === undefined) throw new Error(`${options.workflow} has no job ${options.job}`)

  if (options.runnerTemp !== undefined) await mkdir(resolve(options.runnerTemp), { recursive: true })
  const runnerTemp = options.runnerTemp === undefined
    ? await mkdtemp(join(tmpdir(), "smthrs-release-rehearsal-"))
    : resolve(options.runnerTemp)
  const githubEnvFile = join(runnerTemp, "github-env")
  writeFileSync(githubEnvFile, "")
  const githubPathFile = join(runnerTemp, "github-path")
  writeFileSync(githubPathFile, "")
  const logPath = resolve(options.log ?? join(runnerTemp, "rehearsal.log"))
  const log = createWriteStream(logPath, { flags: "a" })

  const contexts = rehearsalContexts({ tag: options.tag, publish: options.publish, runnerTemp, workflowName: workflow.name })
  for (const [key, value] of Object.entries(job.env ?? {})) {
    contexts.env[key] = interpolate(value, contexts)
  }

  let pathPrefix = options.node.fallback === undefined ? [] : [resolve(options.node.fallback)]
  let githubPath = []
  const results = []
  let failed = false
  for (const step of job.steps) {
    const name = step.name ?? step.uses ?? "(unnamed step)"
    const record = { name, status: "ran", exitCode: 0, durationMs: 0 }
    results.push(record)
    // `steps.<id>.conclusion` for later conditions. A step skipped because the
    // operator or this machine already provides it counts as a success; a
    // step skipped by its condition or an earlier failure does not.
    const conclude = (conclusion) => {
      if (step.id !== undefined) contexts.steps[step.id] = { conclusion, outcome: conclusion }
    }
    const announce = (status, detail) => {
      record.status = status
      const line = `\n=== ${status.toUpperCase()}: ${name}${detail === undefined ? "" : ` (${detail})`}\n`
      process.stdout.write(line)
      log.write(line)
    }
    if (options.skip.some((fragment) => name.includes(fragment))) {
      announce("skipped", "--skip")
      conclude("success")
      continue
    }
    if (options.only.length > 0 && !options.only.some((fragment) => name.includes(fragment))) {
      announce("skipped", "--only")
      conclude("success")
      continue
    }
    if (name === "Initialize colocated jj repository" && existsSync(join(repoRoot, ".jj"))) {
      announce("skipped", "repository is already colocated")
      conclude("success")
      continue
    }
    if (step.uses !== undefined) {
      if (step.uses.split("@")[0] === "actions/setup-node") {
        const version = interpolate(String(step.with?.["node-version"] ?? ""), contexts)
        const pinned = options.node.byVersion.get(version)
        if (pinned === undefined) {
          announce("skipped", `GitHub action, locally: no --node ${version}=<dir> pin; PATH keeps the current toolchain`)
        } else {
          pathPrefix = [resolve(pinned)]
          announce("skipped", `GitHub action, locally: PATH now resolves Node ${version} from ${pathPrefix[0]}`)
        }
        conclude("success")
        continue
      }
      announce("skipped", `GitHub action, locally: ${localEquivalent(step.uses)}`)
      conclude("success")
      continue
    }
    if (step.if !== undefined) {
      // A step condition is an expression whether or not it is wrapped in `${{ }}`.
      const condition = String(step.if).replaceAll(/\$\{\{|\}\}/g, "")
      if (!truthy(evaluateExpression(condition, contexts))) {
        announce("skipped", `if: ${step.if}`)
        conclude("skipped")
        continue
      }
    }
    // GitHub adds an implicit success() only to a condition that calls no
    // status function, so `always()` and `!cancelled()` steps run after a failure.
    const statusChecked = /\b(?:always|cancelled)\(\)/.test(String(step.if ?? ""))
    if (failed && !options.keepGoing && !statusChecked) {
      announce("skipped", "an earlier step failed")
      conclude("skipped")
      continue
    }
    const stepEnv = { ...process.env, ...contexts.env, GITHUB_ENV: githubEnvFile, GITHUB_PATH: githubPathFile, RUNNER_TEMP: runnerTemp }
    for (const [key, value] of Object.entries(step.env ?? {})) {
      stepEnv[key] = interpolate(value, contexts)
    }
    const prefix = [...githubPath, ...pathPrefix]
    if (prefix.length > 0) stepEnv.PATH = `${prefix.join(":")}:${stepEnv.PATH}`
    announce("running")
    const outcome = await runStep(interpolate(step.run, contexts), stepEnv, log)
    record.exitCode = outcome.exitCode
    record.durationMs = outcome.durationMs
    record.status = outcome.exitCode === 0 ? "passed" : "failed"
    conclude(outcome.exitCode === 0 ? "success" : "failure")
    if (outcome.exitCode !== 0) failed = true
    // Steps export variables to later steps by appending to $GITHUB_ENV.
    for (const line of readFileSync(githubEnvFile, "utf8").split("\n")) {
      const assignment = /^([A-Za-z_]\w*)=(.*)$/.exec(line)
      if (assignment !== null) contexts.env[assignment[1]] = assignment[2]
    }
    writeFileSync(githubEnvFile, "")
    // ...and prepend directories to PATH by appending them to $GITHUB_PATH.
    const added = readFileSync(githubPathFile, "utf8").split("\n").filter((line) => line !== "")
    githubPath = [...added.reverse(), ...githubPath]
    writeFileSync(githubPathFile, "")
    const seconds = Math.round(record.durationMs / 1000)
    const summary = `--- ${record.status}: ${name} (exit ${record.exitCode}, ${seconds}s)\n`
    process.stdout.write(summary)
    log.write(summary)
  }

  const transcript = {
    workflow: options.workflow,
    job: options.job,
    tag: options.tag,
    dryRun: !options.publish,
    env: contexts.env,
    log: logPath,
    steps: results
  }
  if (options.transcript !== undefined) {
    writeFileSync(resolve(options.transcript), `${JSON.stringify(transcript, null, 2)}\n`)
  }
  appendFileSync(logPath, `\n${JSON.stringify(transcript, null, 2)}\n`)
  process.stdout.write(`\n${JSON.stringify(transcript.steps, null, 2)}\n`)
  if (options.runnerTemp === undefined && options.transcript === undefined) {
    await rm(runnerTemp, { recursive: true, force: true })
  }
  if (failed) process.exitCode = 1
}

if (isMain(import.meta)) {
  await main(process.argv.slice(2))
}
