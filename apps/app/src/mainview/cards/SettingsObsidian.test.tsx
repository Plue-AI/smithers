import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { SettingsContainer } from "./SettingsContainer"
import { SettingsView } from "./views/SettingsView"
import { installFixture } from "../state/seams/InstallFixtures.test-support"
import type { InstallModel } from "../state/seams/InstallModel"

test("the existing Settings row receives path, sync time, refusal and the owner command", () => {
  const model: InstallModel = { ...installFixture(), wiki_sync: { obsidian: { path: "/Vault", last_sync_at: "2026-10-04T12:00:00Z", error: "Folder refused" } } }
  const install = { get: () => ({ model }), subscribe: () => () => {} }
  const html = renderToStaticMarkup(<SettingsContainer View={SettingsView} install={install} owner origin="http://localhost" dispatch={() => {}} view={{ maximized: false }} onView={() => {}} />)
  expect(html).toContain("Obsidian folder")
  expect(html).toContain('value="/Vault"')
  expect(html).toContain("2026-10-04T12:00:00Z")
  expect(html).toContain("Folder refused")
  expect(html).toContain('data-flow="settings.obsidian"')
  expect(renderToStaticMarkup(<SettingsContainer View={SettingsView} install={install} owner={false} origin="http://localhost" dispatch={() => {}} view={{ maximized: false }} onView={() => {}} />)).toBe("")
  const dark = { get: () => ({ model: installFixture() }), subscribe: () => () => {} }
  expect(renderToStaticMarkup(<SettingsContainer View={SettingsView} install={dark} owner origin="http://localhost" dispatch={() => {}} view={{ maximized: false }} onView={() => {}} />)).not.toContain("Obsidian folder")
})
