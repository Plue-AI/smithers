/**
 * Picks one instance's submission out of its best-of-n runs, before grading.
 *
 *   node select-candidate.mjs <instance_id> [--journals dir] [--patches dir] [--out dir]
 *
 * ## THIS SELECTOR MUST NEVER READ EVALUATOR OUTPUT
 *
 * A best-of-n number is only a number about the harness if the choice among the
 * n runs is made from what the harness itself recorded. A selector that peeked
 * at the official evaluator's report — or at the dataset's `FAIL_TO_PASS` list,
 * or at anything else that knows the answer — would be reporting an oracle, and
 * an oracle's score says nothing about whether a run can tell its own work is
 * finished.
 *
 * The rule is enforced by what this program can name, not by discipline. It
 * takes an instance id and up to three **directories**, and every file it opens
 * is derived from the id and a run index: `<journals>/<id>-<rN>/engine.db` and
 * `<patches>/<id>-<rN>.patch`. The evaluator's reports are
 * `<model-name>.<run-id>.json` at the rig root and there is no argument, flag or
 * code path here that can name one. An unrecognised flag is refused rather than
 * ignored.
 *
 * ## What it ranks on
 *
 * Four predicates, each read back off the journal through the harness's own
 * modules rather than re-implemented here (see `lib/journal-facts.mjs`):
 *
 * 1. **a check failed over the pre-edit tree** — some call reported a failing
 *    exit status in a frame at epoch 0, before the run had changed anything;
 * 2. **the tree moved after it** — some later frame's measurement says the
 *    workspace changed;
 * 3. **the same check, or a broader one, went green over the final tree** —
 *    `Sufficiency.find`'s own relation, restricted to frames whose closing
 *    digest is the digest the run finished on. "Broader" is `NarrowedCheck`
 *    `narrows`: every term of the passing check carried by the failing one;
 * 4. **the completion holds** — the run applied a `complete` transition and
 *    neither `UnmovedTree.find` nor `UnresolvedFailure.find` names a condition
 *    at that frame.
 *
 * Predicates 1 to 3 are the evidence the cell contract asks a run to hold.
 * Predicate 4 is the absence of the two conditions the harness would have
 * bounced the completion for. Nothing here reads the completion's text, and
 * nothing here decides whether the change is correct — that is the evaluator's
 * job, and it happens after this.
 *
 * ## How it ranks
 *
 * More predicates held wins. Equal counts are broken by the predicates in the
 * order above, then by the tie-breaks, in this order: a **broader final check**
 * beats a narrower one (fewer terms is less constrained), a **non-empty patch**
 * beats an empty one, **lower cost** beats higher, and a **lower run index**
 * beats a higher one — by number, and by spelling where two indexes name one
 * number, because `r1` and `r01` are both legal. The last key makes the order
 * total, so the same journals always produce the same choice.
 *
 * Writes `<out>/<id>.patch` — the chosen run's patch, byte for byte — and
 * `<out>/<id>.rationale.json`, which names the evidence sequence numbers behind
 * every predicate of every candidate, so the choice can be second-guessed from
 * the journals without re-running anything.
 *
 * Spends no tokens, needs no docker, needs no dataset.
 *
 * @since 0.1.0
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import * as Sufficiency from "../../packages/smithers/agent/harness/src/Sufficiency.ts"
import * as UnmovedTree from "../../packages/smithers/agent/harness/src/UnmovedTree.ts"
import * as UnresolvedFailure from "../../packages/smithers/agent/harness/src/UnresolvedFailure.ts"
import { read } from "./lib/journal-facts.mjs"
import { usd } from "./prices.ts"

const here = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Arguments — three directories and an instance id, and nothing else
// ---------------------------------------------------------------------------

const known = new Set(["--journals", "--patches", "--out"])
const argv = process.argv.slice(2)
const flags = { "--journals": "journals", "--patches": "patches", "--out": "selected" }
let instance

for (let index = 0; index < argv.length; index++) {
  const argument = argv[index]
  if (argument.startsWith("--")) {
    if (!known.has(argument)) {
      console.error(`select-candidate.mjs: unknown flag ${argument}`)
      console.error("  It takes an instance id and the directories --journals, --patches and --out.")
      console.error("  It reads no evaluator report and has no flag that could name one.")
      process.exit(2)
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith("--")) {
      console.error(`select-candidate.mjs: ${argument} needs a directory`)
      process.exit(2)
    }
    flags[argument] = value
    index += 1
    continue
  }
  if (instance !== undefined) {
    console.error("select-candidate.mjs: one instance id at a time")
    process.exit(2)
  }
  instance = argument
}

if (instance === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]*__[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(instance)) {
  console.error("select-candidate.mjs: instance id must match <repo>__<issue>")
  process.exit(2)
}

const directory = (flag, value) => {
  const path = resolve(here, value)
  if (existsSync(path) && !statSync(path).isDirectory()) {
    console.error(`select-candidate.mjs: ${flag} must name a directory, and ${value} is a file`)
    process.exit(2)
  }
  return path
}

const journalsDir = directory("--journals", flags["--journals"])
const patchesDir = directory("--patches", flags["--patches"])
const outDir = directory("--out", flags["--out"])

if (!existsSync(journalsDir)) {
  console.error(`select-candidate.mjs: no journals directory at ${journalsDir}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Candidates — one per archived journal, named by the run index alone
// ---------------------------------------------------------------------------

const indexOf = (name) => {
  if (!name.startsWith(`${instance}-`)) return undefined
  const suffix = name.slice(instance.length + 1)
  return /^r[0-9]+$/u.test(suffix) ? suffix : undefined
}

/**
 * The run index order: by number, then by spelling.
 *
 * `r1` and `r01` are both legal indexes and both name the number one, so
 * comparing the numbers alone leaves two real candidates unordered and the
 * choice among them to `readdirSync`, which is the filesystem's business and not
 * a decision anyone recorded. The name is unique within a directory, so falling
 * back to it makes the order total — which is the only property the last
 * tie-break exists to provide.
 */
