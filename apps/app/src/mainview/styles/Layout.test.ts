import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/*
 * Source-level pins for layout defects, in the Contrast.test idiom (the
 * unit lane has no layout engine):
 *
 *  - base.css: a fixed 100vh shell with hidden overflow strands the composer
 *    under mobile browser chrome; dvh must follow the vh fallback.
 *  - cards.css: opacity-zero message actions stayed hit-testable — a touch
 *    tap in the corner landed on an invisible button. pointer-events tracks
 *    the visibility, and hover:none devices get a deliberate visible
 *    affordance.
 *  - chat.css: the 21rem nonshrinking devtools panel exceeds the 320px
 *    minimum shell width; below the panes' own 900px breakpoint it stacks.
 */

const read = (name: string): string => readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8")

const base = read("base.css")
const cards = read("cards.css")
const chat = read("chat.css")
const chrome = read("chrome.css")

describe("the shell tracks the dynamic viewport, not the chrome-inflated one", () => {
  test("body and #root declare 100dvh after the 100vh fallback", () => {
    expect(base).toMatch(/min-height:\s*100vh;\s*min-height:\s*100dvh;/)
    expect(base).toMatch(/height:\s*100vh;\s*height:\s*100dvh;/)
  })
})

describe("hidden message actions are not a touch trap", () => {
  test("opacity-zero actions take no pointer events", () => {
    const block = /\.message-actions\s*\{[^}]*\}/.exec(cards)?.[0] ?? ""
    expect(block).toContain("opacity: 0;")
    expect(block).toContain("pointer-events: none;")
  })

  test("hover and focus restore both visibility and hit-testing", () => {
    const block =
      /\.smithers-chat-message:hover \.message-actions,\s*\.message-actions:focus-within\s*\{[^}]*\}/.exec(cards)
        ?.[0] ?? ""
    expect(block).toContain("opacity: 1;")
    expect(block).toContain("pointer-events: auto;")
  })

  test("hover:none devices get the actions as a deliberate affordance", () => {
    expect(cards).toMatch(
      /@media \(hover: none\)\s*\{\s*\.message-actions\s*\{[^}]*opacity: 1;[^}]*pointer-events: auto;/
    )
  })
})

describe("the devtools panel fits the 320px minimum shell", () => {
  test("the panel stacks under the chat column at the panes' 900px breakpoint", () => {
    expect(chat).toContain("@media (max-width: 900px)")
    expect(chat).toContain(".chat-frame:has(> .devtools-panel)")
    expect(chat).toMatch(/@media \(max-width: 900px\)[\s\S]*\.devtools-panel\s*\{[^}]*width:\s*100%;/)
  })
  test("suggestion pills wrap beside an open pane instead of scrolling out of view", () => {
    expect(chat).toMatch(/\.app-shell \.smithers-suggestions\s*\{[^}]*flex-wrap:\s*wrap;/)
  })
})

describe("the slash menu overlays instead of displacing the transcript", () => {
  test("the composer anchors an absolutely positioned menu above its box", () => {
    const composer = /\.composer-wrap\s*\{[^}]*\}/.exec(chat)?.[0] ?? ""
    expect(composer).toContain("position: relative;")

    const slashMenu = /\.composer-wrap\s*>\s*\.slash-menu\s*\{[^}]*\}/.exec(chat)?.[0] ?? ""
    expect(slashMenu).toContain("position: absolute;")
    expect(slashMenu).toMatch(/z-index:\s*\d+;/)
  })

  /*
   * A long summary made flex shrink the name's box below its content; a
   * dotted name (/box.desktop.open) has no break opportunities, so
   * its text overflowed the box and painted over the description.
   */
  test("the command name never shrinks under a long summary", () => {
    const name = /\.slash-menu-name\s*\{[^}]*\}/.exec(cards)?.[0] ?? ""
    expect(name).toContain("flex-shrink: 0;")
  })
})

/*
 * The Command-K summon (the 2026-09-14 direction): the composer is a
 * floating card in a transparent layer over the content at the top of the
 * page — never docked at the bottom of the chat, never displacing the
 * transcript. The hidden attribute must beat the layer's flex display, and
 * summoned at the top, the palette drops below the box instead of opening
 * off-window.
 */
describe("the summoned composer overlays the content at the top of the page", () => {
  test("the layer is fixed and transparent; hidden really hides it", () => {
    const overlay = /^\.composer-overlay\s*\{[^}]*\}/m.exec(chat)?.[0] ?? ""
    expect(overlay).toContain("position: fixed;")
    expect(overlay).toContain("inset: 0;")
    expect(overlay).not.toContain("background")
    expect(overlay).toMatch(/z-index:\s*\d+;/)

    const hidden = /\.composer-overlay\[hidden\]\s*\{[^}]*\}/.exec(chat)?.[0] ?? ""
    expect(hidden).toContain("display: none;")
  })

  test("the palette drops below the summoned box instead of floating above it", () => {
    const menu = /\.composer-overlay \.composer-wrap > \.slash-menu\s*\{[^}]*\}/.exec(chat)?.[0] ?? ""
    expect(menu).toContain("top: calc(100% + 6px);")
    expect(menu).toContain("bottom: auto;")
  })

  test("reduced motion summons without the drop-in animation", () => {
    expect(chat).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.composer-overlay \.composer-wrap\s*\{[^}]*animation:\s*none;/)
  })
})

