/** Deterministic model inputs; the production TUI executes every cell and renders every frame. */
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
const edit = "await ctx.call(\"edit\", {path:\"math.js\",oldString:\"a - b\",newString:\"a + b\"});"
const panel = {
  id: "checks",
  title: "Checks",
  summary: "Two addition checks passed.",
  rows: [
    {
      id: "addition",
      label: "Addition",
      status: "done",
      details: [{ kind: "code", language: "javascript", code: "assert(add(2, 3) === 5)" }]
    },
    {
      id: "cases",
      label: "Test cases",
      status: "done",
      details: [{ kind: "table", columns: ["Input", "Expected"], rows: [["2 + 3", "5"], ["-2 + 3", "1"]] }]
    },
    {
      id: "diff",
      label: "math.js",
      status: "done",
      details: [{
        kind: "diff",
        path: "math.js",
        patch:
          "--- a/math.js\n+++ b/math.js\n@@ -1 +1 @@\n-export const add = (a, b) => a - b\n+export const add = (a, b) => a + b\n"
      }],
      action: { label: "Summary", action: { kind: "open", surface: "summary" } }
    }
  ]
}
const publish = (value) => `await ctx.call("ui.publish", ${JSON.stringify(value)});`
const cells = {
  basic: "ctx.done(\"Ready. Ask for a small change with a check.\");",
  edit: `${edit}ctx.done("Fixed math.js.");`,
  approval:
    `const result = await ctx.call("edit", {path:"math.js",oldString:"a - b",newString:"a + b"}); console.log(result); if (result.ok !== false) ctx.done("Edit request settled.");`,
  panels: `${publish(panel)}ctx.done("Published the checks view.");`,
  cards: `${publish({ kind: "panel", placement: "card", panel })}${
    publish({
      kind: "status",
      status: { id: "checks", text: "Checks passed", tone: "success", action: { kind: "open", surface: "ui:checks" } }
    })
  }${
    publish({
      kind: "key",
      key: { id: "review", key: "alt+r", label: "Checks", action: { kind: "open", surface: "ui:checks" } }
    })
  }ctx.done("Published the checks card.");`,
  workers:
    `if ("agent.wait" in ctx.flows) { await ctx.call("bash", {command:"sleep 5"}); ctx.done("Review complete: addition needs a + b."); } else { await ctx.call("agent.delegate", {id:"review",title:"Review addition",prompt:"Review math.js without editing it."}); ctx.done("Requested the review."); }`,
  trees:
    `if (!("agent.wait" in ctx.flows)) { await ctx.call("agent.delegate", {id:"lead",title:"Lead review",prompt:"Delegate one child check and collect its result."}); ctx.done("Requested the review tree."); } else { const tabs = await ctx.call("tab.list", {}); if (JSON.stringify(tabs).includes("Check addition")) { await ctx.call("bash", {command:"sleep 3"}); ctx.done("Addition checked."); } else { await ctx.call("agent.delegate",{id:"check",title:"Check addition",prompt:"Check the addition function."}); console.log(await ctx.call("agent.wait",{ids:["check"]})); ctx.done("Review tree complete."); } }`,
  agents:
    "console.log(await ctx.call(\"read\", {path:\"math.js\"}));ctx.done(\"Review complete: add subtracts instead of adding.\");",
  monitor:
    "const existing = await ctx.call(\"monitor.list\", {}); if (existing.some(monitor => monitor.updates > 0)) { console.log(await ctx.call(\"monitor.stop\",{id:\"checks\"})); ctx.done(\"Stopped the checks monitor.\"); } else { if (!JSON.stringify(existing).includes(\"checks\")) console.log(await ctx.call(\"monitor.create\", {id:\"checks\",title:\"Checks\",watch:\"Tell me when the check output changes.\",source:{kind:\"shell\",command:\"cat check-status.txt\"},trigger:{kind:\"interval\",seconds:10}}));ctx.done(\"Monitor request settled.\"); }",

}
export const monitorCell = cells.monitor
export const scenarioNames = [
  "basic",
  "fix-add",
  "edit",
  "approval",
  "deny",
  "panels",
  "cards",
  "workers",
  "trees",
  "agents",
  "flows",
  "flow-approval",
  "monitor",
  "monitor-refusal",
  "print",
  "slow",
  "failure",
  "models",
  "extensions"
]
export function prepare(name, { root, work, scratch }) {
  if (!scenarioNames.includes(name)) throw new Error(`Unknown scenario ${name}`)
  writeFileSync(join(work, "math.js"), "export const add = (a, b) => a - b\n")
  writeFileSync(
    join(work, "check.mjs"),
    "import { add } from \"./math.js\"\nif(add(2,3)!==5) {console.error(\"add is wrong\");process.exit(1)}\nconsole.log(\"ok\")\n"
  )
  writeFileSync(join(work, "check-status.txt"), "2 checks passed\n")
  writeFileSync(join(work, "AGENTS.md"), "Keep changes small. Run node check.mjs after editing math.js.\n")
  writeFileSync(join(work, "package.json"), "{\"type\":\"module\"}\n")
  symlinkSync(join(root, "node_modules"), join(work, "node_modules"), "dir")
  if (name === "fix-add") {
    writeFileSync(join(work, ".gitignore"), "node_modules\n.flows\n.smithers\n")
    for (
      const args of [["init", "-q"], ["add", "."], [
        "-c",
        "user.name=Docs",
        "-c",
        "user.email=docs@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "-qm",
        "Fixture"
      ]]
    ) {
      const result = spawnSync("git", args, {
        cwd: work,
        env: { PATH: process.env.PATH, HOME: scratch, GIT_CONFIG_NOSYSTEM: "1" },
        encoding: "utf8"
      })
      if (result.status !== 0) throw new Error(result.stderr)
    }
  }
  const bin = join(scratch, "bin")
  mkdirSync(bin)
  // Capture clipboard output inside the private fixture, leaving the user's clipboard untouched.
  for (const command of ["pbcopy", "xclip", "xsel", "wl-copy", "clip"]) {
    writeFileSync(join(bin, command), "#!/bin/sh\ncat > \"$HOME/clipboard.txt\"\n", { mode: 0o755 })
  }
  writeFileSync(join(bin, "docs-editor"), "#!/bin/sh\nprintf \"Review math.js and its checks.\\n\" > \"$1\"\n", {
    mode: 0o755
  })
  if (["flows", "flow-approval", "agents", "extensions"].includes(name)) {
    for (const flow of ["echo", "consequential"]) {
      const folder = join(work, "flows", flow)
      mkdirSync(folder, { recursive: true })
      writeFileSync(
        join(folder, "flow.ts"),
        readFileSync(join(root, "apps/tui/test/fixtures/flows-project/flows", flow, "flow.ts"))
      )
    }
    const folder = join(work, "flows/review")
    mkdirSync(folder, { recursive: true })
    writeFileSync(
      join(folder, "flow.mdx"),
      "---\ndescription: Review the addition function.\ncapabilities: [\"fs:read:**\"]\nflows: [read, glob, grep]\nmetadata:\n  tui:\n    keys:\n      - key: alt+r\n        label: Review\n    card: true\n    status: true\n---\nReview math.js. Report the bug without changing files.\n"
    )
  }
  const cellName = ({
    deny: "approval",
    flows: "basic",
    "flow-approval": "basic",
    "monitor-refusal": "monitor",
    slow: "basic",
    print: "basic",
    models: "basic",
    extensions: "agents"
  })[name] ?? name
  const replay = join(scratch, "model.jsonl")
  const replies = name === "failure" ?
    [{ at: 1, event: { _tag: "model-requested" } }, {
      at: 2,
      event: {
        _tag: "replay-failure",
        code: "invalid_request",
        message: "Example provider refused the model. Choose an available model and retry."
      }
    }]
    : [{ at: 1, event: { _tag: "model-requested" } }, {
      at: 2,
      event: {
        _tag: "model-delta",
        delta: { type: "text-delta", id: "answer", text: `\`\`\`cell\n${cells[cellName]}\n\`\`\`` }
      }
    }, { at: 3, event: { _tag: "model-settled", message: { stopReason: "stop" } } }]
  writeFileSync(replay, replies.map((value) => JSON.stringify(value)).join("\n"))
  return {
    replay: name === "fix-add" ? join(root, "apps/tui/test/fixtures/fix-add.jsonl") : replay,
    args: name === "print" ? ["-p", "Explain the task"] : [],
    env: {
      PATH: bin + ":" + process.env.PATH,
      EDITOR: join(bin, "docs-editor"),
      ...(name === "slow" ? { SMITHERS_TUI_REPLAY_HOLD_MS: "6000" } : {}),
      ...(["approval", "deny", "flow-approval"].includes(name)
        ? { SMITHERS_TUI_APPROVE: name === "deny" ? "deny" : "ask" }
        : {}),
      ...(name === "models" ? { OPENAI_API_KEY: "docs-fixture", ANTHROPIC_API_KEY: "docs-fixture" } : {})
    },
    // These inputs execute real flows; network results are supplied by the local fixture server.
    judge: name === "monitor"
  }
}
