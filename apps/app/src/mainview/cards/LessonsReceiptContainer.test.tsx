import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { LessonsReceiptViewProps } from "@smthrs/rpc/ProposalCard"
import { LessonsReceiptContainer } from "./LessonsReceiptContainer"

const model = { todo: 7, lessons: [
  { title: "Retry helper", ref: "wiki:retry-helper" },
  { title: "Checks", ref: "wiki:checks" },
  { title: "Run lint", ref: "proposal:check:lint@review" },
  { title: "Data", ref: "javascript:alert(1)" }
] }
test("lessons navigate to distinct wiki and proposal subjects through catalog actions", () => {
  let props!: LessonsReceiptViewProps
  const calls: unknown[] = []
  renderToStaticMarkup(<LessonsReceiptContainer model={model} dispatch={(tag, input) => { calls.push({ tag, input }) }} View={p => { props = p; return null }} />)
  expect(props.actions).toEqual([])
  expect(Object.keys(props.gestures)).toEqual(["wiki:retry-helper", "wiki:checks", "proposal:check:lint@review"])
  for (const gesture of Object.values(props.gestures)) if (gesture) props.onAction(gesture.tag, gesture.args)
  props.onAction("learning.accept", { id: "check:lint@review" })
  expect(calls).toEqual([
    { tag: "wiki.page", input: { name: "retry-helper" } },
    { tag: "wiki.page", input: { name: "checks" } },
    { tag: "wiki", input: { operation: "proposal", id: "check:lint@review" } }
  ])
})
test("missing descriptors and invalid receipts expose no fabricated navigation", () => {
  let props!: LessonsReceiptViewProps
  renderToStaticMarkup(<LessonsReceiptContainer model={model} allowed={new Set()} dispatch={() => { throw new Error("unbound") }} View={p => { props = p; return null }} />)
  expect(props.gestures).toEqual({})
  expect(renderToStaticMarkup(<LessonsReceiptContainer model={null} dispatch={() => {}} />)).toBe("")
  expect(renderToStaticMarkup(<LessonsReceiptContainer model={{ todo: 7, lessons: [] }} dispatch={() => {}} />)).toBe("")
})
