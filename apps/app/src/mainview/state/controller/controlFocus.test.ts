import { afterAll, afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { createControlFocus } from "./controlFocus"
import type { ControlFocusController } from "./controlFocus"

GlobalRegistrator.register()
afterAll(() => GlobalRegistrator.unregister())

const cleanup: Array<() => void> = []
afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()!()
})

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/*
 * The four surfaces in one shell: a terminal tab body, a browser card, a
 * desktop card and a world card's markdown editor inside the transcript's
 * scroll-fade viewport, plus one always-outside button, a guide bubble that
 * carries the onboarding shell's own `data-controlled` flag, and a portalled
 * menu mounted outside the shell the way Radix mounts one.
 */
const setup = (): {
  readonly win: Window & typeof globalThis
  readonly doc: Document
  readonly control: ControlFocusController
  readonly shell: HTMLElement
  readonly scroller: HTMLElement
  readonly terminal: HTMLElement
  readonly textarea: HTMLTextAreaElement
  readonly tabBody: HTMLElement
  readonly browserCard: HTMLElement
  readonly browserFrame: HTMLIFrameElement
  readonly editorCard: HTMLElement
  readonly editor: HTMLElement
  readonly bubble: HTMLElement
  readonly menuItem: HTMLButtonElement
  readonly outside: HTMLButtonElement
  readonly outsideClicks: Array<string>
} => {
  const win = window
  const doc = win.document
  doc.body.innerHTML = `
    <div class="app-shell">
      <div class="sui-scroll-fade" data-fade-top="false" data-fade-bottom="true">
        <article class="guide-dialogue smithers-control" data-controlled="false">A guide bubble</article>
        <section class="smithers-card" data-testid="card-browser-1">
          <button id="card-action">Rotate session</button>
          <iframe data-control-focus-id="browser:card-1" data-control-focus-kind="browser"></iframe>
        </section>
        <section class="smithers-card" data-testid="card-world-1">
          <div data-slot="markdown-editor"><div class="ProseMirror" contenteditable="true" tabindex="0"></div></div>
        </section>
      </div>
      <div class="tab-body" data-kind="terminal">
        <div class="tab-terminal" data-control-focus-id="terminal:pty-1" data-control-focus-kind="terminal">
          <textarea class="xterm-helper-textarea"></textarea>
        </div>
      </div>
      <button id="outside">Outside</button>
    </div>
    <div data-radix-popper-content-wrapper>
      <div role="menu"><button id="menu-item">Rotate session</button></div>
    </div>`
  const control = createControlFocus(doc)
  const outside = doc.querySelector<HTMLButtonElement>("#outside")!
  const outsideClicks: Array<string> = []
  outside.addEventListener("click", () => outsideClicks.push("click"))
  outside.addEventListener("pointerup", () => outsideClicks.push("pointerup"))
  cleanup.push(() => {
    control.dispose()
    doc.body.innerHTML = ""
  })
  return {
    win,
    doc,
    control,
    shell: doc.querySelector<HTMLElement>(".app-shell")!,
    scroller: doc.querySelector<HTMLElement>(".sui-scroll-fade")!,
    terminal: doc.querySelector<HTMLElement>(".tab-terminal")!,
    textarea: doc.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!,
    tabBody: doc.querySelector<HTMLElement>(".tab-body")!,
    browserCard: doc.querySelector<HTMLElement>("[data-testid='card-browser-1']")!,
    browserFrame: doc.querySelector<HTMLIFrameElement>("[data-control-focus-id='browser:card-1']")!,
    editorCard: doc.querySelector<HTMLElement>("[data-testid='card-world-1']")!,
    editor: doc.querySelector<HTMLElement>("[data-slot='markdown-editor']")!,
    bubble: doc.querySelector<HTMLElement>(".guide-dialogue")!,
    menuItem: doc.querySelector<HTMLButtonElement>("#menu-item")!,
    outside,
    outsideClicks
  }
}

/*
 * A real gesture is trusted; `new PointerEvent(...)` is not, and the module
 * tells them apart (the press arbiter's own `element.click()` must survive).
 * Every simulated hand gesture goes through here; the synthetic-click test is
 * the one place that dispatches an untrusted event on purpose.
 */
