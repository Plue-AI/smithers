import { scenario } from "./coverage/types"
import { authenticatedTest } from "./auth-permissions/profile"
import { appReady, awaitBoot, closeComposer, command, expect, openComposer, reloadApp, test } from "./support/test"
import {
  decodedFramePath,
  enterCanonicalRepositoryApp,
  enterUrlApp,
  expectSameElement,
  frameLocation,
  openVehicleForm,
  FORM_VEHICLE_CARD_ID,
  FORM_VEHICLE_FIELD_TESTID
} from "./navigation-frames/cards"
import { downloadRecovery, takeDatabaseControl } from "./navigation-frames/storage"

const matrixTest = process.env.SMITHERS_REAL_E2E_MODE === undefined ? test : authenticatedTest

test("a portable form card keeps its component and unfinished value through keyboard maximize/minimize, then Cancel dismisses durably", scenario("navigation.card.identity-dismiss", {
  capabilities: [],
  coverage: [
    "action:card.maximize",
    "action:form.set",
    "action:card.maximize",
    "action:card.minimize",
    "action:card.dismiss",
    "host:local",
    "host:production",
    "path:success",
    "path:persistence",
    "path:keyboard",
    "door:slash",
    "door:button",
    "door:user-only",
    "dimension:component-identity",
    "dimension:unfinished-form-state",
    "dimension:keyboard",
    "evidence:same-dom-node-and-reload"
  ],
  description: "The provider-free form vehicle stays mounted and keeps an unfinished required field across keyboard frame transitions; its real card.dismiss Cancel persists removal."
}), async ({ page }) => {
  const marker = "navigation-identity-unsaved.md"
  const { card, input } = await openVehicleForm(page, marker, enterCanonicalRepositoryApp)
  const original = await card.elementHandle()
  await expect(card).toHaveAttribute("data-maximized", "false")

  const maximize = card.getByRole("button", { name: "Maximize card", exact: true })
  await maximize.focus()
  await maximize.press("Enter")
  await expect(card).toHaveAttribute("data-maximized", "true")
  await expect(card.getByRole("button", { name: "Restore", exact: true })).toBeFocused()
  await expect(input).toHaveValue(marker)
  await expectSameElement(card, original)

  await page.keyboard.press("Escape")
  await expect(card).toHaveAttribute("data-maximized", "false")
  await expect(maximize).toBeFocused()
  await expect(input).toHaveValue(marker)
  await expectSameElement(card, original)

  const cancel = card.getByTestId("flow-form-cancel")
  await expect(cancel).toHaveAttribute("data-flow", "card.dismiss")
  await cancel.focus()
  await cancel.press("Enter")
  await expect(card).toHaveCount(0)
  await reloadApp(page)
  await expect(page.getByTestId(FORM_VEHICLE_CARD_ID)).toHaveCount(0)
})

test("URL-pointer mode traverses browser history and restores its maximized form pointer on reload", scenario("navigation.frame.url-history-reload", {
  capabilities: [],
  coverage: [
    "action:card.maximize",
    "action:form.set",
    "action:card.maximize",
    "action:card.minimize",
    "host:local",
    "path:success",
    "path:persistence",
    "door:slash",
    "door:button",
    "dimension:url-pointer-mode",
    "dimension:deep-link",
    "dimension:browser-history",
    "evidence:url-and-sqlite-reload"
  ],
  description: "In local /w URL-pointer mode, browser back/forward and reload reconstruct the durable form frame without claiming direct frame.back or frame.forward invocation."
}), async ({ page }) => {
  const marker = "navigation-url-mode.md"
  const { card, input } = await openVehicleForm(page, marker, enterUrlApp)
  const rootUrl = page.url()
  expect(decodedFramePath(page)).toMatch(/^\/w\/workspace-main\/b\/branch-main\/f\/frame-root:branch-main$/)

  await card.getByRole("button", { name: "Maximize card", exact: true }).click()
  await expect(page).not.toHaveURL(rootUrl)
  const maximizedUrl = page.url()
  expect(maximizedUrl).not.toBe(rootUrl)
  expect(decodedFramePath(page)).toBe(`/w/workspace-main/b/branch-main/f/frame-card:branch-main:${FORM_VEHICLE_CARD_ID.replace(/^card-/, "")}`)
  await expect(card).toHaveAttribute("data-maximized", "true")

  await page.goBack()
  await expect(page).toHaveURL(rootUrl)
  await expect(card).toHaveAttribute("data-maximized", "false")
  await expect(input).toHaveValue(marker)

  await page.goForward()
  await expect(page).toHaveURL(maximizedUrl)
  await expect(card).toHaveAttribute("data-maximized", "true")
  await reloadApp(page)
  await expect(page).toHaveURL(maximizedUrl)
  await expect(card).toHaveAttribute("data-maximized", "true")
  await expect(input).toHaveValue(marker)

  await card.getByRole("button", { name: "Restore", exact: true }).click()
  await expect(page).toHaveURL(rootUrl)
  await reloadApp(page)
  await expect(card).toHaveAttribute("data-maximized", "false")
  await expect(input).toHaveValue(marker)
})

