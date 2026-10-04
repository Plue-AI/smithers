import { expect, test } from "bun:test"
import type { BrowserContext } from "@playwright/test"
import { assertKeyboardOnly, installKeyboardOnly, type KeyboardInput } from "./keyboardOnly"

// Structural Playwright doubles test interception only, never journey qualification.
function fixture() {
  let url = "http://mini.local:4000/setup?token=secret"
  const calls: string[] = []
  const action = (name: string) => (..._args: unknown[]) => { calls.push(name); return Promise.resolve() }
  const locator = {
    click: action("click"), dblclick: action("dblclick"), hover: action("hover"), tap: action("tap"),
    dragTo: action("dragTo"), check: action("check"), uncheck: action("uncheck"), setChecked: action("setChecked"),
    fill: action("fill"), selectOption: action("selectOption"), focus: action("focus"), dispatchEvent: action("dispatchEvent"),
    setInputFiles: action("setInputFiles"), press: action("press"), pressSequentially: action("pressSequentially"),
    count: () => Promise.resolve(1),
    first: () => locator, filter: () => locator, locator: () => locator, all: () => Promise.resolve([locator])
  }
  const page = {
    url: () => url, getByRole: () => locator, locator: () => locator,
    keyboard: { press: action("key.press"), type: action("key.type"), down: action("key.down"), up: action("key.up"), insertText: action("key.insertText") },
    mouse: { click: action("mouse.click"), move: action("mouse.move"), wheel: action("mouse.wheel"), down: action("mouse.down"), up: action("mouse.up") },
    touchscreen: { tap: action("touch.tap") },
    frames: () => [frame], frameLocator: () => ({ locator: () => locator }),
    waitForSelector: () => Promise.resolve(locator)
  }
  const frame = { url: () => url, getByRole: () => locator }
  let onPage: (p: typeof page) => void = () => { throw new Error("no page listener") }
  const newPage = () => ({ ...page, locator: () => ({ ...locator }) })
  const context = {
    pages: () => [page], newPage: () => Promise.resolve(newPage()),
    on: (_event: string, listener: typeof onPage) => { onPage = listener }
  }
  const log: KeyboardInput[] = []
  installKeyboardOnly(context as unknown as BrowserContext, "http://mini.local:4000", log)
  return { page, context, locator, calls, log, navigate: (next: string) => { url = next }, popup: () => { const popup = newPage(); onPage(popup); return popup } }
}

for (const name of ["click", "dblclick", "hover", "tap", "dragTo", "check", "uncheck", "setChecked", "fill", "selectOption", "focus", "dispatchEvent", "setInputFiles"] as const) {
  test(`refuses ${name} before input through chained locators`, () => {
    const f = fixture()
    const target = f.page.getByRole().filter().first()
    expect(() => target[name]("sensitive input")).toThrow("C-UI-01 keyboard guard refused")
    expect(f.calls).toEqual([])
    expect(f.log).toHaveLength(1)
    expect(f.log[0].result).toBe("refused")
    expect(JSON.stringify(f.log)).not.toContain("secret")
    expect(JSON.stringify(f.log)).not.toContain("sensitive input")
  })
}
test("allows physical keyboard methods and readback, recording no text", async () => {
  const f = fixture()
  await f.page.keyboard.press("Tab")
  await f.page.keyboard.type("secret text")
  await f.page.keyboard.down("Shift")
  await f.page.keyboard.up("Shift")
  await f.page.locator().press("Enter")
  await f.page.locator().pressSequentially("secret text")
  expect(await f.page.locator().count()).toBe(1)
  expect(f.calls).toHaveLength(6)
  expect(f.log.map(input => input.result)).toEqual(Array(6).fill("allowed"))
  expect(JSON.stringify(f.log)).not.toContain("secret")
})
for (const name of ["click", "move", "wheel", "down", "up"] as const) {
  test(`refuses mouse.${name}`, () => {
    const f = fixture()
    expect(() => f.page.mouse[name]()).toThrow("keyboard guard refused")
    expect(f.calls).toEqual([])
  })
}
test("refuses touch and insertText bypasses", () => {
  const f = fixture()
  expect(() => f.page.touchscreen.tap()).toThrow("keyboard guard refused")
  expect(() => f.page.keyboard.insertText()).toThrow("keyboard guard refused")
  expect(f.calls).toEqual([])
})
test("guards frames, frame locators, async handles and locator arrays", async () => {
  const f = fixture()
  const targets = [f.page.frames()[0].getByRole(), f.page.frameLocator().locator(), await f.page.waitForSelector(), ...(await f.page.locator().all())]
  for (const target of targets) expect(() => target.fill()).toThrow("keyboard guard refused")
  expect(f.calls).toEqual([])
})
test("new pages and popup event keep the guard; GitHub input is explicitly excluded", async () => {
  const f = fixture()
  const page = await f.context.newPage()
  const popup = f.popup()
  expect(() => popup.locator().fill()).toThrow("keyboard guard refused")
  f.log.length = 0
  f.navigate("https://github.com/login?token=secret")
  await page.locator().click()
  expect(f.calls).toEqual(["click"])
  expect(f.log[0]).toMatchObject({ origin: "https://github.com", result: "excluded" })
  f.navigate("http://mini.local:4000/")
  expect(() => page.locator().click()).toThrow("keyboard guard refused")
})
for (const url of ["https://other.invalid/", "https://github.com.attacker.invalid", "about:blank"]) {
  test(`unknown origin refuses input: ${url}`, () => {
    const f = fixture()
    f.navigate(url)
    expect(() => f.page.keyboard.press("Enter")).toThrow("keyboard guard refused")
    expect(f.calls).toEqual([])
  })
}
test("requires a bare HTTP(S) origin", () => {
  for (const origin of ["file:///tmp/app", "http://mini.local/path", "http://mini.local/?token=secret"]) {
    expect(() => installKeyboardOnly({} as BrowserContext, origin, [])).toThrow("requires an HTTP(S) origin")
  }
})

test("caught forbidden calls cannot produce accepted keyboard evidence", async () => {
  const f = fixture()
  await f.page.keyboard.press("Tab")
  expect(() => assertKeyboardOnly(f.log)).not.toThrow()
  expect(() => f.page.locator().fill()).toThrow()
  expect(() => assertKeyboardOnly(f.log)).toThrow("refused input remains")
})
test("empty or GitHub-only input cannot produce accepted keyboard evidence", async () => {
  const f = fixture()
  expect(() => assertKeyboardOnly(f.log)).toThrow("no app keyboard input")
  f.navigate("https://github.com/")
  await f.page.keyboard.press("Enter")
  expect(() => assertKeyboardOnly(f.log)).toThrow("no app keyboard input")
})