const byIndex = (left, right) => {
  const difference = Number(left.slice(1)) - Number(right.slice(1))
  return difference !== 0 ? difference : left < right ? -1 : left > right ? 1 : 0
}

const runIndexes = readdirSync(journalsDir)
  .map((name) => indexOf(name))
  .filter((index) => index !== undefined && existsSync(join(journalsDir, `${instance}-${index}`, "engine.db")))
  .sort(byIndex)

if (runIndexes.length === 0) {
  console.error(`select-candidate.mjs: no archived journal for ${instance} under ${journalsDir}`)
  process.exit(1)
}

/**
 * The strongest failing-before/passing-after pair a run holds over its final
 * tree.
 *
 * `Sufficiency.find` answers the question per frame, so this asks it of every
 * frame whose closing digest is the digest the run finished on, and keeps the
 * broadest passing check among the answers — fewest terms, the least
 * constrained question, which is the strongest evidence the run holds.
 */
const proofOverFinalTree = (facts) => {
  if (facts.finalDigest === "") return undefined
  let found
  for (const frame of facts.frames) {
    if (frame.workspaceDigest !== facts.finalDigest) continue
    const held = Sufficiency.find({
      ledger: frame.failures,
      frame: frame.frameChecks,
      epoch: frame.closingEpoch
    })
    if (held === undefined) continue
    if (found !== undefined && found.pair.passed.terms.length <= held.passed.terms.length) continue
    const passedSeq = frame.checks.find((entry) => entry.check.signature === held.passed.signature)?.seq
    found = { pair: held, frame, passedSeq }
  }
  return found
}

/** The first failure this run watched before it had changed anything. */
const preEditFailure = (facts) => {
  for (const frame of facts.frames) {
    if (frame.epoch !== 0) break
    for (const entry of frame.checks) {
      if (entry.check.failing && entry.check.stable) return { check: entry.check, seq: entry.seq, frame }
    }
  }
  return undefined
}

/** The first frame after `frame` whose measurement says the workspace changed. */
const mutationAfter = (facts, frame) =>
  facts.frames.find((candidate) => candidate.index > frame.index && candidate.mutated)

const clip = (text, width) => text.length > width ? `${text.slice(0, width - 1)}…` : text

const candidates = runIndexes.map((index) => {
  const runId = `${instance}-${index}`
  const facts = read(join(journalsDir, runId, "engine.db"))
  const patch = join(patchesDir, `${runId}.patch`)
  const patchBytes = existsSync(patch) ? statSync(patch).size : 0

  const failure = preEditFailure(facts)
  const moved = failure === undefined ? undefined : mutationAfter(facts, failure.frame)
  const proof = proofOverFinalTree(facts)
  const completing = facts.completing[facts.completing.length - 1]
  const unmoved = completing === undefined ? undefined : UnmovedTree.find({
    opened: facts.openedDigest,
    digest: completing.workspaceDigest
  })
  const unresolved = completing === undefined || unmoved !== undefined ? undefined : UnresolvedFailure.find({
    ledger: completing.ledger,
    digest: completing.workspaceDigest
  })

  const predicates = {
    preEditFailure: failure === undefined
      ? { held: false, why: "no check reported a failing exit status before the run changed anything" }
      : { held: true, seq: failure.seq, epoch: 0, check: `${failure.check.flow} ${clip(failure.check.label, 160)}` },
    mutationAfter: moved === undefined
      ? {
        held: false,
        why: failure === undefined
          ? "no pre-edit failure to move away from"
          : "the workspace never changed after that check"
      }
      : { held: true, seq: moved.seq, digest: moved.digest },
    greenOverFinalTree: proof === undefined
      ? { held: false, why: "no check the run had watched fail went green over the tree it finished on" }
      : {
        held: true,
        seq: proof.passedSeq ?? proof.frame.seq,
        failedEpoch: proof.pair.failed.epoch,
        digest: facts.finalDigest,
        failed: `${proof.pair.failed.flow} ${clip(proof.pair.failed.label, 160)}`,
        passed: `${proof.pair.passed.flow} ${clip(proof.pair.passed.label, 160)}`,
        terms: proof.pair.passed.terms.length
      },
    cleanCompletion: completing === undefined
      ? { held: false, why: "the run never applied a complete transition" }
      : unmoved !== undefined
      ? { held: false, why: "unmoved tree at the completing frame", seq: completing.transitionSeq }
      : unresolved !== undefined
      ? {
        held: false,
        why: "an unanswered failing check at the completing frame",
        seq: completing.transitionSeq,
        failed: `${unresolved.failed.flow} ${clip(unresolved.failed.label, 160)}`,
        instead: `${unresolved.instead.flow} ${clip(unresolved.instead.label, 160)}`
      }
      : { held: true, seq: completing.transitionSeq, digest: completing.workspaceDigest }
  }

  const held = [
    predicates.preEditFailure.held,
    predicates.mutationAfter.held,
    predicates.greenOverFinalTree.held,
    predicates.cleanCompletion.held
  ]
  const priced = usd(facts.seat, facts.usage)

  return {
    index,
    runId,
    patchBytes,
    patch,
    held,
    score: held.filter(Boolean).length,
    finalCheckTerms: proof === undefined ? Number.MAX_SAFE_INTEGER : proof.pair.passed.terms.length,
    usd: priced.usd,
    tokens: facts.usage,
    seat: facts.seat,
    frames: facts.frames.length,
    modelCalls: facts.modelCalls,
    demands: {
      unmoved: facts.demands.unmoved.length,
      unresolved: facts.demands.unresolved.length,
      narrowed: facts.demands.narrowed.length,
      narrowOnly: facts.demands.narrowOnly.length,
      readOnly: facts.demands.readOnly.length,
      repeat: facts.demands.repeat.length
    },
    sufficiencyObservations: facts.sufficiencyEvents.length,
    predicates
  }
})

