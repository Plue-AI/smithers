import { parse } from "yaml"

/**
 * The release-validation inventory: every build-graph gate a release candidate
 * must pass before `build-release.mjs` and `pack-release.mjs` run.
 *
 * Two release paths consume it. The root release flow
 * (`flows/release-support/operations.ts`) runs each entry, in order, as its
 * `checks` step. The hand-written `.github/workflows/release.yml` cannot import
 * it, so `release-gates.test.mjs` proves parity in both directions: every
 * entry here is a publish-job step with the same name and command, and every
 * `pnpm exec smthrs` step in the publish job is either an entry here or a
 * declared {@link releaseGateExceptions} entry. Before the second direction
 * existed the inventory held 12 gates, only 10 mirrored, for 35 workflow
 * gates, and the flow-driven release required substantially less evidence.
 *
 * Ordinary `ci '//packages/...'` deliberately excludes the `faults` tier, so
 * that selection is spelled out here with the same serial `--jobs 1` the
 * workflow uses: the fault suites hold exclusive resources and cannot share a
 * machine.
 */

/**
 * @typedef {object} ReleaseGate
 * @property {string} name The workflow step name the gate carries in release.yml, verbatim.
 * @property {"ci" | "test" | "lint" | "build"} verb The `smthrs` verb.
 * @property {string} target The build-graph selection.
 * @property {number} [jobs] An explicit `--jobs` bound; omitted for the default.
 * @property {string} [flowOnly] Why the root flow runs this gate although release.yml does not.
 * @property {readonly string[]} [ciCommands] Exact CI commands selected by this gate's recursive target. New commands require an explicit inventory decision.
 */

/**
 * @typedef {object} ReleaseGateException
 * @property {string} name The release.yml step name, verbatim.
 * @property {string} command The step's exact `pnpm exec smthrs …` line.
 * @property {string} reason The platform fact that keeps the local path from running it.
 * @property {{ platform: string; arch: string }} [requiredHost] Hosts outside this platform/architecture report the exception.
 */

/**
 * @typedef {object} ReleaseGateExclusion
 * @property {string} job The ci.yml job id.
 * @property {readonly string[]} [commands] The job's exact commands the release omits. Omission describes a whole job for drift diagnostics, but cannot discharge parity.
 * @property {string} reason Why the release does not mirror them.
 */

/**
 * The publish job of release.yml, in its order, plus the two flow-only gates.
 *
 * The first block combines required CI `test`, `repository`, `scripts`, and `docs` gates copied out
 * of the generated ci.yml; then the `apps-e2e` gates the release runs without
 * the browser suite; then the `e2e-faults` matrix and the release-only
 * targets; then the `wasm-repro` pair. `pack-release.test.mjs` proves the
 * workflow-to-workflow copy, and `release-gates.test.mjs` proves this list
 * against the workflow.
 *
 * @type {readonly ReleaseGate[]}
 */
