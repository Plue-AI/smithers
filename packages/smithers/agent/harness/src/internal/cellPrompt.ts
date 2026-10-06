/**
 * The one contract the cell-first harness teaches a model.
 *
 * This contract is plain JavaScript over `ctx.call`, shaped to look like the
 * Claude Code workflow API, and that is a ruling rather than an accident: will
 * ruled on 2026-08-20 that the model authoring surface stays this shape,
 * because agents perform better on the shape they are trained on. Effect.ts is
 * the language of the code we maintain, not the language the model writes. Do
 * not port this contract onto `Flow`/`Action`/`Node`; that was built out under
 * a 2026-08-12 ruling and reversed. It may be tested later as a benchmark arm
 * and is adopted only if it benchmarks better.
 *
 * There is one contract, and it is the REPL's. The surface it replaced — a cell
 * as the body of its own async function, filing JSON into `state` and choosing
 * its successor's `context` by hand — is recorded as a design error rather than
 * as an arm that lost: it made the model do the realm's job, which is why it
 * never worked like a REPL. will ruled it out on 2026-08-24. The evidence and
 * the ruling are in `../../docs/concepts.md#repl-realm`.
 *
 * The teaching here is measured, not preferred, and the measurement has now run
 * both ways. The merged optimal-trace program
 * predicted that more teaching
 * would buy verdicts, and grew the contract it replaced from 8,197 to 11,312
 * characters across changes 2, 9 and 10. The re-run that settles those
 * predictions says it did not:
 * resolved fell 35/45 to 30/45, cost rose 59 %, and five instances spent a whole
 * 1,200 s budget without editing one byte, held there by an unconditional
 * pre-edit reproduction rule. The same wave shows every *tool* change paying.
 * That is why the rules below carry their traces and why a teaching change is
 * made one at a time.
 *
 * The exception rule 8 used to state — "when the command will not bootstrap,
 * edit on the diagnosis you have and establish the proof afterwards" — is gone,
 * and it is gone because the thing it was managing no longer exists. It existed
 * to relieve an *ordering*: a baseline had to be taken before the edit, so a
 * baseline that could not be taken yet blocked the edit. Checkpoints remove the
 * ordering outright (will, 2026-08-24). The baseline is now taken after the
 * edit, against `ctx.base`, so there is nothing left to make conditional and a
 * sentence offering relief from a constraint the contract no longer imposes is
 * teaching a shape that is not the shape.
 *
 * The same ruling is why the worked examples put the edit first and the
 * baseline second. That ordering is the whole of the failure it kills: on
 * `sympy__sympy-13878` the r95repl lane applied one byte-identical
 * 4,789-character patch five times, four of those applications preceded by
 * `git checkout -- sympy/stats/crv_types.py`, because a clean fails-before
 * proof required reverting the very work it was meant to prove. Models imitate
 * the example, and the example now shows a run that never gives its work back.
 *
 * The environment facts a host can compute (change 9) stay in full: they cost
 * the agent nothing to read and removed a whole class of archaeology.
 *
 * Each rule below carries the failure it was written against; do not soften one
 * without the trace that says the failure stopped happening, and do not add one
 * without a trace that says teaching — rather than a tool — is the gap.
 *
 * Governing design: `../../docs/concepts.md#model-authoring-surface` (the
 * ruling) and `../../docs/concepts.md#agent-cell-context` (the surface).
 *
 * @since 0.1.0
 */

import * as Digest from "@smthrs/core/Digest"
import * as CanonicalJson from "@smthrs/model/CanonicalJson"
import type * as Descriptor from "@smthrs/registry/Descriptor"
import { Option } from "effect"
import type * as AgentEvent from "../AgentEvent.ts"
import type * as Cell from "../Cell.ts"
import * as Monitor from "../Monitor.ts"
import { untrustedData } from "./untrustedData.ts"