const fire = (target: EventTarget, event: Event): void => {
  Object.defineProperty(event, "isTrusted", { value: true, configurable: true })
  target.dispatchEvent(event)
}

const pointer = (win: Window & typeof globalThis, type: string, init: PointerEventInit): PointerEvent =>
  new win.PointerEvent(type, { bubbles: true, cancelable: true, ...init })

const mouse = (win: Window & typeof globalThis, type: string, init: MouseEventInit = {}): MouseEvent =>
  new win.MouseEvent(type, { button: 0, bubbles: true, cancelable: true, ...init })

/** A full mouse press on a target: the gesture a real click is made of. */
const mouseClick = (win: Window & typeof globalThis, target: EventTarget, button = 0): void => {
  fire(target, pointer(win, "pointerdown", { button, pointerId: 1 }))
  fire(target, mouse(win, "mousedown", { button }))
  fire(target, pointer(win, "pointerup", { button, pointerId: 1 }))
  fire(target, mouse(win, "mouseup", { button }))
  if (button === 0) fire(target, mouse(win, "click", { button, detail: 1 }))
  else if (button === 2) fire(target, mouse(win, "contextmenu", { button }))
  else fire(target, mouse(win, "auxclick", { button, detail: 1 }))
}

/** A screen tap: the pointer pair, then the compat mouse tail a tap synthesizes. */
const tap = (win: Window & typeof globalThis, target: EventTarget, from = { x: 20, y: 20 }, to = from): void => {
  fire(target, pointer(win, "pointerdown", { button: 0, pointerId: 2, pointerType: "touch", clientX: from.x, clientY: from.y }))
  fire(target, pointer(win, "pointerup", { button: 0, pointerId: 2, pointerType: "touch", clientX: to.x, clientY: to.y }))
  fire(target, mouse(win, "mousedown", { clientX: to.x, clientY: to.y }))
  fire(target, mouse(win, "mouseup", { clientX: to.x, clientY: to.y }))
  fire(target, mouse(win, "click", { detail: 1, clientX: to.x, clientY: to.y }))
}

const focusIn = (win: Window & typeof globalThis, target: EventTarget): void => {
  fire(target, new win.FocusEvent("focusin", { bubbles: true, cancelable: true }))
}

const frameFocus = (win: Window & typeof globalThis, frame: HTMLIFrameElement): void => {
  frame.focus()
  win.dispatchEvent(new win.Event("blur"))
}

const key = (win: Window & typeof globalThis, init: KeyboardEventInit): void => {
  fire(win.document, new win.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }))
}

const releaseButton = (doc: Document): HTMLButtonElement | null =>
  doc.querySelector<HTMLButtonElement>("[data-control-focus-release]")

test("enter on focusin: the terminal reports control with its surface, and the ring dresses the TAB BODY", () => {
  const { control, textarea, terminal, tabBody } = setup()
  expect(control.snapshot()).toBeNull()
  focusIn(window, textarea)
  const state = control.snapshot()
  expect(state?.kind).toBe("terminal")
  expect(state?.surfaceId).toBe("terminal:pty-1")
  expect(typeof state?.since).toBe("number")
  /*
   * Blocker: the ring used to dress `.tab-terminal`, the xterm root that takes
   * the focus, so the tab's own chrome stayed dimmed around a surface the user
   * had in hand and the hole was cut at the wrong box.
   */
  expect(tabBody.getAttribute("data-control-focus")).toBe("human")
  expect(terminal.hasAttribute("data-control-focus")).toBe(false)
})

/*
 * One rule for every surface: the ring, the hole and the release affordance
 * dress the box the user perceives as the object, and `focusSurfaceHome`
 * returns focus to that same box. Detection is unchanged — the inner element
 * is still what takes focus and what names the surface.
 */
test("the box is the container, never the element that took focus", () => {
  const { win, doc, textarea, tabBody, editor, editorCard, browserFrame, browserCard } = setup()
  const dressed = (): Element | null => doc.querySelector("[data-control-focus]")

  focusIn(win, textarea)
  expect(dressed()).toBe(tabBody)
  focusIn(win, editor.querySelector(".ProseMirror")!)
  expect(dressed()).toBe(editorCard)
  frameFocus(win, browserFrame)
  expect(dressed()).toBe(browserCard)
  frameFocus(win, browserFrame)
  expect(dressed()).toBe(browserCard)
  /* And the affordance rides the same box, not the frame it belongs to. */
  expect(browserCard.contains(releaseButton(doc)!)).toBe(true)
  expect(browserFrame.contains(releaseButton(doc)!)).toBe(false)
})