test("canonical slashless repository navigation keeps the URL fixed and persists frame pointers in history.state", scenario("navigation.frame.repo-history-state", {
  capabilities: [],
  coverage: [
    "action:card.maximize",
    "action:form.set",
    "action:card.maximize",
    "action:card.minimize",
    "host:local",
    "host:production",
    "path:success",
    "path:persistence",
    "door:slash",
    "door:button",
    "dimension:canonical-repository-url",
    "dimension:history-state",
    "dimension:browser-history",
    "evidence:fixed-url-state-and-reload"
  ],
  description: "A slashless /owner/repo entry remains exact while maximize, reload, restore, and browser traversal preserve distinct durable frame locations in history.state."
}), async ({ page }) => {
  const marker = "navigation-repo-history-state.md"
  const { card, input } = await openVehicleForm(page, marker, enterCanonicalRepositoryApp)
  const repositoryUrl = page.url()
  const root = await frameLocation(page)
  expect(root.frameId).toBe(`frame-root:${root.branchId}`)

  await card.getByRole("button", { name: "Maximize card", exact: true }).click()
  await expect(page).toHaveURL(repositoryUrl)
  await expect(card).toHaveAttribute("data-maximized", "true")
  await expect.poll(async () => (await frameLocation(page)).frameId).not.toBe(root.frameId)
  const maximized = await frameLocation(page)
  expect(maximized).toMatchObject({ workspaceId: root.workspaceId, branchId: root.branchId })
  expect(maximized.frameId).not.toBe(root.frameId)
  await expect(card).toHaveAttribute("data-maximized", "true")
  await reloadApp(page)
  await expect(page).toHaveURL(repositoryUrl)
  await expect.poll(() => frameLocation(page)).toEqual(maximized)
  await expect(card).toHaveAttribute("data-maximized", "true")
  await expect(input).toHaveValue(marker)

  await card.getByRole("button", { name: "Restore", exact: true }).click()
  await expect(page).toHaveURL(repositoryUrl)
  await expect.poll(() => frameLocation(page)).toEqual(root)
  await page.goBack()
  await expect(page).toHaveURL(repositoryUrl)
  await expect.poll(() => frameLocation(page)).toEqual(maximized)
  await expect(card).toHaveAttribute("data-maximized", "true")
  await page.goForward()
  await expect(page).toHaveURL(repositoryUrl)
  await expect.poll(() => frameLocation(page)).toEqual(root)
  await expect(card).toHaveAttribute("data-maximized", "false")
  await expect(input).toHaveValue(marker)
})