/**
 * One rendered prompt section, with the digest that identifies its
 * content.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export interface Section {
  readonly id: "cell-contract" | "cell-stance" | "cell-environment" | "cell-jev" | "cell-catalog"
  readonly text: string
  readonly digest: string
}

/**
 * Facts about the container a run executes in, computed by the harness.
 *
 * Every field is something the host can read off the environment without
 * knowing anything about the task, which is the whole admission rule: the
 * program that motivated this section rejects instance-specific teaching
 * outright, so the shape is a closed set of typed fields rather than free
 * prose a caller could smuggle an answer into. Facts that are absent are not
 * rendered; the run discovers them the ordinary way.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Environment {
  /** The container's locale and encoding, as `LANG`/`LC_ALL` report it. */
  readonly locale?: string
  /** Tools a run will reach for that this image does not install. */
  readonly absentTools?: ReadonlyArray<string>
}

/**
 * The contract every run is taught.
 *
 * It is the contract that replaced the filing one, and the difference is exactly
 * the difference in the surface: there is no returned object to describe, no
 * `state` to file, no manifest to read, and no `render`/`recall` to name,
 * because the variable is the memory and the print is the summary.
 *
 * Every rule with a trace behind it was carried across byte-similar when the
 * surface changed, and that was deliberate: the r91 rerun grew the old contract
 * from 8,197 to 11,312 characters and dropped resolved from 35/45 to 30/45 at
 * 59 % more cost, which says teaching changes are expensive and must be measured
 * one at a time. A wave that changed the realm *and* re-cut the doctrine could
 * not attribute its own result. Cutting further is its own arm, with its own
 * wave.
 *
 * The second worked example is the golf report's own prescription — its
 * class-(a) finding is that the contract's only worked example is a three-line
 * toy, and models imitate the example.
 *
 * It moved a second time on 2026-08-24, when checkpoints landed: the baseline
 * moved after the edit in the example and rule 9 names `ctx.base`. Both pinned
 * numbers moved with it.
 *
 * The completion teaching first moved after the first REPL wave, and the change
 * is stated rather than smuggled. What died is the see-then-attest rule
 * ("complete only once you have SEEN that identical command pass"): it asked for
 * a memory of a result and got one, and `sympy__sympy-13878` ended by claiming
 * in `output` that a suite "exited 0 and printed its passing test summary" one
 * frame after its own guarded `ctx.done` had declined to fire because that suite
 * exited 1. What replaces it is the shape the model had already written and
 * abandoned: complete behind a check of the result, `if (after.exitCode === 0)
 * ctx.done(...)`, so the verdict is read from the call rather than remembered
 * across a turn. An unguarded completion stays legal — sometimes nothing in the
 * image can be made to flip — and is named for what it is, a claim nobody
 * checked. That is will's ruling of 2026-08-23, and it is why the pinned length
 * in `test/CellPrompt.test.ts` moved.
 *
 * Task scoping moved on 2026-09-19 after a chat request to answer only A spent
 * twelve frames printing and then looking for an unrelated failing test.
 * The host already taught same-cell completion, but these rules required an
 * edit and a proving command unconditionally. The scoped contract completed
 * the retained natural-language opening in six of six probes, against four
 * of six for the old contract. A seeded six-print loop still did not recover
 * the exact answer; the unchanged read-only cap remains necessary. The edit,
 * baseline and tree-review requirements remain for requested workspace work.
 *
 * Rule 10 and rule 4's `jev` clause moved to the `cell-jev` section on
 * 2026-09-25 (#1929), so a run with no `jev` bound is not taught it.
 *
 * On 2026-09-30 will ruled for token economy: every rule stays, prose becomes
 * fragments, 9,715 → 5,553 characters. No wave has measured this wording yet.
 *
 * Governing design: `../../docs/concepts.md#repl-realm`.
 */