export const releaseGates = [
  { name: "Examples", verb: "ci", target: "//examples/..." },
  { name: "Workspace targets", verb: "ci", target: "//packages/...", jobs: 2 },
  // Every NodeTest under scripts/, the release rehearsal and cut suites included.
  {
    name: "Script gates", verb: "test", target: "//scripts/...",
    // Pin today's two recursive CI coverage claims. Merely living under
    // scripts/ must not silently give a future workflow command an owner.
    ciCommands: [
      "pnpm exec smthrs test '//scripts:thirdPartyNotices' --verbose",
      "pnpm exec smthrs test '//scripts:webBundleContract' --verbose"
    ]
  },
  { name: "Repository flows", verb: "test", target: "//flows:pack" },
  { name: "Judge egress", verb: "test", target: "//flows:egress" },
  { name: "Repository flow fixtures", verb: "test", target: "//flows:repository" },
  { name: "Wiki and release fixtures", verb: "test", target: "//flows:fixtures" },
  { name: "Repository flows lint", verb: "lint", target: "//flows/..." },
  {
    name: "Root flows typecheck", verb: "ci", target: "//flows:check",
    flowOnly: "The generated ci.yml declares no job for the root flows, so release.yml mirrors none; the flow gates its own sources."
  },
  {
    name: "Root flows suite", verb: "ci", target: "//flows:suite",
    flowOnly: "The generated ci.yml declares no job for the root flows, so release.yml mirrors none; the flow gates its own sources."
  },
  { name: "Public export JSDoc", verb: "lint", target: "//:jsdocTree" },
  { name: "Script lint", verb: "lint", target: "//scripts:lint" },
  { name: "JSDoc rule harness", verb: "test", target: "//:jsdocRules" },
  { name: "Factory harness", verb: "test", target: "//:factoryHarness" },
  { name: "Agent eval suite (offline, baseline-gated)", verb: "test", target: "//evals/agent:test" },
  { name: "Agent eval typecheck", verb: "build", target: "//evals/agent:check" },
  { name: "Authoring eval dataset (offline)", verb: "test", target: "//evals/authoring:test" },
  { name: "Authoring eval typecheck", verb: "build", target: "//evals/authoring:check" },
  { name: "SWE-bench offline fixtures", verb: "test", target: "//evals/swebench:offline", jobs: 1 },
  { name: "SWE-bench rig typecheck", verb: "build", target: "//evals/swebench:check" },
  { name: "SWE-bench rig lint", verb: "lint", target: "//evals/swebench/..." },
  { name: "UI typecheck", verb: "build", target: "//apps/app:check" },
  { name: "UI unit tests", verb: "test", target: "//apps/app:unitTests" },
  { name: "UI conformance lint", verb: "test", target: "//apps/app:conformance" },
  { name: "TUI typecheck, lint and tests", verb: "ci", target: "//apps/tui/..." },
  // Exclusive, so the wildcard above omits it; the explicit label opts in.
  { name: "TUI end-to-end suite", verb: "test", target: "//apps/tui:e2eTests" },
  { name: "Server typecheck and tests", verb: "ci", target: "//apps/server/..." },
  { name: "Review app and workers", verb: "ci", target: "//apps/review/..." },
  { name: "Bug worker", verb: "ci", target: "//apps/bug-worker/..." },
  { name: "Project copy drift", verb: "lint", target: "//:projectCopy" },
  { name: "Site", verb: "ci", target: "//apps/site/..." },
  { name: "Package docs sites", verb: "ci", target: "//apps/docs/..." },
  { name: "Review eval suite (offline, baseline-gated)", verb: "test", target: "//evals/review-seeded-bugs/..." },
  { name: "Review eval typecheck", verb: "build", target: "//evals/review-seeded-bugs:check" },
  { name: "Recommend eval suite (offline, baseline-gated)", verb: "test", target: "//evals/recommend/..." },
  { name: "Recommend eval typecheck", verb: "build", target: "//evals/recommend:check" },
  { name: "Generated workflow drift", verb: "lint", target: "//:ci" },
  { name: "Factory projection drift", verb: "lint", target: "//:factoryProjection" },
  { name: "Target index drift", verb: "lint", target: "//:targetIndex" },
  { name: "Native FFI clippy and tests", verb: "build", target: "//:nativeFfi" },
  // Ordinary workspace CI omits this exclusive tier; the explicit label opts in.
  { name: "Exclusive fault matrix", verb: "test", target: "//packages/...:faults", jobs: 1 },
  // Release-only: a pinned target outside its package's `ci`.
  { name: "Disaster-recovery script test", verb: "test", target: "//packages/smithers/flows/engine-store:disasterRecovery" },
  // Release-only by name, so a rehearsal can run it alone; `//scripts/...` runs it too.
  { name: "Release version coherence", verb: "test", target: "//scripts:releaseVersion" },
  { name: "Build-script unit tests", verb: "test", target: "//crates/flows-jj:buildScript" },
  // The committed flows_jj.wasm is rebuilt and byte-compared before packing.
  { name: "Rebuild and byte-compare flows_jj.wasm", verb: "test", target: "//crates/flows-jj:wasmReproducibility" },
  { name: "Build and test shared backend", verb: "test", target: "//:backendGo" }
]