// ---------------------------------------------------------------------------
// The order — total, so the same journals always choose the same run
// ---------------------------------------------------------------------------

const rank = (left, right) => {
  if (left.score !== right.score) return right.score - left.score
  for (let index = 0; index < left.held.length; index++) {
    if (left.held[index] !== right.held[index]) return left.held[index] ? -1 : 1
  }
  if (left.finalCheckTerms !== right.finalCheckTerms) return left.finalCheckTerms - right.finalCheckTerms
  const leftEmpty = left.patchBytes === 0
  const rightEmpty = right.patchBytes === 0
  if (leftEmpty !== rightEmpty) return leftEmpty ? 1 : -1
  const leftCost = left.usd ?? Number.MAX_SAFE_INTEGER
  const rightCost = right.usd ?? Number.MAX_SAFE_INTEGER
  if (leftCost !== rightCost) return leftCost - rightCost
  return byIndex(left.index, right.index)
}

const ranked = [...candidates].sort(rank)
const chosen = ranked[0]

mkdirSync(outDir, { recursive: true })
const selectedPatch = join(outDir, `${instance}.patch`)
if (existsSync(chosen.patch)) {
  copyFileSync(chosen.patch, selectedPatch)
} else {
  // A run that produced no patch file is an empty prediction, which is what the
  // evaluator grades an empty patch as. Writing the file keeps the selected set
  // one patch per instance whatever the runs did.
  writeFileSync(selectedPatch, "")
}

const relative = (path) => path.startsWith(`${here}/`) ? path.slice(here.length + 1) : path
const rationale = {
  instance,
  selected: chosen.index,
  selectedRunId: chosen.runId,
  selectedPatch: relative(selectedPatch),
  read: { journals: relative(journalsDir), patches: relative(patchesDir) },
  neverRead: "the official evaluator's reports, the dataset's tests, and every other record of the answer",
  predicateOrder: ["preEditFailure", "mutationAfter", "greenOverFinalTree", "cleanCompletion"],
  tieBreaks: ["broader final check", "non-empty patch", "lower cost", "lower run index"],
  candidates: ranked.map((candidate, position) => ({
    rank: position + 1,
    index: candidate.index,
    runId: candidate.runId,
    score: candidate.score,
    patchBytes: candidate.patchBytes,
    finalCheckTerms: candidate.finalCheckTerms === Number.MAX_SAFE_INTEGER ? null : candidate.finalCheckTerms,
    usd: candidate.usd ?? null,
    tokens: candidate.tokens,
    seat: candidate.seat ?? null,
    frames: candidate.frames,
    modelCalls: candidate.modelCalls,
    demands: candidate.demands,
    sufficiencyObservations: candidate.sufficiencyObservations,
    predicates: candidate.predicates
  }))
}
const rationalePath = join(outDir, `${instance}.rationale.json`)
writeFileSync(rationalePath, `${JSON.stringify(rationale, null, 2)}\n`)

console.log(
  `${instance}: ${chosen.index} of ${candidates.length} `
    + `(${chosen.score}/4 predicates, ${chosen.patchBytes} patch bytes) -> ${relative(selectedPatch)}`
)
for (const candidate of ranked) {
  console.log(
    `  ${candidate.index} score ${candidate.score} `
      + `[${candidate.held.map((value) => value ? "y" : "n").join("")}] `
      + `${candidate.patchBytes} bytes`
      + `${candidate.usd === undefined ? "" : ` $${candidate.usd}`}`
  )
}
