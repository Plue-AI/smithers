import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ContextContainer, type ContextViewProps } from "./ContextContainer"

const answer = { id: "answer-1", context: [{ kind: "file" as const, label: "retry.ts", ref: "src/retry.ts", revision: "sha-1", reason: "Retries" }] }
test("missing provider, stored list or item handler stays dark", () => {
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
  expect(recorded!.items.map(({ action, ...item }) => item)).toEqual(answer.context)
  expect(recorded!.count).toBe(1)
  expect(opened).toEqual(answer.context)
  recorded!.onAction("run.inspect")
  recorded!.onAction(recorded!.items[0]!.action!.tag, recorded!.items[0]!.action!.args)
  expect(calls).toEqual([["run.inspect", { branch: "main", answer: "answer-1" }], ["file", { path: "src/retry.ts" }]])
})

test("an explicitly empty stored list still exposes Inspect, with no item actions", () => {
  let recorded: ContextViewProps | undefined
  renderToStaticMarkup(<ContextContainer branch="main" answer={{ id: "empty", context: [] }} available
    dispatch={() => {}} openItem={() => undefined} View={props => { recorded = props; return null }} />)
  expect(recorded!.count).toBe(0)
  expect(recorded!.items).toEqual([])
  expect(recorded!.actions.map(action => action.tag)).toEqual(["run.inspect"])
})

test("real ContextLine mounts when providers are available", () => {
  const html = renderToStaticMarkup(<ContextContainer branch="main" answer={answer} available
    dispatch={() => {}} openItem={item => ({ tag: "file", label: item.label, command_input: { path: item.ref } })} />)
  expect(html).toContain("Context · 1")
  expect(html).not.toContain("Inspect")
})
test("items sharing a command tag dispatch their own pinned input", () => {
  let recorded: ContextViewProps | undefined
  const calls: unknown[] = []
  renderToStaticMarkup(<ContextContainer branch="main" answer={{ id: "two", context: [answer.context[0]!,
    { ...answer.context[0]!, ref: "src/other.ts", revision: "sha-2" }] }} available
    dispatch={(tag, input) => calls.push([tag, input])}
    openItem={item => ({ tag: "file", label: item.label, command_input: { path: item.ref } })}
    View={props => { recorded = props; return null }} />)
  for (const item of [...recorded!.items].reverse()) recorded!.onAction(item.action!.tag, item.action!.args)
  expect(calls).toEqual([["file", { path: "src/other.ts" }], ["file", { path: "src/retry.ts" }]])
  expect(recorded!.actions.map(action => action.tag)).toEqual(["run.inspect"])
})