/**
 * Publish-job gates the local release path cannot run, each with the platform
 * fact that stops it. The flow never runs these; it records them in the
 * candidate's gate evidence and the approval prompt so an operator sees what
 * the tag-driven release proves that this run did not.
 *
 * The WASM build script rejects foreign Rust host triples, since their byte
 * output differs by construction. Keep it in the shared inventory and move it
 * into the local exception partition on non-Linux or non-x64 hosts. Linux x64
 * still runs the gate: its own guard verifies the GNU Rust triple, so missing
 * or incompatible tools fail instead of being excused.
 *
 * @type {readonly ReleaseGateException[]}
 */
export const releaseGateExceptions = [{
  name: "Rebuild and byte-compare flows_jj.wasm",
  command: "pnpm exec smthrs test '//crates/flows-jj:wasmReproducibility' --verbose",
  reason: "Byte equality requires the pinned x86_64-unknown-linux-gnu Rust host. build-wasm.mjs refuses foreign hosts because Cargo metadata changes the WASM bytes; the canonical release runner must prove this gate.",
  requiredHost: { platform: "linux", arch: "x64" }
}]

/**
 * Partition the shared inventory into gates this host runs and explicit
 * exceptions. Missing tools are failures, never new platform exceptions.
 *
 * @param {{ platform: string; arch: string }} [host]
 * @returns {{ inventory: readonly ReleaseGate[]; exceptions: readonly ReleaseGateException[] }}
 */
export const releaseGateSetForHost = (host = process) => {
  const exceptions = releaseGateExceptions.filter(({ requiredHost }) =>
    requiredHost && (requiredHost.platform !== host.platform || requiredHost.arch !== host.arch))
  return {
    inventory: releaseGates.filter((gate) => !exceptions.some((exception) => exception.command === releaseGateCommand(gate))),
    exceptions
  }
}

/**
 * The CI gates the release intentionally does not mirror, by job. Naming them
 * here keeps each omission a decision rather than an oversight: the drift test
 * proves each is still a ci.yml gate, that the inventory does not run it (or
 * the reason would be false), and that every other CI gate is run by an
 * inventory gate. A job with no entry is mirrored whole: `test`, `repository`, `scripts`, `docs`, `e2e-faults`
 * and `wasm-repro` step for step; `browser` through `//scripts/...`, which selects
 * `//scripts:webBundleContract`, explicitly pinned in ciCommands. Even omitted
 * jobs enumerate today's commands so future additions cannot hide behind a
 * whole-job waiver. `push` is an `on` trigger, not a job.
 *
 * @type {readonly ReleaseGateExclusion[]}
 */
export const releaseGateExclusions = [
  {
    job: "apps-e2e",
    commands: ["pnpm exec smthrs test '//apps/app:browserE2e' --verbose"],
    reason: "The Playwright suite needs the browsers the apps-e2e runner installs; the release runs the job's UI typecheck, unit tests and conformance lint."
  },
  {
    job: "rust",
    commands: ["pnpm exec smthrs lint '//crates/flows-jj/...' --verbose", "pnpm exec smthrs test '//crates/flows-jj:cargoTest' --verbose"],
    reason: "Native Rust lint and tests validate the native crate, which is not a published release artifact. The release verifies the shipped WASM with the pinned Rust toolchain instead. Third-party notices run under //scripts/...."
  },
  {
    job: "packages",
    commands: ["pnpm exec smthrs test '//packages/...' --jobs 2 --verbose"],
    reason: "test '//packages/...' repeats the Workspace targets gate's test targets on macOS and Windows; one release runner has no OS matrix, and ci '//packages/...' already runs them on Linux."
  }
]

/**
 * The `smthrs` argument vector for one gate, after `pnpm exec smthrs`.
 *
 * @param {ReleaseGate} gate
 * @returns {string[]}
 */
export const releaseGateArgs = (gate) =>
  [gate.verb, gate.target, ...(gate.jobs === undefined ? [] : ["--jobs", String(gate.jobs)]), "--verbose"]

/**
 * The gate as release.yml spells it: single-quoted target, explicit `--jobs`.
 *
 * @param {ReleaseGate} gate
 * @returns {string}
 */
export const releaseGateCommand = (gate) =>
  `pnpm exec smthrs ${gate.verb} '${gate.target}'${gate.jobs === undefined ? "" : ` --jobs ${gate.jobs}`} --verbose`