const replContract = `JavaScript REPL, one cell per turn, alive for the whole run.

Every reply MUST contain a fenced \`cell\` block, JavaScript only. Several blocks in one reply run as ONE program.

Top-level bindings persist across cells, as in any REPL. \`console.log\` output opens your next turn and stays in context; unprinted values stay in their variables.

Example bug fix, two cells. Names illustrative; call what \`ctx.flows\` lists.

\`\`\`cell
const found = await ctx.call("grep", { pattern: "return value", root: "src/units", limit: 5 })
const hit = found.ok === false ? undefined : found.matches[0]   // failed calls resolve, never throw
const region = await ctx.call("read", { path: hit.file, offset: Math.max(1, hit.line - 20), limit: 40 })
console.log(region.content)
\`\`\`

\`\`\`cell
const verification = { flow: "bash", input: { command: "run-tests tests/test_widen.py::test_keeps_unit" } }
const anchor = hit.text                                         // text a call returned, never typed from memory
const applied = await ctx.call("edit", { path: hit.file, oldString: anchor, newString: anchor.replace("return value", "return widen(value)") })
const before = await ctx.call(verification.flow, verification.input, { at: ctx.base })  // opening tree; edit stays
const after = await ctx.call(verification.flow, verification.input)
console.log(applied.ok === false ? applied.error.message : applied.hunk, before.exitCode, after.exitCode, after.stdout)
if (before.exitCode !== 0 && after.exitCode === 0) ctx.done(verification.input.command + " failed before the edit and exits 0 after it; the applied hunk is:\\n" + applied.hunk)
\`\`\`

Many calls per cell; one call per frame wastes turns.

Rules:

1. Bindings: \`ctx\`, \`console\`, earlier cells' names. \`ctx.call(name, input)\` runs a flow; \`ctx.flows\` lists them. No imports, require, fetch, filesystem, process, Date, Math.random; anything else throws. Strings passed to flows are data (a Python heredoc is fine).
2. Every effect is a flow: files, commands, memory, questions, subagents.
3. A failed call does not throw: resolves \`{ ok: false, error: { code, message, hint } }\`; test \`.ok === false\` where you are unsure. Success resolves the result unwrapped. A throwing cell keeps names already assigned. Long calls spend the flow's budget, not the cell's. Output is capped: a result flagged truncated is a fragment. Restore files with git checkout or git restore; never route file content through captured stdout (a write of bytes a call returned truncated is refused).
4. Print only what you must read; keep the rest in variables. Each turn opens with your last print, bound names, and one line per settled call (tree writes and repeats flagged). Prints are re-paid every turn: ≤40 lines a cell; never whole listings, search results, files or intermediates. Counts and paths first (\`console.log(hits.matches.length, files.slice(0, 15))\`, not \`console.log(hits)\`), then read only the chosen region. Structures print as JSON; record lists as tables.
5. Finish by calling. \`ctx.done(output)\` ends the run; \`output\` is the answer. \`ctx.park(reason, message)\` waits durably for a human; reason "waiting-input" | "waiting-event" | "waiting-quota"; refused when nobody listens. Both take effect at that line; later calls in the cell resolve \`{ ok: false, error: { code: "run_completed" } }\`. Conversational or read-only request: \`ctx.done(answer)\` directly; no edit, command, baseline or tree review. \`console.log\` alone does not finish. Workspace change: finish behind the deciding check, \`if (after.exitCode === 0) ctx.done(...)\`. Let the guard read the tree too: \`git status --porcelain\` and \`git diff\` in the completing cell; finish silently only when the check passes AND the diff holds exactly the files you meant to change, else \`console.log\` that diff. A bare \`ctx.done\` is allowed but is a claim nobody checked: say what is unverified. Name each claimed check's exact command and output. A cell calling neither ends the turn.
6. Resume re-executes cells from the top; settled calls replay recorded results.
7. Bug-fix evidence: a command counts only after you SEE it fail on the unmodified tree FOR THE RIGHT REASON (the bug). A probe naming a test, file, module or program that does not exist reproduces nothing; \`invalidProbe\` flags some. Fix such a probe before you rely on it. Keep the check as \`verification = { flow, input }\`; reuse it unchanged after edits.
8. Workspace change: read broadly in ONE cell, then edit. Too many frames without a write stop the run; near the limit, edit or \`ctx.justify("<missing evidence, the call that gets it, what changes next>")\`. An edit answers with the hunk it applied: print it in the same cell (a bad edit costs one glance there). Then run whatever language-aware checker \`ctx.flows\` and this image actually offer (compiler, ruff, eslint/tsc) through the shell flow. Fix undefined names before broad suites. No checker: say so; never regex-guess.
9. Bug-fix proof, fewest frames: ONE cell edits, runs the baseline at \`{ at: ctx.base }\` (opening tree), reruns the identical check. NEVER undo your own edit to re-prove a baseline. \`ctx.checkpoint()\` pins the current tree for your own baseline; a checkpoint is read-only, so a flow that writes is refused at one. Let code decide: \`if (before.exitCode !== 0 && after.exitCode === 0) ctx.done(...)\`. An already-green suite or a probe that misses its target proves nothing.

Cell throws: you are told, next turn. If a cell does not PARSE nothing ran at all; you are asked again inside the SAME frame with the error and line.`

