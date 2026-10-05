import { describe, expect, test } from "vitest"
import { readFileSync } from "node:fs"
import { flowEditPrompt, flowProposalDiff, packagedTodoSource, parseFlowArgs, FlowEditInputSchema } from "../src/FlowCommands.ts"

describe("flow proposals are quoted data against the packaged TODO", () => {
  test("the source data is exactly the composition shipped with this commit", () => {
    expect(packagedTodoSource).toBe(readFileSync(new URL("../../../flows/todo/flow.ts", import.meta.url), "utf8"))
    expect(flowEditPrompt("todo", "Run make test")).toBe("Change flows/todo/flow.ts: Run make test; start from the built-in composition when no override exists")
  })
  test("a hunk quotes the changed line and no unrelated file", () => {
    const source = packagedTodoSource.replace('description: "Route, plan, implement and deliver one TODO."', 'description: "Check every TODO."')
    const patch = flowProposalDiff("todo", source)
    expect(patch).toContain('--- a/flows/todo/flow.ts\n+++ b/flows/todo/flow.ts\n')
    expect(patch).toContain('-  description: "Route, plan, implement and deliver one TODO.",\n+  description: "Check every TODO.",\n')
    expect(patch).not.toContain('Request.child')
    for (const value of [packagedTodoSource, "x", "x".repeat(16385)]) expect(() => flowProposalDiff("todo", value)).toThrow()
    expect(() => flowProposalDiff("merge", "x\n")).toThrow()
  })
  test("JSON preserves literal multiline proposals; unsafe names and malformed input are refused", () => {
    expect(parseFlowArgs("todo Run make test")).toEqual({ payload: { name: "todo", request: "Run make test" } })
    for (const name of ["../todo", "/todo", "todo\nmerge", "todo?name=merge", ""]) expect(FlowEditInputSchema.safeParse({name,request:"x"}).success).toBe(false)
    for (const raw of ["{", "{}x", "{\"name\":1}x"]) expect(parseFlowArgs(raw)).toHaveProperty("error")
  })
  test("property: applying every generated contiguous hunk reconstructs exactly the proposed source", () => {
    let seed = 17
    const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0)
    const old = packagedTodoSource.slice(0,-1).split("\n")
    for (let i = 0; i < 200; i++) {
      const at = random() % (old.length + 1), remove = Math.min(random() % 5, old.length-at)
      const inserted = Array.from({length: random()%5 + 1}, (_,n) => `// literal <script> \`${i}:${n}\` ${random()}`)
      const next = [...old.slice(0,at), ...inserted, ...old.slice(at+remove)]
      const source = next.join("\n")+"\n", patch = flowProposalDiff("todo", source)
      const [, , header, ...body] = patch.trimEnd().split("\n")
      const match = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(header!)!
      const start = Number(match[1]) - (Number(match[2]) ? 1 : 0)
      const added = body.filter(line => line.startsWith("+")).map(line=>line.slice(1))
      expect([...old.slice(0,start), ...added, ...old.slice(start+Number(match[2]))].join("\n")+"\n").toBe(source)
      expect(parseFlowArgs(JSON.stringify({name:"todo",request:"x",source}))).toEqual({payload:{name:"todo",request:"x",source}})
    }
  })
})