/**
 * The verb, target and `--jobs` bound of one workflow command, or undefined
 * when the line is not a `pnpm exec smthrs` gate in the workflow's spelling.
 * A `--known-red` list is accepted and dropped: it changes which red targets
 * fail the step, not which targets run. release.yml carries none.
 *
 * @param {string} command
 * @returns {{ verb: string; target: string; jobs?: number } | undefined}
 */
export const parseGateCommand = (command) => {
  const match = /^pnpm exec smthrs ([a-z]+) '([^']+)'(?: --jobs (\d+))?(?: --known-red '[^']+')? --verbose$/.exec(command)
  if (!match) return undefined
  const [, verb, target, jobs] = match
  return jobs === undefined ? { verb, target } : { verb, target, jobs: Number(jobs) }
}

/**
 * Whether a workflow command runs the gate: the same verb and either the exact
 * target, or a recursive `//dir/...` selection that contains it. A gate with an
 * explicit `--jobs` bound is covered only by a command carrying the same bound,
 * because the bound is part of what the gate promises.
 *
 * Verbs never subsume one another here. `ci` does plan the test targets under
 * its pattern, but which tiers it skips is a property of the targets, which a
 * workflow line cannot show; a claim of coverage this function cannot see is
 * left unclaimed.
 *
 * @param {string} command A `pnpm exec smthrs …` line from a workflow.
 * @param {Pick<ReleaseGate, "verb" | "target" | "jobs">} gate
 * @returns {boolean}
 */
export const commandCovers = (command, gate) => {
  const parsed = parseGateCommand(command)
  if (!parsed || parsed.verb !== gate.verb) return false
  const { target, jobs } = parsed
  if (gate.jobs !== undefined) return target === gate.target && jobs === gate.jobs
  if (jobs !== undefined) return false
  if (target === gate.target) return true
  if (!target.endsWith("/...")) return false
  const prefix = target.slice(0, -"/...".length)
  return gate.target === prefix || gate.target.startsWith(`${prefix}/`) || gate.target.startsWith(`${prefix}:`)
}

/**
 * Whether an inventory gate runs a workflow command: the gate's own command
 * covers the command's selection under {@link commandCovers}.
 *
 * @param {ReleaseGate} gate
 * @param {string} command
 * @returns {boolean}
 */
export const gateRuns = (gate, command) => {
  const parsed = parseGateCommand(command)
  return parsed !== undefined && commandCovers(releaseGateCommand(gate), parsed)
}

/** @param {string} source */
const jobsOf = (source) => {
  const jobs = parse(source)?.jobs
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) throw new Error("the workflow declares no jobs")
  return jobs
}

/**
 * The job ids a workflow declares, in order.
 *
 * @param {string} source The workflow YAML.
 * @returns {string[]}
 */
export const workflowJobs = (source) => Object.keys(jobsOf(source))

/**
 * Tokenize literal POSIX shell words, retaining the raw command for reports.
 * Quotes concatenate word fragments; backslashes escape outside single
 * quotes, with POSIX's narrower escape set inside double quotes. A comment
 * starts at an unquoted word boundary and ends at the physical newline.
 * This is deliberately not an evaluator: candidate segments containing
 * substitutions are rejected by the caller. Unsupported syntax cannot match an
 * inventory command. Incomplete quotes or escapes cannot certify coverage.
 *
 * @param {string} run
 * @returns {{ command: string; tokens: string[]; valid: boolean }[]}
 */