/* A card opened as its own tab: the innermost box wins, so the card is dressed, not the tab around it. */
test("a card inside a tab body is dressed as the card", () => {
  const { win, doc, browserCard, browserFrame, tabBody } = setup()
  tabBody.append(browserCard)
  frameFocus(win, browserFrame)
  expect(doc.querySelector("[data-control-focus]")).toBe(browserCard)
})

/* Under neither container there is no box but the element itself; nothing is left unringed. */
test("a surface under no container falls back to the focused element", () => {
  const { win, doc, browserFrame, shell } = setup()
  shell.append(browserFrame)
  frameFocus(win, browserFrame)
  expect(doc.querySelector("[data-control-focus]")).toBe(browserFrame)
})

test("enter on focusin: the markdown editor is detected by its adapter root and the ring dresses its card", () => {
  const { control, editor, editorCard } = setup()
  focusIn(window, editor.querySelector(".ProseMirror")!)
  const state = control.snapshot()
  expect(state?.kind).toBe("editor")
  expect(state?.surfaceId).toBe("editor:card-world-1")
  expect(editorCard.getAttribute("data-control-focus")).toBe("human")
})

test("enter on window blur + activeElement === iframe: the browser card and browser frame", () => {
  const { control, browserFrame, browserCard } = setup()
  frameFocus(window, browserFrame)
  expect(control.snapshot()?.kind).toBe("browser")
  expect(control.snapshot()?.surfaceId).toBe("browser:card-1")
  expect(browserCard.getAttribute("data-control-focus")).toBe("human")
  frameFocus(window, browserFrame)
  expect(control.snapshot()?.kind).toBe("browser")
  expect(control.snapshot()?.surfaceId).toBe("browser:card-1")
  expect(browserCard.getAttribute("data-control-focus")).toBe("human")
  expect(document.querySelector(".control-focus-dim")).not.toBeNull()
})

/*
 * Blocker: the marker used to be the bare `data-controlled`, which the guide
 * shell already renders on every dialogue bubble (`data-controlled={step ===
 * stage}` — React stringifies the boolean, so even "false" matches a bare
 * attribute selector). The CSS lifted every bubble above the pinned
 * navigation. The marker is namespaced, and the stylesheet no longer carries
 * a bare `[data-controlled]` rule.
 */