test("direct Previous frame button and frame.forward slash command traverse one real frame history", scenario("navigation.frame.direct-controls", {
  capabilities: [],
  coverage: [
    "action:card.maximize",
    "action:form.set",
    "action:card.maximize",
    "action:frame.back",
    "action:frame.forward",
    "host:local",
    "host:production",
    "path:success",
    "door:button",
    "door:slash",
    "door:user-only",
    "dimension:direct-frame-controls",
    "evidence:button-and-command-state-transition"
  ],
  description: "The maximized card's frame.back button and the registered /frame.forward command independently traverse the same real browser history entries."
}), async ({ page }) => {
  const marker = "navigation-direct-frame-controls.md"
  const { card, input } = await openVehicleForm(page, marker, enterCanonicalRepositoryApp)
  const root = await frameLocation(page)
  await card.getByRole("button", { name: "Maximize card", exact: true }).click()
  await expect(card).toHaveAttribute("data-maximized", "true")
  await expect.poll(async () => (await frameLocation(page)).frameId).not.toBe(root.frameId)
  const maximized = await frameLocation(page)

  const previous = card.getByTestId("frame-back")
  await expect(previous).toHaveAttribute("data-flow", "frame.back")
  await previous.click()
  await expect.poll(() => frameLocation(page)).toEqual(root)
  await expect(card).toHaveAttribute("data-maximized", "false")

  await command(page, "/frame.forward")
  await expect(card).toHaveAttribute("data-maximized", "true")
  await expect.poll(() => frameLocation(page)).toEqual(maximized)
  await closeComposer(page)
  await expect(input).toHaveValue(marker)
})



test("an older physical OPFS schema stamp upgrades while preserving the current durable form row", scenario("navigation.storage.opfs-schema-stamp-upgrade", {
  capabilities: [],
  coverage: [
    "action:card.maximize",
    "action:form.set",
    "host:local",
    "host:production",
    "path:success",
    "path:persistence",
    "door:slash",
    "dimension:physical-opfs-database",
    "dimension:schema-stamp-upgrade-preservation",
    "evidence:physical-metadata-and-ui-reload"
  ],
  description: "A real SQLite metadata stamp one version behind is upgraded during boot while a row written with the current schema remains visible; this does not claim arbitrary historical-row migration."
}), async ({ page, context }) => {
  const marker = "physical-opfs-schema-stamp.md"
  const opened = await openVehicleForm(page, marker, enterCanonicalRepositoryApp)
  await reloadApp(page)
  await expect(opened.input).toHaveValue(marker)

  const database = await takeDatabaseControl(page, context)
  const versionRows = await database.execute("SELECT value FROM smithers_metadata WHERE key = 'schema-version'")
  expect(versionRows).toHaveLength(1)
  const originalVersion = Number(versionRows[0]?.value)
  if (!Number.isSafeInteger(originalVersion) || originalVersion < 2) {
    throw new Error(`The isolated database cannot provide a genuine prior schema stamp: ${String(versionRows[0]?.value)}.`)
  }
  const olderVersion = String(originalVersion - 1)
  await database.execute("UPDATE smithers_metadata SET value = ? WHERE key = 'schema-version'", [olderVersion])
  expect(await database.execute("SELECT value FROM smithers_metadata WHERE key = 'schema-version'"))
    .toEqual([{ value: olderVersion }])

  const upgradedStartedAt = performance.now()
  await database.page.goto(database.appUrl)
  await awaitBoot(database.page, "navigate", upgradedStartedAt)
  await appReady(database.page)
  await expect(database.page.getByTestId(FORM_VEHICLE_CARD_ID).getByTestId(FORM_VEHICLE_FIELD_TESTID)).toHaveValue(marker)

  const upgraded = await takeDatabaseControl(database.page, context)
  expect(await upgraded.execute("SELECT value FROM smithers_metadata WHERE key = 'schema-version'"))
    .toEqual([{ value: String(originalVersion) }])
  expect(JSON.stringify(await upgraded.execute(
    "SELECT collection_id, row_key, value FROM smithers_collection_rows WHERE value LIKE ?",
    [`%${marker}%`]
  ))).toContain(marker)
})

