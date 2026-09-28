/**
 * Pins the two harnesses' prompts to one another.
 *
 * The rig's whole claim is that a flows number and a codex number on one
 * instance are the same measurement of two harnesses. That claim is only as good
 * as the prompts: anything one side is taught and the other is not is a variable
 * the comparison does not control, and it will show up in the score as if it
 * were harness quality.
 *
 * The rule this pins is not "the two prompts are identical" — they cannot be,
 * because one names flows' own tools — but **the difference is exactly the tool
 * guidance and nothing else**. The flows-only lines are listed here by hand, so
 * adding a sixth one, or dropping a shared line from one side, fails this check
 * rather than quietly moving the baseline.
 *
 * It is written because that is what happened. On 2026-08-19 the flows prompt
 * started naming the repository's own test runner — `./tests/runtests.py` for
 * Django, `tox` for Sphinx — and the codex prompt kept telling its agent to
 * verify with `python -m pytest`, which neither repository can run. Waves 10 and
 * 11 compared a harness that could check its work against a baseline that could
 * not, on two of five instances, and nothing in the rig said so.
 *
 * Spends no tokens, needs no docker, needs no dataset: the instance row is
 * synthesised here.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const temporary = mkdtempSync(join(tmpdir(), "flows-swebench-prompts-"))

const instance = {
  instance_id: "stub__prompt-1",
  repo: "stub/stub",
  version: "1.0",
  base_commit: "0f1e2d3c4b5a",
  problem_statement: "The reindexer drops the calendar attribute when the axis is empty.",
  // The graded identifiers travel in the dataset row. Neither prompt writer may
  // put them in a prompt, and both are handed the whole row.
  FAIL_TO_PASS: ["tests/test_reindex.py::test_empty_axis_keeps_calendar"],
  PASS_TO_PASS: ["tests/test_reindex.py::test_basic"],
  patch: "--- a/stub/reindex.py\n+++ b/stub/reindex.py\n@@\n-drop\n+keep\n",
  test_patch: "--- a/tests/test_reindex.py\n+++ b/tests/test_reindex.py\n@@\n+def test_empty_axis_keeps_calendar():\n"
}

const container = "flowsbench-stub--prompt-1"
const testCommand = "./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1"
const interpreter = "/opt/miniconda3/envs/testbed/bin/python3.10"

const write = (script, args) => {
  const result = spawnSync(process.execPath, [join(root, "lib", script), ...args], { encoding: "utf8" })
  return result
}

try {
  const dataset = join(temporary, "dataset.json")
  writeFileSync(dataset, JSON.stringify([instance]))

  const flowsRun = write("write-flow.mjs", [
    dataset,
    instance.instance_id,
    "openai:gpt-5.6-sol",
    container,
    testCommand,
    interpreter
  ])
  assert.equal(flowsRun.status, 0, flowsRun.stderr)
  const codexRun = write("write-prompt-codex.mjs", [
    dataset,
    instance.instance_id,
    container,
    testCommand,
    interpreter
  ])
  assert.equal(codexRun.status, 0, codexRun.stderr)

  const flowsPrompt = flowsRun.stdout
  const codexPrompt = codexRun.stdout

  // -------------------------------------------------------------------------
  // Neither prompt carries the answer
  // -------------------------------------------------------------------------
  for (const [name, prompt] of [["flows", flowsPrompt], ["codex", codexPrompt]]) {
    for (const leak of [...instance.FAIL_TO_PASS, ...instance.PASS_TO_PASS, "FAIL_TO_PASS", "PASS_TO_PASS"]) {
      assert.ok(!prompt.includes(leak), `${name} prompt names ${leak}`)
    }
    assert.ok(!prompt.includes("+keep"), `${name} prompt carries the gold patch`)
    assert.ok(!prompt.includes("test_empty_axis_keeps_calendar"), `${name} prompt carries the graded test`)
    assert.ok(prompt.includes(instance.problem_statement), `${name} prompt carries the issue`)
    assert.ok(prompt.includes(instance.base_commit), `${name} prompt names the base commit`)
    assert.ok(prompt.includes(container), `${name} prompt names this run's container`)
  }

  // -------------------------------------------------------------------------
  // The environment teaching is the same teaching
  // -------------------------------------------------------------------------
  const runnerBullet = `- This repository runs its tests with \`${testCommand}\`, which takes the test
  paths to run as trailing arguments. It is the runner this project actually
  uses: other runners are not necessarily installed here.`
  assert.ok(flowsPrompt.includes(runnerBullet), "the flows prompt names the repository's runner")
  assert.ok(codexPrompt.includes(runnerBullet), "the codex prompt names the same runner, byte for byte")

  // The interpreter is the same kind of fact as the runner, measured off the
  // container by lib/interpreter.sh rather than guessed. r91 shipped the test
  // command without it, and 30 of 45 instances spent 138 cells hunting for
  // `/opt/miniconda3/envs/testbed/bin/python3.10` on their own. Withholding it
  // from one side would reintroduce exactly the asymmetry this file exists for.
  const interpreterBullet = `- This image runs the project's Python as \`${interpreter}\`. The
  repository's dependencies are installed against that interpreter; a bare
  \`python\` or \`python3\` resolves to a different one, and importing the
  project with it fails.`
  assert.ok(flowsPrompt.includes(interpreterBullet), "the flows prompt names the project's interpreter")
  assert.ok(codexPrompt.includes(interpreterBullet), "the codex prompt names the same interpreter, byte for byte")

  // A fact the image would not answer is not stated at all, on either side.
  const withoutInterpreter = [
    write("write-flow.mjs", [dataset, instance.instance_id, "openai:gpt-5.6-sol", container, testCommand]),
    write("write-flow.mjs", [dataset, instance.instance_id, "openai:gpt-5.6-sol", container, testCommand, "  "]),
    write("write-prompt-codex.mjs", [dataset, instance.instance_id, container, testCommand]),
    write("write-prompt-codex.mjs", [dataset, instance.instance_id, container, testCommand, "  "])
  ]
  for (const run of withoutInterpreter) {
    assert.equal(run.status, 0, run.stderr)
    assert.ok(
      !run.stdout.includes("runs the project's Python as"),
      "an unmeasured interpreter is left out, never rendered blank"
    )
    assert.ok(run.stdout.includes(runnerBullet), "dropping the interpreter drops nothing else")
  }

  // The example command is a placeholder on both sides. Spelling a runner into
  // it is how the two drifted apart the first time: the codex prompt's example
  // said `python -m pytest`, which is not the runner for every repository.
  //
  // The two examples differ in one controlled way, and only since the `bash`
  // flow gained a container transport: codex has a shell and nothing else, so
  // it composes the `docker exec` line itself, while flows names the container
  // in the call and the harness builds the argv. Each side is shown the best
  // route its own tools offer, which is the rule this file pins; what neither
  // may carry is a runner, a path, or anything about this instance.
  const codexExample = `      docker exec ${container} bash -lc 'cd /testbed && <command>'`
  const flowsExample = `      { mode: "unhermetic", container: "${container}", cwd: "/testbed", command: "<command>" }`
  assert.ok(codexPrompt.includes(codexExample), "the codex prompt's example is a placeholder")
  assert.ok(flowsPrompt.includes(flowsExample), "the flows prompt's example is the same placeholder")
  assert.ok(
    !flowsPrompt.includes("docker exec"),
    "the flows prompt never asks the agent to compose a docker line: `bash` owns the transport"
  )
  for (const prompt of [flowsPrompt, codexPrompt]) {
    assert.ok(!prompt.includes("python -m pytest"), "no prompt hard-codes one repository's runner")
    assert.ok(prompt.includes("<command>"), "the example stays a placeholder")
  }

  // -------------------------------------------------------------------------
  // The difference is the tool guidance, and it is listed
  // -------------------------------------------------------------------------
  //
  // Every line the flows prompt has and the codex prompt does not. Each is
  // either the flows frontmatter, a flows tool, or the note that the harness
  // snapshots the working copy somewhere the codex workspace has no equivalent
  // of — and that this checkout's git is therefore ordinary.
  const flowsOnly = [
    "---",
    "description: Resolve a reported issue in this repository.",
    "model: openai:gpt-5.6-sol",
    "---",
    // The same sentence, wrapped one word differently because the flows side
    // names the `bash` flow where the codex side says "shell".
    "Your `bash` flow runs on a macOS host with BSD userland. The repository's own",
    "Linux environment and Python interpreter are in a container that has this exact",
    // The container transport: flows names the container in the call and the
    // harness builds the argv, where codex composes the `docker exec` line.
    "  container, by naming it rather than by typing a docker line:",
    `      { mode: "unhermetic", container: "${container}", cwd: "/testbed", command: "<command>" }`,
    "  For a program rather than a line, pass the program itself and let `bash`",
    "  deliver it: `{ ..., interpreter: \"python3\", script: \"<program text>\", args: [] }`",
    "  reaches the interpreter on standard input as data, so nothing quotes it,",
    "  escapes it, or terminates it with a heredoc marker.",
    "  in the container, or avoid it.",
    "- Git in this checkout behaves normally: `git status` and `git diff` show your",
    "  own uncommitted edits and nothing else. This harness snapshots the working",
    "  copy around every action, but it does so in a repository of its own, so",
    "  nothing it writes ever appears in this checkout's history, index, or refs.",
    // The edit contract. codex has its own editing tools and its own teaching
    // for them; this is flows' `edit`, stated where flows' agent reads it.
    "- To change a file, use the `edit` flow with an anchor a call just handed you:",
    "  a `read`'s `content` is raw file text and a `grep` hit's `text` is the line",
    "  itself, so either is an anchor exactly as it stands. `edit` matches those",
    "  bytes or fails with the file's own text at the nearest region, and it answers",
    "  with the hunk it applied. You may also anchor by a prior hit's `startLine`",
    "  and `endLine`. Do not rewrite a whole file to change part of one: `write`",
    "  replaces every byte, and a `read` that came back `truncated` is a fragment.",
    "- `read`, `grep`, `edit` and `write` act on this directory directly and need",
    "  no container.",
    "Complete only when you have applied the fix to the source files and confirmed it",
    "by running code. When you complete, set `output` to a short description of the",
    "change you made."
  ]
  const codexOnly = [
    "Your shell runs on a macOS host with BSD userland. The repository's own Linux",
    "environment and Python interpreter are in a container that has this exact",
    "  container:",
    codexExample,
    "  through docker exec, or avoid it.",
    "Finish only when you have applied the fix to the source files and confirmed it",
    "by running code."
  ]

  const lines = (prompt) => prompt.split("\n")
  const missingFrom = (left, right) => {
    const held = new Set(lines(right))
    return lines(left).filter((line) => line.trim() !== "" && !held.has(line))
  }

  assert.deepEqual(
    missingFrom(flowsPrompt, codexPrompt),
    flowsOnly,
    "the flows prompt says nothing the codex prompt does not, beyond flows' own tools"
  )
  assert.deepEqual(
    missingFrom(codexPrompt, flowsPrompt),
    codexOnly,
    "the codex prompt says nothing the flows prompt does not, beyond the same lines reworded"
  )

  // -------------------------------------------------------------------------
  // Neither writer will produce a prompt with no runner in it
  // -------------------------------------------------------------------------
  const flowsBare = write("write-flow.mjs", [dataset, instance.instance_id, "openai:gpt-5.6-sol", container])
  assert.equal(flowsBare.status, 1, "write-flow.mjs refuses a prompt with no test command")
  assert.match(flowsBare.stderr, /no test command given/u)
  const codexBare = write("write-prompt-codex.mjs", [dataset, instance.instance_id, container])
  assert.equal(codexBare.status, 1, "write-prompt-codex.mjs refuses a prompt with no test command")
  assert.match(codexBare.stderr, /no test command given/u)
  const codexBlank = write("write-prompt-codex.mjs", [dataset, instance.instance_id, container, "   "])
  assert.equal(codexBlank.status, 1, "a blank test command is no test command")

  // -------------------------------------------------------------------------
  // The runner reaches the codex prompt from the run script, not by hand
  // -------------------------------------------------------------------------
  const script = spawnSync("grep", ["-c", "lib/test-command.py", join(root, "run-instance-codex.sh")], {
    encoding: "utf8"
  })
  assert.equal(script.status, 0, "run-instance-codex.sh derives the test command from lib/test-command.py")

  // And so does the interpreter, on both sides, from the one script that reads
  // it off the container.
  for (const runner of ["run-instance.sh", "run-instance-codex.sh"]) {
    const derived = spawnSync("grep", ["-c", "lib/interpreter.sh", join(root, runner)], { encoding: "utf8" })
    assert.equal(derived.status, 0, `${runner} derives the interpreter from lib/interpreter.sh`)
  }

  // -------------------------------------------------------------------------
  // The flows arm's host shell is a lane decision, and the ledger records it
  // -------------------------------------------------------------------------
  // The prompt tells the agent to name the testbed container, but the flows CLI
  // binds no policy that refuses a container-less `mode: "unhermetic"` call, so
  // every such call runs on the host with docker-daemon reach. The rig cannot
  // confine it; it can refuse to start an agent until the lane says so, and
  // stamp that condition beside `testbedNetwork` so no report assumes it away.
  const runInstance = (hostShell) => {
    const env = { ...process.env, SWB_DATASET: dataset }
    delete env.SWB_FLOWS_HOST_SHELL
    delete env.SWB_SKIP_AGENT
    if (hostShell !== undefined) env.SWB_FLOWS_HOST_SHELL = hostShell
    return spawnSync("bash", [join(root, "run-instance.sh"), instance.instance_id], { env, encoding: "utf8" })
  }
  for (const hostShell of [undefined, "", "confined", "yes"]) {
    const refused = runInstance(hostShell)
    assert.equal(refused.status, 2, `run-instance.sh refuses SWB_FLOWS_HOST_SHELL=${JSON.stringify(hostShell)}`)
    assert.match(refused.stdout, /SWB_FLOWS_HOST_SHELL must be 'allowed'/u)
  }
  // The codex arm defaults to `sealed` and refuses any condition it does not
  // know; `on` needs SWB_CODEX_UNCONFINED=allowed (`check-codex-lanes.mjs`).
  for (const network of ["bypass", "ON", "unconfined"]) {
    const env = { ...process.env, SWB_DATASET: dataset, SWB_TRANSPORT: "docker", SWB_CODEX_NETWORK: network }
    const refused = spawnSync("bash", [join(root, "run-instance-codex.sh"), instance.instance_id], {
      env,
      encoding: "utf8"
    })
    assert.equal(refused.status, 2, `run-instance-codex.sh refuses SWB_CODEX_NETWORK=${JSON.stringify(network)}`)
    assert.match(refused.stderr, /SWB_CODEX_NETWORK must be on, sealed or off/u)
  }
  const flowsRunner = readFileSync(join(root, "run-instance.sh"), "utf8")
  assert.match(flowsRunner, /"hostShell": "%s"/u, "run-instance.sh stamps the host-shell condition into its timings")
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

console.log("check-prompts.mjs: both harnesses are taught the same environment, and only their own tools differ.")
