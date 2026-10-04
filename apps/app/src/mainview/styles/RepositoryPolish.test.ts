import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll,afterEach,expect,test } from "bun:test"
import { readFileSync } from "node:fs"

GlobalRegistrator.register()
afterEach(() => { document.head.innerHTML = ""; document.body.innerHTML = ""; document.documentElement.removeAttribute("data-theme") })
afterAll(() => GlobalRegistrator.unregister())
const style = (path: string) => {
  const sheet = document.createElement("style")
  sheet.textContent = readFileSync(new URL(path, import.meta.url), "utf8")
  document.head.append(sheet)
}

for (const theme of ["light", "dark"]) {
  test(`chrome sign-in shares the ${theme} card action color without a guide shell`, () => {
    style("./tokens.css")
    style("./base.css")
    style("./chrome.css")
    document.documentElement.dataset.theme = theme
    document.body.innerHTML = '<div class="session-shell"><button class="chrome-action" data-flow="sign-in">Sign in with GitHub</button><button class="sui-button sui-button-default">Connect GitHub</button></div>'
    expect(getComputedStyle(document.querySelector(".chrome-action")!).color)
      .toBe(getComputedStyle(document.querySelector(".sui-button")!).color)
  })
}


test("account sections share a stable label column without changing other tables", () => {
  style("./cards.css")
  document.body.innerHTML = '<section class="smithers-card" data-kind="account"><table class="secrets-table"><tbody><tr><th>read:user</th><td>See your GitHub profile.</td></tr></tbody></table></section>'
  expect(getComputedStyle(document.querySelector("table")!).tableLayout).toBe("fixed")
  expect(getComputedStyle(document.querySelector("th")!).width).toBe("35%")
})

test("message copy control stays 22px when the shared kit loads last", () => {
  style("./cards.css")
  const kit = document.createElement("style")
  kit.textContent = ".sui-button-icon-size { min-height: 36px; width: 32px; padding: 0; }"
  document.head.append(kit)
  document.body.innerHTML = '<span class="message-actions"><button class="message-action sui-button-icon-size">Copy</button></span>'
  const button = getComputedStyle(document.querySelector("button")!)
  expect(button.minHeight).toBe("22px")
  expect(button.width).toBe("22px")
})

test("an unknown repository starts at the top", () => {
  style("./chat.css")
  document.body.innerHTML = '<div class="app-shell"><div class="smithers-transcript" data-repository-missing><div class="sui-chat-messages"><article>Missing</article></div></div></div>'
  expect(getComputedStyle(document.querySelector(".sui-chat-messages > article")!).marginTop).toBe("0px")
})

test("help uses an opaque surface even when its parent is translucent", () => {
  style("../HelpBubble.css")
  document.body.innerHTML = '<div style="--surface:#f7f6f1;--surface-glass:rgba(255,255,252,0.73)"><div class="help-bubble">Help</div></div>'
  expect(getComputedStyle(document.querySelector(".help-bubble")!).backgroundColor).toBe("#f7f6f1")
})

/* The bubble's ink is the theme's own text token, whichever palette is the default. */
const bubbleInk = (theme: string) => {
  style("./tokens.css")
  style("../HelpBubble.css")
  document.documentElement.dataset.theme = theme
  document.body.innerHTML = '<div class="help-bubble"><div class="help-bubble-content">Help</div></div><p style="color: var(--text)">Body</p>'
  const ink = { bubble: getComputedStyle(document.querySelector(".help-bubble")!).color, text: getComputedStyle(document.querySelector("p")!).color }
  document.head.innerHTML = ""
  return ink
}

for (const theme of ["light", "dark"]) {
  test(`a help bubble reads in ${theme} mode`, () => {
    const ink = bubbleInk(theme)
    expect(ink.text).toMatch(/^(#|rgb)/)
    expect(ink.bubble).toBe(ink.text)
  })
}

test("a help bubble's ink follows the theme", () => {
  expect(bubbleInk("light").bubble).not.toBe(bubbleInk("dark").bubble)
})
