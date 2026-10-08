import { expect, test } from "bun:test"
import { runSourceCommand } from "../src/run-command"

test("lifecycle card controls keep their target while launch and stop-all retain their source", () => {
  const seen: unknown[] = []
  const send = runSourceCommand("origin", (name, args) => { seen.push([name, args]) })
  send("flow.run", '{"cardId":"run-1","operation":"stop"}')
  send("flow.run", '{"cardId":"request-1","operation":"retry"}')
  send("flow.run", '{"operation":"stop-all","repo":"owner/repo"}')
  send("flow.run", '{"name":"todo","input":{"text":"keep  spaces"}}')
  send("flow.run", '{"name":"todo","sourceCard":"explicit"}')
  expect(seen).toEqual([
    ["flow.run", '{"cardId":"run-1","operation":"stop"}'],
    ["flow.run", '{"cardId":"request-1","operation":"retry"}'],
    ["flow.run", '{"operation":"stop-all","repo":"owner/repo","sourceCard":"origin"}'],
    ["flow.run", '{"name":"todo","input":{"text":"keep  spaces"},"sourceCard":"origin"}'],
    ["flow.run", '{"name":"todo","sourceCard":"explicit"}']
  ])
})