/**
 * How a cell uses the `jev` flow, taught only when the catalog binds it.
 *
 * It was rule 10 of the contract and a clause of rule 4 until 2026-09-25, when
 * will asked for Jev to be used strongly in the cells a model writes (#1929).
 * A rule that names a flow the catalog may not hold teaches a call that
 * resolves `unknown_flow`, so the teaching moved into a section of its own
 * that exists exactly when the flow does. It is constant for a run, so it sits
 * between the environment and the catalog without breaking the cached prefix.
 *
 * The floors are the owner's: act on a boolean at probability 0.8, and on a
 * choice or score at the provider's confidence 0.7. A choice's own
 * `.confidence` is the largest probability in its distribution and reads 1
 * when none was sent, so the teaching names the provider's number instead.
 *
 * The one worked example is run verbatim by `test/CellFlows.test.ts` against
 * the real `grep` and `jev` bindings, because a model copies the example.
 */
const jevText =
  `1. Use \`jev\` for any judgment over >3 items and any yes/no, pick-one or score you would otherwise make by printing and reading (relevant files, related failures, rankings, which subtask needs a worker). ONE call: items in \`state:\`, one question per item keyed by your id. Hundreds take ~300 ms.
2. Never make one call per item; never ask \`jev\` for text, code or quotes.
3. Failure resolves \`{ ok: false }\`: print \`error.message\`; do not decide in its place.
4. Act on booleans when \`answers[id].probability >= 0.8\`; on choice or score when \`judged.confidence?.[id] >= 0.7\` (provider confidence; absent = uncertain). Never use a choice's own \`.confidence\` (reads 1 without a distribution). Print uncertain items; don't decide them.

\`\`\`cell
const found = await ctx.call("grep", { pattern: "timeout", root: "src", limit: 200 })
const files = found.ok === false ? [] : [...new Set(found.matches.map((m) => m.file))]
const judged = await ctx.call("jev", { state: { task: "the timeout ignores its setting", files }, questions: Object.fromEntries(files.map((f) => [f, { type: "boolean", instructions: "Must " + f + " change?" }])) })
const p = (f) => judged.answers[f].probability
const kept = judged.ok === false ? [] : files.filter((f) => p(f) >= 0.8)
const uncertain = judged.ok === false ? [] : files.filter((f) => p(f) > 0.2 && p(f) < 0.8)
console.log(found.ok === false ? found.error.message : judged.ok === false ? judged.error.message : { count: files.length, kept, uncertain })
\`\`\``

/**
 * The one line a judged run is taught about its stance: the Monitor mood text,
 * verbatim, so the static stance and the delivered mood never disagree.
 */
const stanceText = (stance: typeof AgentEvent.Stance.Type): string =>
  stance === "paranoid" ? Monitor.paranoidText : Monitor.carefulText

const historyFact =
  `the checkout ends at the commit you were given; no branch, tag, stash or reflog here holds a later fix, so \`git log --all\` or \`-S\` hunting costs a frame and returns nothing. The harness keeps its own attempt and durability snapshots in a repository of its own. A dangling commit is this harness pinning your own tree for a checkpoint: \`git fsck\` reports your edit and never a fix. Backwards history pays: \`git blame\` or \`git log -S\` on a line says what an assertion was written for; given a last-known-good release, \`git log <tag>..HEAD -- <paths>\`.`

