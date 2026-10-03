import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { CommandsCardSchema, type CommandsViewProps } from "@smthrs/rpc/CommandsCard"
import type { CatalogTag } from "@smthrs/rpc/CardAction"
import { fixtures } from "@smthrs/rpc/fixtures/Commands"
import { CommandsContainer } from "./CommandsContainer"

const mount = (model: unknown, allowed: ReadonlySet<CatalogTag>) => {
  let props!: CommandsViewProps
  const calls: unknown[] = []
  renderToStaticMarkup(<CommandsContainer model={model} allowed={allowed} dispatch={(tag, input) => { calls.push({ tag, input }) }}
    View={value => { props = value; return null }} view={{ maximized: false }} onView={() => {}} />)
  return { props, calls }
}
test("Commands projects admitted schema fixtures without inventing actions", () => {
  for (const fixture of Object.values(fixtures)) {
    const allowed = new Set(fixture.model.groups.flatMap(group => group.commands.map(command => command.tag)))
    const h = mount(fixture.model, allowed)
    expect(CommandsCardSchema.parse(h.props.model)).toEqual(fixture.model)
    expect(h.props.actions).toEqual([])
    expect(h.props.gestures).toEqual({})
    h.props.onAction("merge")
    expect(h.calls).toEqual([])
  }
})
test("a member lacking a command sees no entry or action for it", () => {
  const h = mount(fixtures.maintainer.model, new Set(["todo.answer"]))
  expect(h.props.model.groups.flatMap(group => group.commands.map(command => command.tag))).toEqual(["todo.answer"])
  h.props.onAction("members")
  expect(h.calls).toEqual([])
  expect(mount(fixtures.maintainer.model, new Set()).props.model.groups).toEqual([])
  expect(mount(null, new Set()).props).toBeUndefined()
  expect(() => mount({}, new Set())).toThrow()
})
