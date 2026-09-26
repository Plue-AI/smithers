/**
 * Writes the fix flow the built-in harness runs on one instance.
 *
 *   node lib/write-flow.mjs <dataset.json> <instance_id> <seat> <container> <test-command> [interpreter]
 *
 * Ported from the 2026-08 benchmark rig; the dataset is addressed by path
 * instead of by a flat scratch directory, and the repository's test command is
 * supplied by the caller (see lib/test-command.py) instead of assumed to be
 * pytest.
 *
 * `SWB_TRANSPORT=plue` (lib/transport.sh) writes the sealed variant: the
 * checkout is a Smithers Cloud workspace's /testbed with no host copy, so the
 * run is sealed to it (`SMITHERS_BASH_CONTAINER`), the host file flows are not
 * offered, and every read and edit goes through `bash` in the workspace. The
 * issue, the test command, the interpreter and "How to work" are the same.
 *
 * The interpreter is the same kind of fact and comes from lib/interpreter.sh:
 * how this image runs the project's Python, read off the container at setup.
 * It is optional because a fact the harness could not measure is not stated —
 * the bullet is simply absent and the run discovers it the ordinary way.
 */
import { readFileSync } from "node:fs"

const [, , datasetPath, instanceId, seat, container, testCommand, interpreter] = process.argv
if (testCommand === undefined || testCommand.trim() === "") {
  console.error("write-flow.mjs: no test command given; see lib/test-command.py")
  process.exit(1)
}
const transport = process.env.SWB_TRANSPORT ?? "docker"
if (transport !== "docker" && transport !== "plue") {
  console.error(`write-flow.mjs: SWB_TRANSPORT must be docker or plue, got ${transport}`)
  process.exit(2)
}
const all = JSON.parse(readFileSync(datasetPath, "utf8"))
const instance = all.find((row) => row.instance_id === instanceId)
if (instance === undefined) {
  console.error(`unknown instance ${instanceId}`)
  process.exit(1)
}

// One bullet, shared byte for byte with lib/write-prompt-codex.mjs, because
// the interpreter is environment teaching and not a tool: a harness that knows
// which Python owns the repository's dependencies and a baseline that does not
// are not the same measurement. Absent when the image answered nothing usable.
const interpreterBullet = interpreter === undefined || interpreter.trim() === "" ? "" : `
- This image runs the project's Python as \`${interpreter.trim()}\`. The
  repository's dependencies are installed against that interpreter; a bare
  \`python\` or \`python3\` resolves to a different one, and importing the
  project with it fails.`

const dockerEnvironment = `Your \`bash\` flow runs on a macOS host with BSD userland. The repository's own
Linux environment and Python interpreter are in a container that has this exact
directory mounted at /testbed, so a file you change here changes there
immediately, and vice versa.

- Run anything that touches the project — imports, scripts, tests — inside the
  container, by naming it rather than by typing a docker line:

      { mode: "unhermetic", container: "${container}", cwd: "/testbed", command: "<command>" }

  For a program rather than a line, pass the program itself and let \`bash\`
  deliver it: \`{ ..., interpreter: "python3", script: "<program text>", args: [] }\`
  reaches the interpreter on standard input as data, so nothing quotes it,
  escapes it, or terminates it with a heredoc marker.
  GNU grep, GNU sed, and the project's dependencies are all available there.
  \`sed -i\` on the host is BSD sed and will not behave like GNU sed; run it
  in the container, or avoid it.${interpreterBullet}
- This repository runs its tests with \`${testCommand}\`, which takes the test
  paths to run as trailing arguments. It is the runner this project actually
  uses: other runners are not necessarily installed here.
- Git in this checkout behaves normally: \`git status\` and \`git diff\` show your
  own uncommitted edits and nothing else. This harness snapshots the working
  copy around every action, but it does so in a repository of its own, so
  nothing it writes ever appears in this checkout's history, index, or refs.
- To change a file, use the \`edit\` flow with an anchor a call just handed you:
  a \`read\`'s \`content\` is raw file text and a \`grep\` hit's \`text\` is the line
  itself, so either is an anchor exactly as it stands. \`edit\` matches those
  bytes or fails with the file's own text at the nearest region, and it answers
  with the hunk it applied. You may also anchor by a prior hit's \`startLine\`
  and \`endLine\`. Do not rewrite a whole file to change part of one: \`write\`
  replaces every byte, and a \`read\` that came back \`truncated\` is a fragment.
- \`read\`, \`grep\`, \`edit\` and \`write\` act on this directory directly and need
  no container.`

const plueEnvironment = `The repository is at /testbed in a Linux container, and your \`bash\` flow
reaches only that container. Every command names it; a command that names no
container, or another one, is refused:

      { mode: "unhermetic", container: "${container}", cwd: "/testbed", command: "<command>" }

For a program rather than a line, pass the program itself and let \`bash\`
deliver it: \`{ ..., interpreter: "python3", script: "<program text>", args: [] }\`
reaches the interpreter on standard input as data, so nothing quotes it,
escapes it, or terminates it with a heredoc marker.

- There are no file flows. Read with \`cat\` or \`sed -n\`, search with \`grep\`,
  and change a file with a script through \`bash\`: \`interpreter: "python3"\`
  with a program that replaces the exact text you read, or \`interpreter:
  "bash"\` with \`cat > /path <<'EOF' ... EOF\` for a whole new file. Read the
  region again after an edit before believing it.
- The container has no network. Everything the repository needs is already in
  it. GNU grep, GNU sed, and the project's dependencies are all available.${interpreterBullet}
- This repository runs its tests with \`${testCommand}\`, which takes the test
  paths to run as trailing arguments. It is the runner this project actually
  uses: other runners are not necessarily installed here.
- Git in this checkout behaves normally: \`git status\` and \`git diff\` show your
  own uncommitted edits and nothing else.`

const rootLine = transport === "plue"
  ? "The repository root is /testbed in the container named below."
  : "The working directory is the repository root."

// The frontmatter body is the agent's whole task. Nothing here reveals the
// gold patch, the test patch, or which tests the grader runs — only the issue
// text a maintainer would have, plus how to run this repo's interpreter.
const body = `---
description: Resolve a reported issue in this repository.
model: ${seat}
---
You are working in a checkout of ${instance.repo} at commit ${instance.base_commit}.
${rootLine}

Resolve the issue below by editing the repository's source files.

## Your environment

${transport === "plue" ? plueEnvironment : dockerEnvironment}

## How to work

Reproduce the problem first, find the responsible code, make the smallest correct
fix in the library source, and verify it by running the relevant existing tests in
the container. Do not modify tests to make them pass, and do not add new test
files. Do not commit; leave your changes in the working tree.

Always check the exit code and output of a command before believing it worked. A
command that exits non-zero did not do what you asked.

Complete only when you have applied the fix to the source files and confirmed it
by running code. When you complete, set \`output\` to a short description of the
change you made.

## Issue

${instance.problem_statement}
`

process.stdout.write(body)