const environmentText = (environment: Environment): string => {
  const lines = [`- History: ${historyFact}`]
  if (environment.locale !== undefined) {
    lines.push(
      `- Locale: ${environment.locale}; output and files decode as that.`
    )
  }
  const absent = environment.absentTools === undefined ? [] : [...environment.absentTools].sort()
  if (absent.length > 0) {
    lines.push(
      `- Not installed: ${absent.join(", ")}. Calls to them fail; use \`ctx.flows\`.`
    )
  }
  return `Harness-computed facts about the checkout and container, not the task.\n${lines.join("\n")}`
}

const digest = (id: Section["id"], text: string): string => Digest.digest(CanonicalJson.stringify({ id, text }))

type CatalogProjection = Cell.FlowProjection & Partial<Pick<Descriptor.FlowDescriptor, "provenance" | "path">>

const catalogText = (flows: Readonly<Record<string, CatalogProjection>>): string => {
  const names = Object.keys(flows).sort()
  if (names.length === 0) {
    return "No flows are callable in this run. Complete or park; ctx.call has nothing to reach."
  }
  const lines = names.map((name) => {
    const projection = flows[name]!
    const capabilities = projection.capabilities.length === 0
      ? ""
      : ` capabilities=${[...projection.capabilities].sort().join(",")}`
    const origin = JSON.stringify({
      source: projection.provenance?.source ?? "unknown",
      root: projection.provenance?.root,
      path: projection.path
    })
    const heading = `- ${name} (${projection.tier})${capabilities}: ${projection.description}\n  provenance: ${origin}`
    // The input schema is the difference between choosing a call and guessing
    // one. A rejected input costs a whole frame, so a catalog that names a
    // flow without saying what it takes spends the run's frame budget on
    // trial and error.
    return Option.isNone(projection.input)
      ? heading
      : `${heading}\n  input: ${JSON.stringify(projection.input.value)}`
  })
  return `Flows callable with ctx.call in this frame:\n${
    untrustedData(lines.join("\n"), "flow catalog (descriptor provenance follows)")
  }`
}

/**
 * Builds the cell-contract teaching sections for one frame.
 *
 * The order is by how often each section changes, because every one of them is
 * a prefix segment and a prefix is only cached up to its first edit: the
 * contract is constant for the life of the binary, the environment and the
 * `jev` teaching for the life of a run, and the catalog can differ frame to
 * frame. The `jev` teaching is rendered only when `flows` binds `jev`.
 *
 * `stance` renders a one-line `cell-stance` section between the contract and
 * the environment. It is constant for the run, so the cached prefix holds;
 * with no stance nothing is rendered and the prompt is unchanged.
 *
 * `environment` carries what the host measured about the container. It is
 * optional because the epoch fact — a checkout has no future in it — holds
 * everywhere and is stated with or without a host that measures anything else.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (
  flows: Readonly<Record<string, CatalogProjection>>,
  environment: Environment = {},
  stance?: typeof AgentEvent.Stance.Type
): ReadonlyArray<Section> => {
  const facts = environmentText(environment)
  const catalog = catalogText(flows)
  const taught = replContract
  const stanced = stance === undefined ? undefined : stanceText(stance)
  return [
    { id: "cell-contract", text: taught, digest: digest("cell-contract", taught) },
    ...(stanced === undefined
      ? []
      : [{ id: "cell-stance" as const, text: stanced, digest: digest("cell-stance", stanced) }]),
    { id: "cell-environment", text: facts, digest: digest("cell-environment", facts) },
    ...(flows.jev === undefined
      ? []
      : [{ id: "cell-jev" as const, text: jevText, digest: digest("cell-jev", jevText) }]),
    { id: "cell-catalog", text: catalog, digest: digest("cell-catalog", catalog) }
  ]
}
