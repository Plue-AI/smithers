import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ContextContainer, type ContextViewProps } from "./ContextContainer"

const answer = { id: "answer-1", context: [{ kind: "file" as const, label: "retry.ts", ref: "src/retry.ts", revision: "sha-1", reason: "Retries" }] }
test("missing provider, View, stored list or item handler stays dark", () => {
  const props = { branch: "main", available: true, answer, dispatch: () => {} }
  const View = () => <div>Context</div>
  for (const extra of [{}, { View }, { View, available: false }, { View, openItem: () => undefined },
    { View, answer: undefined, openItem: () => undefined },
    { View, answer: { id: "old" }, openItem: () => undefined }]) {
    expect(renderToStaticMarkup(<ContextContainer {...props} {...extra} />)).toBe("")
  }
})
test("recording View receives stored items and all actions dispatch through cardActions", () => {
  let recorded: ContextViewProps | undefined
  const calls: unknown[] = [], opened: unknown[] = []
  renderToStaticMarkup(<ContextContainer branch="main" answer={answer} available
    dispatch={(tag, input) => calls.push([tag, input])}
    openItem={item => { opened.push(item); return { tag: "file", label: item.label, command_input: { path: item.ref } } }}
    View={props => { recorded = props; return null }} />)
  expect(recorded!.items).toEqual(answer.context)
  expect(recorded!.count).toBe(1)
  expect(opened).toEqual(answer.context)
  recorded!.onAction("context.inspect")
  recorded!.itemBindings[0]!.onAction("file")
  expect(calls).toEqual([["context.inspect", { branch: "main", answer: "answer-1" }], ["file", { path: "src/retry.ts" }]])
})

test("an explicitly empty stored list still exposes Inspect, with no item actions", () => {
  let recorded: ContextViewProps | undefined
  renderToStaticMarkup(<ContextContainer branch="main" answer={{ id: "empty", context: [] }} available
    dispatch={() => {}} openItem={() => undefined} View={props => { recorded = props; return null }} />)
  expect(recorded!.count).toBe(0)
  expect(recorded!.items).toEqual([])
  expect(recorded!.itemBindings).toEqual([])
  expect(recorded!.actions.map(action => action.tag)).toEqual(["context.inspect"])
})