const shellCommands = (run) => {
  /** @type {{ command: string; tokens: string[]; valid: boolean }[]} */
  const commands = []
  /** @type {string[]} */
  let tokens = []
  let word = ""
  let active = false
  let quote = ""
  let start = 0
  let valid = true
  const finishWord = () => {
    if (active) tokens.push(word)
    word = ""
    active = false
  }
  /** @param {number} end */
  const finishCommand = (end) => {
    finishWord()
    if (tokens.length) commands.push({ command: run.slice(start, end).trim(), tokens, valid: valid && quote === "" })
    tokens = []
    valid = true
  }
  for (let i = 0; i < run.length; i++) {
    const char = run[i]
    if (quote === "'") {
      if (char === "'") quote = ""
      else word += char
      continue
    }
    if (char === "\\") {
      const next = run[i + 1]
      if (next === "\n") { i++; continue }
      if (next === "\r" && run[i + 2] === "\n") { i += 2; continue }
      active = true
      if (next === undefined) { word += char; valid = false; continue }
      if (quote === '"' && !['$', '`', '"', '\\'].includes(next)) word += char
      else { word += next; i++ }
      continue
    }
    if (quote === '"') {
      if (char === '"') quote = ""
      else word += char
      continue
    }
    if (char === "'" || char === '"') { quote = char; active = true; continue }
    if (char === "#" && !active) {
      finishCommand(i)
      while (i < run.length && run[i] !== "\n") i++
      start = i + 1
      continue
    }
    if (char === "\n" || char === ";" || char === "|" || (char === "&" && run[i + 1] === "&")) {
      finishCommand(i)
      if (char === "&") i++
      start = i + 1
      continue
    }
    if (char === " " || char === "\t" || char === "\r") { finishWord(); continue }
    active = true
    word += char
  }
  finishCommand(run.length)
  return commands
}

/**
 * @typedef {{ name: string; command: string; tokens: string[]; valid: boolean }} WorkflowGate
 */

const wrappers = new Set(["env", "time", "nice", "xargs", "sudo", "bash", "sh", "zsh", "eval", "exec"])

/** @param {string} token */
const isGateToken = (token) => /^(\.\/|\/)?(.*\/)?(smthrs|smithers-build)$/.test(token)

/**
 * A binary word or path is a candidate wherever it appears in the segment.
 * Only wrappers interpret their arguments as further shell commands; a node
 * expression or package name containing the binary's name is ordinary data.
 *
 * @param {string[]} tokens
 * @returns {boolean}
 */
const isGateCandidate = (tokens) => tokens.some(isGateToken) ||
  (wrappers.has(tokens[0]) && tokens.slice(1).some((argument) =>
    shellCommands(argument).some((command) => isGateCandidate(command.tokens))))

/** @param {string} token */
const assignmentOf = (token) => /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(token)

/**
 * Find expansion in the executable position, including pnpm exec and shell
 * wrappers. Expansions in ordinary arguments do not turn metadata into gates.
 * This only applies when the same block assigns a gate-bearing variable.
 *
 * @param {string[]} tokens
 * @returns {boolean}
 */
const hasIndirectExecutable = (tokens) => {
  let i = 0
  while (tokens[i] !== undefined && assignmentOf(tokens[i])) i++
  const executable = tokens[i]
  if (executable === undefined) return false
  if (/[$`]/.test(executable)) return true
  if (executable === "pnpm" && tokens[i + 1] === "exec") return hasIndirectExecutable(tokens.slice(i + 2))
  if (!wrappers.has(executable)) return false
  const args = tokens.slice(i + 1)
  if (executable === "eval") return shellCommands(args.join(" ")).some((command) => hasIndirectExecutable(command.tokens))
  if (["bash", "sh", "zsh"].includes(executable)) {
    const at = args.findIndex((arg) => /^-[^-]*c/.test(arg))
    return at !== -1 && shellCommands(args[at + 1] ?? "").some((command) => hasIndirectExecutable(command.tokens))
  }
  // These wrapper options consume a value before the executable. Unknown
  // syntax still cannot acquire canonical ownership through token matching.
  const valueOptions = {
    env: ["-u", "--unset", "-C", "--chdir"],
    time: ["-f", "--format", "-o", "--output"],
    nice: ["-n", "--adjustment"],
    xargs: ["-I", "-L", "-n", "-P", "-s", "-E", "-d"],
    sudo: ["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-C", "-T"],
    exec: ["-a"]
  }
  let at = 0
  while (args[at]?.startsWith("-")) {
    const option = args[at++]
    if (option === "--") break
    if (valueOptions[executable]?.includes(option)) at++
  }
  return hasIndirectExecutable(args.slice(at))
}

/**
 * Discover gate candidates by segment, retaining raw text for unowned reports.
 * Comments and longer words are not candidates. Track same-block assignments
 * so an indirect executable cannot hide a gate without a literal binary word
 * in its own segment. Dynamic candidates can never prove canonical coverage.
 *
 * @param {ReturnType<typeof jobsOf>} jobs
 * @param {string} job
 * @returns {WorkflowGate[]}
 */
const discoveredJobGates = (jobs, job) => {
  if (!Object.hasOwn(jobs, job)) throw new Error(`${job} is not a job in this workflow`)
  return (jobs[job].steps ?? []).flatMap((step) => {
    if (typeof step.run !== "string") return []
    const commands = shellCommands(step.run)
    const assignedValues = []
    for (const { tokens } of commands) {
      let at = ["export", "readonly", "env"].includes(tokens[0]) ? 1 : 0
      while (tokens[at] !== undefined) {
        const assignment = assignmentOf(tokens[at++])
        if (!assignment) break
        assignedValues.push(assignment[2])
      }
    }
    const gateVariable = assignedValues.some((value) => shellCommands(value).some(({ tokens }) => isGateCandidate(tokens)))
    return commands.filter(({ tokens }) => isGateCandidate(tokens) || (gateVariable && hasIndirectExecutable(tokens)))
      .map((command) => ({
        name: step.name ?? "",
        ...command,
        command: command.command.replace(/ --known-red '[^']+'/, ""),
        tokens: withoutKnownRed(command.tokens),
        valid: command.valid && !/[$`]/.test(command.command)
      }))
  })
}