/*
 * will, 2026-09-02, asks 6, 7 and 8: a file card must open in a panel with a
 * reasonable max height and scroll inside it; a maximized card's left edge
 * was under the sidebar and unreadable (the sidebar is gone now — the card
 * takes the full width); and the maximized header — which carries Restore —
 * must stay visible while the body scrolls.
 */
describe("a file opens in a panel with a cap it scrolls inside (ask 6)", () => {
  test("the file panel caps at 60vh and scrolls itself", () => {
    const block = /\.world-card-panel\s*\{[^}]*\}/.exec(cards)?.[0] ?? ""
    expect(block).toContain("max-height: 60vh;")
    expect(block).toContain("overflow: auto;")
  })

  test("the panel is the one scroller: a fenced body inside it has no second cap", () => {
    expect(cards).toMatch(/\.world-card-panel pre\s*\{[^}]*max-height: none;/)
  })

  test("maximized lifts the cap, because the card is the viewport then", () => {
    expect(cards).toMatch(
      /\.smithers-card\[data-maximized="true"\] \.world-card-panel\s*\{[^}]*max-height: none;/
    )
  })
})

describe("a maximized card uses the space beside persistent chrome", () => {
  test("no chrome width variable survives the sidebar's removal", () => {
    expect(chat).not.toContain("--chrome-bar-width")
    expect(chrome).not.toContain("--chrome-bar-width")
    expect(cards).not.toContain("--chrome-bar-width")
  })

  test("the card clears the header and rail while the backdrop fills the viewport", () => {
    const card = /\.smithers-card\[data-maximized="true"\]\s*\{[^}]*\}/.exec(cards)?.[0] ?? ""
    expect(card).toContain("inset: calc(var(--session-strip, 0px) + 1.5rem) 1.5rem 8.5rem;")
    expect(card).toContain("inset-inline-start: calc(var(--chrome-rail-space, 0px) + 1.5rem);")
    expect(card).not.toMatch(/left:/)
    const backdrop = /\.card-maximize-backdrop\s*\{[^}]*\}/.exec(cards)?.[0] ?? ""
    expect(backdrop).toContain("inset: 0;")
    expect(backdrop).not.toMatch(/left:/)
  })
})

describe("the maximized card keeps Restore reachable (ask 8)", () => {
  test("the header sticks to the top of the scrolling card", () => {
    expect(cards).toMatch(
      /\.smithers-card\[data-maximized="true"\] \.smithers-card-header\s*\{[^}]*position: sticky;[^}]*top: 0;/
    )
  })
})

describe("a maximized card keeps global chrome usable", () => {
  test("navigation and Chat stay above the backdrop", () => {
    expect(cards).toMatch(
      /\.session-shell:has\(\.app-shell\[data-frame-maximized="true"\]\) \.session-navigation,[\s\S]*\.chrome-dock\s*\{[^}]*z-index: 75;[\s\S]*\.app-shell\[data-frame-maximized="true"\] \.app-chat-controls\s*\{[^}]*z-index: 75;/
    )
  })
})

describe("the shell shrinks to a phone viewport (no sideways scroll)", () => {
  test("the shell is a flex item that may shrink below its min-content width", () => {
    const shell = /\.app-shell\s*\{[^}]*\}/.exec(chat)?.[0] ?? ""
    expect(shell).toContain("min-width: 0;")
  })
})

describe("the shared card frame fits the phone column", () => {
  test("the card header may shrink, so its title shrink rule applies", () => {
    const header = /\.smithers-card-header\s*\{[^}]*\}/.exec(cards)?.[0] ?? ""
    expect(header).toContain("min-width: 0;")
  })

  test("the title truncates and metadata lives in the wrapping details row", () => {
    const title = /\.smithers-card-title\s*\{\s*flex: 0 1 auto;[^}]*\}/.exec(cards)?.[0] ?? ""
    expect(title).toContain("min-width: 0;")
    expect(title).toContain("text-overflow: ellipsis;")
    const details = /\.smithers-card-details dl\s*\{[^}]*\}/.exec(cards)?.[0] ?? ""
    expect(details).toContain("flex-wrap: wrap;")
    expect(cards).not.toContain(".smithers-card-meta")
  })

  test("a run's action pills wrap instead of running past the card edge", () => {
    const actions = /\.flow-run-actions\s*\{[^}]*\}/.exec(cards)?.[0] ?? ""
    expect(actions).toContain("flex-wrap: wrap;")
  })
})
