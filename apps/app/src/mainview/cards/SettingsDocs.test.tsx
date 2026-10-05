import { expect, test } from "bun:test"
import { act } from "react"
import type { CardProps } from "@smthrs/rpc/CardAction"
import type { SettingsCard } from "@smthrs/rpc/SettingsCard"
import { createRoot } from "./views/testDom"
import { SettingsContainer } from "./SettingsContainer"
import { installFixture } from "../state/seams/InstallFixtures.test-support"

const PAGE = "quickstart#put-https-in-front"
for (const origin of ["http://mini.local:4000", "https://mini.local", "http://localhost", "http://127.0.0.1", "http://[::1]"]) {
  for (const available of [false, true]) test(`Settings docs at ${origin}, available=${available}`, async () => {
    let props!: CardProps<SettingsCard>, ready = available
    const calls: unknown[] = [], root = createRoot(document.createElement("div"))
    const snapshot = { model: installFixture() }
    await act(async () => root.render(<SettingsContainer View={value => { props = value; return null }}
      owner install={{ get: () => snapshot, subscribe: () => () => {} }} origin={origin}
      docsAvailable={() => ready} dispatch={(tag, input) => { calls.push({ tag, input }) }} view={{ maximized: false }} onView={() => {}} />))
    const action = props.actions.find(row => row.tag === "docs")
    const expected = available && origin === "http://mini.local:4000"
    expect(!!action).toBe(expected)
    if (action) {
      expect(action).toMatchObject({ label: "Notifications need HTTPS ↗", args: { page: PAGE } })
      props.onAction(action.tag, action.args)
      expect(calls).toEqual([{ tag: "docs", input: { page: PAGE } }])
      ready = false
      props.onAction(action.tag, action.args)
      expect(calls).toHaveLength(1)
    } else {
      props.onAction("docs", { page: PAGE })
      expect(calls).toEqual([])
    }
    await act(async () => root.unmount())
  })
}
test("Settings remains owner-only with docs available", async () => {
  let rendered = false
  const root = createRoot(document.createElement("div")), snapshot = { model: installFixture() }
  await act(async () => root.render(<SettingsContainer View={() => { rendered = true; return null }}
    owner={false} install={{ get: () => snapshot, subscribe: () => () => {} }} origin="http://mini.local"
    docsAvailable={() => true} dispatch={() => { throw Error("non-owner") }} view={{ maximized: false }} onView={() => {}} />))
  expect(rendered).toBe(false)
  await act(async () => root.unmount())
})