/** @param {WorkflowGate} step */
const reportedStep = ({ name, command }) => ({ name, command })

/**
 * Every possible gate in a job, in order, with its raw text. YAML parsing
 * handles block/folded scalars and unnamed steps. Ordinary node scripts/...
 * and pnpm exec scripts/... runners remain out of scope unless they contain
 * a gate token. Discovery never requires a known executable prefix or verb.
 *
 * @param {string} source The workflow YAML.
 * @param {string} job The job id.
 * @returns {{ name: string; command: string }[]}
 */
export const workflowGateSteps = (source, job) => discoveredJobGates(jobsOf(source), job).map(reportedStep)

/**
 * Compare literal token vectors to a canonical gate declaration. Wrappers,
 * extra arguments, legacy executable names and dynamic candidates never match.
 *
 * @param {WorkflowGate} step
 * @param {string} command
 */
const matchesCommand = (step, command) => {
  if (!step.valid || !parseGateCommand(command)) return false
  const [canonical] = shellCommands(command)
  return canonical.tokens.length === step.tokens.length && canonical.tokens.every((token, i) => token === step.tokens[i])
}

/**
 * A step's tokens without one `--known-red <path>` pair. The list decides
 * which red targets fail the step, not which targets it runs, so it neither
 * grants nor removes coverage of a gate; discovery reports the step without it.
 *
 * @param {readonly string[]} tokens
 */
const withoutKnownRed = (tokens) => {
  const at = tokens.indexOf("--known-red")
  return at < 0 || tokens[at + 1] === undefined ? tokens : [...tokens.slice(0, at), ...tokens.slice(at + 2)]
}

/**
 * The inventory gates release.yml's job does not run under the same name and
 * command. Flow-only gates are exempt by declaration.
 *
 * @param {readonly ReleaseGate[]} inventory
 * @param {string} source The release workflow YAML.
 * @param {string} [job]
 * @returns {ReleaseGate[]}
 */
export const inventoryGatesMissingFromWorkflow = (inventory, source, job = "publish") => {
  const steps = discoveredJobGates(jobsOf(source), job)
  return inventory.filter((gate) =>
    gate.flowOnly === undefined &&
    !steps.some((step) => step.name === gate.name && matchesCommand(step, releaseGateCommand(gate))))
}

/**
 * The gate steps release.yml's job runs without exactly one inventory or
 * exception owner, by step name and exact literal tokens. A step whose
 * command is known under another name is reported: the names are what the
 * flow's evidence and the rehearsal's `--only` selection key on.
 *
 * @param {readonly ReleaseGate[]} inventory
 * @param {string} source The release workflow YAML.
 * @param {{ job?: string; exceptions?: readonly ReleaseGateException[] }} [options]
 * @returns {{ name: string; command: string }[]}
 */