test("the control marker is namespaced: guide bubbles keep data-controlled and gain nothing", () => {
  const { control, textarea, terminal, bubble } = setup()
  focusIn(window, textarea)
  expect(control.snapshot()?.kind).toBe("terminal")
  expect(terminal.hasAttribute("data-controlled")).toBe(false)
  expect(bubble.getAttribute("data-controlled")).toBe("false")
  expect(bubble.hasAttribute("data-control-focus")).toBe(false)
  const css = readFileSync(new URL("../../styles/cards.css", import.meta.url), "utf8").replaceAll(/\/\*[\s\S]*?\*\//g, "")
  expect(css.includes("[data-controlled")).toBe(false)
  expect(css.includes("[data-control-focus]")).toBe(true)
})

/*
 * Blocker: the dim used to be a ladder — one layer inside every ancestor that
 * capped z-index, plus one the shell rendered — and the layers composited over
 * each other (a real browser measured −21% against a −12% token, in three
 * banded strips). There is ONE layer now, on the body, and the surface is kept
 * out of it by a hole rather than by a z-index a trapping ancestor caps.
 */
test("the dim is ONE layer on the body, however many stacking traps wrap the surface", () => {
  const { win, doc, control, scroller, browserFrame } = setup()
  const outer = doc.createElement("div")
  outer.className = "sui-scroll-fade"
  outer.setAttribute("data-fade-top", "true")
  scroller.before(outer)
  outer.append(scroller)
  frameFocus(win, browserFrame)
  expect(control.snapshot()?.kind).toBe("browser")
  expect(doc.querySelectorAll(".control-focus-dim").length).toBe(1)
  expect(doc.querySelector(".control-focus-dim")?.parentElement).toBe(doc.body)
  /* Nothing is lifted any more: a hole needs no stacking argument at all. */
  expect(doc.querySelectorAll("[data-control-focus-host]").length).toBe(0)
  releaseButton(doc)!.click()
  expect(control.snapshot()).toBeNull()
  expect(doc.querySelectorAll(".control-focus-dim").length).toBe(0)
})

/** A layout the test DOM cannot lay out on its own: a card half-clipped by its scroller. */
const stubRect = (element: Element, rect: { top: number; right: number; bottom: number; left: number }): void => {
  element.getBoundingClientRect = () =>
    ({
      ...rect,
      x: rect.left,
      y: rect.top,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
      toJSON: () => rect
    }) as DOMRect
}

/*
 * Blocker: the hole and the release affordance both belong to what is ON
 * SCREEN. A hole cut at the card's full box would leave the scroller's
 * neighbours undimmed, and pinning the button to the box's corner put it below
 * the fold — where no pointer reached the only way out of a focused frame.
 */
test("the hole and the release affordance follow the surface's VISIBLE rect, not its box", () => {
  const { win, doc, control, scroller, browserCard, browserFrame } = setup()
  /* happy-dom reports longhands only; a real browser always resolves both. */
  scroller.style.overflowY = "auto"
  stubRect(browserCard, { top: 100, right: 400, bottom: 300, left: 100 })
  stubRect(scroller, { top: 50, right: 500, bottom: 250, left: 0 })
  frameFocus(win, browserFrame)
  expect(control.snapshot()?.kind).toBe("browser")
  const dim = doc.querySelector<HTMLElement>(".control-focus-dim")!
  /* The card shows from y=100 down to the scroller's edge at y=250, grown by the 4px ring. */
  expect(dim.style.clipPath).toContain("M96 96H404V254H96Z")
  /* And the button rides that edge — 50px up from the card's own bottom, not 6px. */
  expect(releaseButton(doc)!.style.bottom).toBe("56px")
  expect(releaseButton(doc)!.style.right).toBe("6px")
})

/*
 * Blocker: the affordance borrowed `.sui-button-ghost` + `.sui-button-sm`,
 * defined after its own rule at equal specificity, and the tutorial's
 * `.guide-shell button { font: inherit }` outranks a bare class outright — it
 * computed 16px on a transparent background with a transparent border, a label
 * rather than a control. The recipe is its own, and it outranks both honestly.
 */
test("the release affordance carries its own recipe, never the shared ghost button's", () => {
  const { win, doc, browserFrame } = setup()
  frameFocus(win, browserFrame)
  expect(releaseButton(doc)!.className).toBe("control-focus-release")
  const css = readFileSync(new URL("../../styles/cards.css", import.meta.url), "utf8").replaceAll(/\/\*[\s\S]*?\*\//g, "")
  expect(css).toContain(".control-focus-release[data-control-focus-release] {")
  expect(css.includes("\n.control-focus-release {")).toBe(false)
  for (const declaration of ["font-size: 11px", "background: var(--card)", "border: 1px solid var(--border)"]) {
    expect(css).toContain(declaration)
  }
})

test("exit on outside click: the first click only unfocuses and focus lands on the tab body, never on body", () => {
  const { win, doc, control, textarea, tabBody, outside, outsideClicks } = setup()
  focusIn(win, textarea)
  expect(control.snapshot()).not.toBeNull()
  mouseClick(win, outside)
  expect(control.snapshot()).toBeNull()
  expect(outsideClicks).toEqual([])
  expect(doc.activeElement).toBe(tabBody)
  expect(tabBody.getAttribute("tabindex")).toBe("-1")
  /* The NEXT click is a normal click, pointer tail included. */
  mouseClick(win, outside)
  expect(outsideClicks).toEqual(["pointerup", "click"])
})

test("the dismissing click on a card surface moves focus to the card section", () => {
  const { win, doc, control, browserFrame, browserCard, outside } = setup()
  frameFocus(win, browserFrame)
  mouseClick(win, outside)
  expect(control.snapshot()).toBeNull()
  expect(doc.activeElement).toBe(browserCard)
  expect(browserCard.getAttribute("tabindex")).toBe("-1")
})

/*
 * Minor: the tab stop is borrowed for one focus move. It comes off when focus
 * leaves, and the focus is taken with `preventScroll` so releasing never yanks
 * the transcript to the card.
 */
test("the borrowed tab stop comes off again, and focus is taken without scrolling", () => {
  const { win, control, textarea, tabBody, outside } = setup()
  const options: Array<FocusOptions | undefined> = []
  const native = tabBody.focus.bind(tabBody)
  tabBody.focus = (opts?: FocusOptions) => {
    options.push(opts)
    native(opts)
  }
  focusIn(win, textarea)
  mouseClick(win, outside)
  expect(control.snapshot()).toBeNull()
  expect(options).toEqual([{ preventScroll: true }])
  expect(tabBody.getAttribute("tabindex")).toBe("-1")
  outside.focus()
  expect(tabBody.hasAttribute("tabindex")).toBe(false)
})

test("a press inside the controlled surface is interaction, not dismissal", () => {
  const { win, control, browserFrame, browserCard } = setup()
  frameFocus(win, browserFrame)
  const action = browserCard.querySelector<HTMLButtonElement>("#card-action")!
  let clicks = 0
  action.addEventListener("click", () => clicks++)
  mouseClick(win, action)
  expect(control.snapshot()?.kind).toBe("browser")
  expect(clicks).toBe(1)
})

test("a drag that starts inside the surface and ends outside does not dismiss", () => {
  const { win, control, textarea, outside } = setup()
  focusIn(win, textarea)
  fire(textarea, pointer(win, "pointerdown", { button: 0, pointerId: 1 }))
  fire(outside, pointer(win, "pointerup", { button: 0, pointerId: 1 }))
  expect(control.snapshot()?.kind).toBe("terminal")
})

/*
 * Blocker: the mouse tail never consulted the recorded gesture, so selecting
 * terminal text and releasing past the edge dismissed control. The full tail a
 * browser sends — mousedown inside, pointerup/mouseup outside, and the click
 * the browser fires on the common ancestor — must leave control alone.
 */
test("a drag out of the surface with the full mouse tail does not dismiss", () => {
  const { win, control, textarea, shell, outside, outsideClicks } = setup()
  focusIn(win, textarea)
  fire(textarea, pointer(win, "pointerdown", { button: 0, pointerId: 1, clientX: 10, clientY: 10 }))
  fire(textarea, mouse(win, "mousedown", { clientX: 10, clientY: 10 }))
  fire(outside, pointer(win, "pointerup", { button: 0, pointerId: 1, clientX: 400, clientY: 300 }))
  fire(outside, mouse(win, "mouseup", { clientX: 400, clientY: 300 }))
  /* The browser fires the click on the common ancestor of press and release. */
  fire(shell, mouse(win, "click", { detail: 1 }))
  expect(control.snapshot()?.kind).toBe("terminal")
  /* The release landed on the button and was never swallowed: the drag was not a dismissal at all. */
  expect(outsideClicks).toEqual(["pointerup"])
  outsideClicks.length = 0
  /* And the gesture is over: the next click outside dismisses, exactly once. */
  mouseClick(win, outside)
  expect(control.snapshot()).toBeNull()
  expect(outsideClicks).toEqual([])
})

test("a tap dismisses and its compat click is swallowed; a cancelled pan still scrolls (no dismissal)", () => {
  const { win, control, textarea, outside, outsideClicks } = setup()
  focusIn(win, textarea)
  /* A pan the browser takes over: pointercancel, no compat tail — control survives. */
  fire(outside, pointer(win, "pointerdown", { button: 0, pointerId: 2, pointerType: "touch", clientX: 20, clientY: 20 }))
  fire(outside, pointer(win, "pointercancel", { pointerId: 2, pointerType: "touch" }))
  expect(control.snapshot()?.kind).toBe("terminal")
  /* A tap: dismissed at pointerup; the compat click never reaches the button. */
  tap(win, outside)
  expect(control.snapshot()).toBeNull()
  expect(outsideClicks).toEqual([])
  mouseClick(win, outside)
  expect(outsideClicks).toEqual(["pointerup", "click"])
})

/*
 * Major: when the app keeps the pointer, a pan ends in `pointerup`, not
 * `pointercancel`. Only a release within a finger's slop of the press is a tap.
 */
test("a touch pan that starts outside and ends in pointerup does not dismiss", () => {
  const { win, control, textarea, outside } = setup()
  focusIn(win, textarea)
  tap(win, outside, { x: 20, y: 200 }, { x: 24, y: 40 })
  expect(control.snapshot()?.kind).toBe("terminal")
})

/*
 * Blocker: the swallow was a sticky boolean only `click` could clear, and no
 * click follows a right press. The next left click was eaten whole — its
 * pointerup included, so the press arbiter never activated the button.
 */
test("a right press outside releases control without arming the swallow", () => {
  const { win, control, textarea, outside, outsideClicks } = setup()
  focusIn(win, textarea)
  mouseClick(win, outside, 2)
  expect(control.snapshot()).toBeNull()
  /* The context menu opens: its own tail was never swallowed, and no click follows it. */
  expect(outsideClicks).toEqual(["pointerup"])
  outsideClicks.length = 0
  mouseClick(win, outside)
  expect(outsideClicks).toEqual(["pointerup", "click"])
})

test("a middle press outside releases control without arming the swallow", () => {
  const { win, control, textarea, outside, outsideClicks } = setup()
  focusIn(win, textarea)
  mouseClick(win, outside, 1)
  expect(control.snapshot()).toBeNull()
  outsideClicks.length = 0
  mouseClick(win, outside)
  expect(outsideClicks).toEqual(["pointerup", "click"])
})

test("a dismissal whose click never arrives does not eat the next one", () => {
  const { win, control, textarea, outside, outsideClicks } = setup()
  focusIn(win, textarea)
  /* Pressed outside, released past the window edge: no mouseup, no click. */
  fire(outside, pointer(win, "pointerdown", { button: 0, pointerId: 1 }))
  fire(outside, mouse(win, "mousedown"))
  win.dispatchEvent(new win.Event("blur"))
  expect(control.snapshot()).toBeNull()
  mouseClick(win, outside)
  expect(outsideClicks).toEqual(["pointerup", "click"])
})

/*
 * Major: "outside" is the anchor's subtree, so a controlled card's own
 * portalled menu (Radix mounts it at the body) read as outside — the first
 * click on it did nothing and control dropped.
 */
test("a click on a portalled menu is inside: it acts and control survives", () => {
  const { win, control, browserFrame, menuItem } = setup()
  frameFocus(win, browserFrame)
  let picks = 0
  menuItem.addEventListener("click", () => picks++)
  mouseClick(win, menuItem)
  expect(control.snapshot()?.kind).toBe("browser")
  expect(picks).toBe(1)
})

/*
 * Major: the press arbiter activates a keyboard-pressed button with a
 * synthetic `element.click()`. An untrusted event is not a gesture and must
 * never be swallowed.
 */
test("a synthetic click from the press arbiter is not swallowed", () => {
  const { win, control, textarea, outside, outsideClicks } = setup()
  focusIn(win, textarea)
  outside.click()
  expect(outsideClicks).toEqual(["click"])
  expect(control.snapshot()?.kind).toBe("terminal")
})

test("the release chord takes meta or ctrl; plain Escape releases the editor only, never the terminal", () => {
  const { win, control, textarea, editor, browserFrame } = setup()
  focusIn(win, textarea)
  key(win, { key: "Escape" })
  expect(control.snapshot()?.kind).toBe("terminal")
  key(win, { key: "Escape", metaKey: true })
  expect(control.snapshot()).toBeNull()

  /* Major: the app's own chords take meta OR ctrl; the release chord matches. */
  focusIn(win, textarea)
  key(win, { key: "Escape", ctrlKey: true })
  expect(control.snapshot()).toBeNull()

  focusIn(win, editor.querySelector(".ProseMirror")!)
  expect(control.snapshot()?.kind).toBe("editor")
  key(win, { key: "Escape" })
  expect(control.snapshot()).toBeNull()

  frameFocus(win, browserFrame)
  expect(control.snapshot()?.kind).toBe("browser")
  key(win, { key: "Escape", ctrlKey: true })
  expect(control.snapshot()).toBeNull()
})

/*
 * Major: a focused cross-origin frame eats every key, so no chord can reach
 * this document. The ringed surface carries a visible, focusable "Release
 * control" button so a keyboard-only user can always get out.
 */
test("the release affordance is reachable by keyboard and releases the box", () => {
  const { win, doc, control, browserFrame, browserCard } = setup()
  frameFocus(win, browserFrame)
  const button = releaseButton(doc)!
  expect(button).not.toBeNull()
  expect(browserCard.contains(button)).toBe(true)
  expect(button.tagName).toBe("BUTTON")
  expect(button.textContent).toBe("Release control")
  /* "box", never "computer". */
  expect(button.getAttribute("aria-label")).toBe("Release control of the browser")
  expect(button.hasAttribute("disabled")).toBe(false)
  expect(button.getAttribute("tabindex")).toBeNull()
  button.focus()
  expect(doc.activeElement).toBe(button)
  /* Enter on a button reaches the arbiter, which activates it with element.click(). */
  button.click()
  expect(control.snapshot()).toBeNull()
  expect(doc.activeElement).toBe(browserCard)
  expect(releaseButton(doc)).toBeNull()
})

test("the release affordance names the terminal it is dressing", () => {
  const { win, doc, textarea, tabBody } = setup()
  focusIn(win, textarea)
  const button = releaseButton(doc)!
  expect(tabBody.contains(button)).toBe(true)
  expect(button.getAttribute("aria-label")).toBe("Release control of the terminal")
})

test("exit when the controlled surface unmounts while controlled", async () => {
  const { win, control, textarea, tabBody } = setup()
  focusIn(win, textarea)
  expect(control.snapshot()?.kind).toBe("terminal")
  tabBody.remove()
  await tick()
  expect(control.snapshot()).toBeNull()
})

/*
 * Major: watching for the unmount used to run a whole-document subtree
 * observer for as long as a surface was controlled — exactly when the app is
 * busiest. Only the ancestor chain is watched, childList alone.
 */
test("the unmount watch never observes a document-wide subtree", () => {
  const native = globalThis.MutationObserver
  const seen: Array<MutationObserverInit | undefined> = []
  class Recording extends native {
    override observe(target: Node, options?: MutationObserverInit): void {
      seen.push(options)
      super.observe(target, options)
    }
  }
  globalThis.MutationObserver = Recording as typeof MutationObserver
  cleanup.push(() => {
    globalThis.MutationObserver = native
  })
  const { win, control, textarea } = setup()
  focusIn(win, textarea)
  expect(control.snapshot()?.kind).toBe("terminal")
  expect(seen.length).toBeGreaterThan(0)
  expect(seen.some((options) => options?.subtree === true)).toBe(false)
  expect(seen.every((options) => options?.childList === true)).toBe(true)
})

test("no stuck state when switching tabs: focus moving out releases without stealing focus back", () => {
  const { doc, control, textarea, outside } = setup()
  textarea.focus()
  expect(control.snapshot()?.kind).toBe("terminal")
  outside.focus()
  expect(control.snapshot()).toBeNull()
  expect(doc.activeElement).toBe(outside)
})

/*
 * A cross-origin frame fires no focusout in this document, so tabbing out of
 * one has to be read from the arriving focus. Without it control stayed lit
 * over a surface the user had already left.
 */
test("tabbing out of a focused frame releases control without stealing focus back", () => {
  const { win, doc, control, browserFrame, outside } = setup()
  frameFocus(win, browserFrame)
  expect(control.snapshot()?.kind).toBe("browser")
  outside.focus()
  focusIn(win, outside)
  expect(control.snapshot()).toBeNull()
  expect(doc.activeElement).toBe(outside)
})

test("subscribers hear every transition", () => {
  const { win, control, textarea } = setup()
  const seen: Array<boolean> = []
  const unsubscribe = control.subscribe(() => seen.push(control.snapshot() !== null))
  cleanup.push(unsubscribe)
  focusIn(win, textarea)
  key(win, { key: "Escape", metaKey: true })
  expect(seen).toEqual([true, false])
})

test("dispose releases everything: no listeners, no state, no scoped chrome", () => {
  const { win, doc, control, scroller, browserFrame, outside, outsideClicks } = setup()
  frameFocus(win, browserFrame)
  control.dispose()
  expect(control.snapshot()).toBeNull()
  expect(scroller.hasAttribute("data-control-focus-host")).toBe(false)
  expect(releaseButton(doc)).toBeNull()
  mouseClick(win, outside)
  expect(outsideClicks).toEqual(["pointerup", "click"])
})
