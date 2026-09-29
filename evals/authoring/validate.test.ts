import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import { describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import { validateDataset } from "./validate.ts"

const row = (value: unknown): string => JSON.stringify(value)

const good = {
  messages: [
    { role: "system", content: "cheatsheet" },
    { role: "user", content: "Build a flow." },
    { role: "assistant", content: "export default Flow.make(\"demo\", {})" }
  ]
}

const withAssistant = (content: string) => ({
  messages: [good.messages[0], good.messages[1], { role: "assistant", content }]
})

const rejects = (text: string, fragment: string) => {
  const problems = validateDataset(text)
  assert.ok(
    problems.some((problem) => problem.includes(fragment)),
    `expected a problem containing ${JSON.stringify(fragment)}, got ${JSON.stringify(problems)}`
  )
}

describe("validateDataset", () => {
  test("accepts a well-formed row", () => {
    assert.deepEqual(validateDataset(row(good)), [])
  })

  test("accepts the committed dataset", () => {
    const path = fileURLToPath(new URL("./data/pilot-sft.jsonl", import.meta.url))
    assert.deepEqual(validateDataset(readFileSync(path, "utf8")), [])
  })

  test("accepts current public workspace imports in assistant code", () => {
    assert.deepEqual(validateDataset(row(withAssistant([
      'import * as AgentAction from "@smthrs/agent/AgentAction"',
      'import * as AgentEvent from "@smthrs/harness/AgentEvent"',
      'import * as Command from "@smthrs/fs/Command"',
      'export { Flow } from "@smthrs/flow"'
    ].join("\n")))), [])
  })

  test("rejects removed workspace packages and unpublished subpaths", () => {
    rejects(
      row(withAssistant('import * as AgentAction from "@smthrs/engine-harness/AgentAction"')),
      'missing workspace package'
    )
    rejects(
      row(withAssistant('import * as CellHarness from "@smthrs/harness/CellHarness"')),
      'unpublished path'
    )
    rejects(
      row(withAssistant('import {\n  AgentAction\n} from "@smthrs/engine-harness"')),
      'missing workspace package'
    )
    rejects(row(withAssistant('import "@smthrs/engine-harness"')), 'missing workspace package')
    rejects(row(withAssistant('import\n  * as Old from "@smthrs/engine-harness"')), 'missing workspace package')
    rejects(row(withAssistant('import Old = require("@smthrs/engine-harness")')), 'missing workspace package')
    rejects(row(withAssistant('const Old = await import("@smthrs/engine-harness")')), 'missing workspace package')
    rejects(row(withAssistant('import * as Private from "@smthrs/fs/internal/Secret"')), 'unpublished path')
  })

  test("checks assistant code but does not treat quoted prompts or comments as imports", () => {
    const example = 'import * as Old from "@smthrs/engine-harness/AgentAction"'
    assert.deepEqual(validateDataset(row({
      messages: [
        good.messages[0],
        { role: "user", content: `Replace ${example}` },
        { role: "assistant", content: [
          `// ${example}`,
          `/*\n${example}\n*/`,
          `const prompt = \`\n${example}\n\``,
          'export default Flow.make("demo", {})'
        ].join("\n") }
      ]
    })), [])
  })

  test("rejects a non-object row instead of crashing", () => {
    rejects("null", "row 1: not a JSON object")
    rejects("[1]", "row 1: not a JSON object")
    rejects("\"text\"", "row 1: not a JSON object")
  })

  test("rejects a non-object message instead of crashing", () => {
    rejects(row({ messages: [null, { role: "assistant", content: "x" }] }), "message 1: not a JSON object")
    rejects(row({ messages: [{ role: "user", content: "hi" }, null] }), "last message is not an \"assistant\" turn")
  })

  test("rejects a row with no user turn before the final assistant turn", () => {
    rejects(
      row({ messages: [{ role: "system", content: "s" }, { role: "assistant", content: "a" }] }),
      "no \"user\" turn before the final assistant turn"
    )
  })

  test("rejects top-level metadata that firectl would upload", () => {
    rejects(
      row({ ...good, source_path: "port.ts", role: "backtranslation" }),
      "unexpected top-level key(s) \"source_path\", \"role\""
    )
  })

  test("rejects extra message keys", () => {
    rejects(
      row({ messages: [good.messages[1], { role: "assistant", content: "a", name: "x" }] }),
      "unexpected key(s) \"name\""
    )
  })

  test("rejects absolute host paths in content", () => {
    // Split so the repository's machine-path gate does not read these as real homes.
    rejects(row(withAssistant(`Port of /${"Users"}/alice/smithers/examples/gate.jsx`)), "absolute host path")
    rejects(row(withAssistant(`see /${"home"}/bob/work`)), "absolute host path")
    rejects(row(withAssistant("see ~/Desktop/work")), "absolute host path")
    rejects(row(withAssistant("~/Desktop/fireworks-smithers-finetune/work")), "absolute host path")
    rejects(row(withAssistant(`cd "~${"bob"}/src"`)), "absolute host path")
    rejects(row(withAssistant(`C:\\${"Users"}\\alice\\src`)), "absolute host path")
  })

  test("rejects credential shapes in content", () => {
    rejects(row(withAssistant(`key = "fw_${"a".repeat(24)}"`)), "Fireworks API key")
    rejects(row(withAssistant(`sk-${"a".repeat(32)}`)), "OpenAI-style API key")
    rejects(row(withAssistant(`ghp_${"a".repeat(36)}`)), "GitHub token")
    rejects(row(withAssistant("AKIAABCDEFGHIJKLMNOP")), "AWS access key")
    rejects(row(withAssistant("-----BEGIN OPENSSH PRIVATE KEY-----")), "private key")
    rejects(row(withAssistant(`Bearer ${"eyJ"}hbGciOiJIUzI1NiJ9.${"eyJ"}zdWIiOiIxMjM0In0.${"s".repeat(22)}`)), "JSON Web Token")
  })

  test("rejects an empty dataset and unparsable rows", () => {
    rejects("\n\n", "dataset is empty")
    rejects("{", "row 1: not valid JSON")
  })
})