export const workflowGatesMissingFromInventory = (inventory, source, { job = "publish", exceptions = [] } = {}) =>
  discoveredJobGates(jobsOf(source), job).filter((step) =>
    inventory.filter((gate) => gate.name === step.name && matchesCommand(step, releaseGateCommand(gate))).length +
    exceptions.filter((exception) => exception.name === step.name && matchesCommand(step, exception.command)).length !== 1)
    .map(reportedStep)

/**
 * CI requires exactly one canonical owner or an explicit exclusion. The two
 * existing recursive coverage claims are pinned in the inventory, and must
 * still be selections their owner runs. A newly added descendant command is
 * unowned until explicitly inventoried. Dynamic candidates are never excluded.
 *
 * @param {readonly ReleaseGate[]} inventory
 * @param {string} source The generated CI workflow YAML.
 * @param {readonly ReleaseGateExclusion[]} exclusions
 * @returns {{ job: string; name: string; command: string }[]}
 */
export const ciGatesMissingFromInventory = (inventory, source, exclusions) => {
  const jobs = jobsOf(source)
  return Object.keys(jobs).flatMap((job) =>
    discoveredJobGates(jobs, job)
      .filter((step) => !step.valid || !exclusions.some((exclusion) => exclusion.job === job &&
        exclusion.commands?.some((command) => matchesCommand(step, command))))
      .filter((step) => inventory.filter((gate) =>
        matchesCommand(step, releaseGateCommand(gate)) ||
        (gate.ciCommands ?? []).some((command) => gateRuns(gate, command) && matchesCommand(step, command))).length !== 1)
      .map((step) => ({ job, ...reportedStep(step) })))
}

/**
 * Exclusions that no longer describe ci.yml: a job that is gone, a command the
 * job does not run, or an excluded command the inventory runs anyway, which
 * makes the stated reason false.
 *
 * @param {readonly ReleaseGate[]} inventory
 * @param {string} source The generated CI workflow YAML.
 * @param {readonly ReleaseGateExclusion[]} exclusions
 * @returns {string[]}
 */
export const staleExclusions = (inventory, source, exclusions) => {
  const jobs = workflowJobs(source)
  /** @type {string[]} */
  const stale = []
  for (const exclusion of exclusions) {
    if (!jobs.includes(exclusion.job)) { stale.push(`${exclusion.job} is not a ci.yml job`); continue }
    const steps = discoveredJobGates(jobsOf(source), exclusion.job)
    for (const command of exclusion.commands ?? []) {
      if (!steps.some((step) => matchesCommand(step, command))) stale.push(`${exclusion.job} does not run ${command}`)
    }
    for (const step of steps.filter((step) => exclusion.commands === undefined || exclusion.commands.some((command) => matchesCommand(step, command)))) {
      const command = exclusion.commands?.find((command) => matchesCommand(step, command)) ?? step.command
      if (inventory.some((gate) => gateRuns(gate, command))) stale.push(`${exclusion.job} excludes ${step.command}, which the inventory runs`)
    }
  }
  return stale
}

/**
 * Exceptions that no longer describe release.yml: a step the job does not run,
 * or one the inventory also carries, which would count as both ran and skipped.
 *
 * @param {readonly ReleaseGate[]} inventory
 * @param {string} source The release workflow YAML.
 * @param {readonly ReleaseGateException[]} exceptions
 * @param {string} [job]
 * @returns {string[]}
 */
export const staleExceptions = (inventory, source, exceptions, job = "publish") => {
  const steps = discoveredJobGates(jobsOf(source), job)
  /** @type {string[]} */
  const stale = []
  for (const exception of exceptions) {
    if (!steps.some((step) => step.name === exception.name && matchesCommand(step, exception.command))) {
      stale.push(`${job} does not run "${exception.name}" as ${exception.command}`)
    }
    if (inventory.some((gate) => gate.name === exception.name || releaseGateCommand(gate) === exception.command)) {
      stale.push(`"${exception.name}" is both an inventory gate and an exception`)
    }
  }
  return stale
}