matrixTest("a future-schema physical OPFS database fails closed, exports exact rows, and boots after its real bytes are restored", scenario("navigation.storage.opfs-failure-recovery", {
  capabilities: [],
  coverage: [
    "action:card.maximize",
    "action:form.set",
    "action:storage.recovery",
    "host:local",
    "host:production",
    "path:error",
    "path:persistence",
    "path:keyboard",
    "door:slash",
    "door:button",
    "door:user-only",
    "dimension:physical-opfs-database",
    "dimension:failure-recovery",
    "dimension:storage.recovery.export",
    "dimension:keyboard",
    "evidence:downloaded-sqlite-rows-and-healed-boot"
  ],
  description: "The shipped SQLite worker changes an isolated physical schema stamp; startup refuses, the UI exports exact rows, restoring the stamp recovers state, and the composer remains closed until opened by keyboard."
}), async ({ page, context }, testInfo) => {
  const marker = "physical-opfs-recovery.md"
  const futureVersion = "2147483647"
  const opened = await openVehicleForm(page, marker, enterCanonicalRepositoryApp)
  await reloadApp(page)
  await expect(opened.input).toHaveValue(marker)
  await command(page, "/storage.recovery")
  await expect(page.getByRole("button", { name: "Download local recovery file" })).toHaveAttribute("data-flow", "storage.recovery.export")
  await closeComposer(page)

  const database = await takeDatabaseControl(page, context)
  const markerRows = await database.execute(
    "SELECT collection_id, row_key, value FROM smithers_collection_rows WHERE value LIKE ?",
    [`%${marker}%`]
  )
  expect(JSON.stringify(markerRows)).toContain(marker)
  const versionRows = await database.execute("SELECT value FROM smithers_metadata WHERE key = 'schema-version'")
  expect(versionRows).toHaveLength(1)
  const originalVersion = versionRows[0]?.value
  if (typeof originalVersion !== "string" || originalVersion === futureVersion) {
    throw new Error(`The isolated database returned an invalid starting schema version: ${String(originalVersion)}.`)
  }

  let faultInstalled = false
  try {
    await database.execute("UPDATE smithers_metadata SET value = ? WHERE key = 'schema-version'", [futureVersion])
    faultInstalled = true
    expect(await database.execute("SELECT value FROM smithers_metadata WHERE key = 'schema-version'"))
      .toEqual([{ value: futureVersion }])

    await database.page.goto(database.appUrl)
    await expect(database.page.getByRole("heading", { name: "This browser's saved data is from a newer Smithers. Update Smithers to open it." })).toBeVisible()
    await expect(database.page.getByTestId("composer-input")).toHaveCount(0)
    await expect(database.page.locator("body")).not.toContainText(marker)

    const snapshot = await downloadRecovery(database.page, testInfo, "physical-opfs-recovery.json")
    expect(snapshot.session).toBe("unopened")
    expect(snapshot.sqlite?.find((table) => table.name === "smithers_metadata")?.rows)
      .toContainEqual([{ type: "text", value: "schema-version" }, { type: "text", value: futureVersion }])
    expect(JSON.stringify(snapshot.sqlite)).toContain(marker)
    await expect(database.page.locator("body")).not.toContainText(marker)
  } finally {
    if (faultInstalled) {
      await database.page.goto(database.controlUrl)
      await database.execute("UPDATE smithers_metadata SET value = ? WHERE key = 'schema-version'", [originalVersion])
      expect(await database.execute("SELECT value FROM smithers_metadata WHERE key = 'schema-version'"))
        .toEqual([{ value: originalVersion }])
      faultInstalled = false
    }
  }

  const recoveredStartedAt = performance.now()
  await database.page.goto(database.appUrl)
  // The composer is hidden on a booted app, and on a boot skeleton too. Boot first.
  await awaitBoot(database.page, "navigate", recoveredStartedAt)
  await appReady(database.page)
  await expect(database.page.getByTestId("composer-input")).toBeHidden()
  await expect(database.page.getByTestId(FORM_VEHICLE_CARD_ID).getByTestId(FORM_VEHICLE_FIELD_TESTID)).toHaveValue(marker)
  await openComposer(database.page)
  await expect(database.page.getByTestId("composer-input")).toBeVisible()
})
