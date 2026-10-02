/*
 * Control focus ("spotlight"): whenever the human is driving one surface —
 * a terminal, a browser card, a markdown editor — the rest
 * of the app dims and blurs a touch, modal-style, and the surface wears an
 * outset ring. Clicking out releases, exactly like a modal backdrop, and the
 * releasing click never activates what it landed on. Embedded surfaces keep only
 * the keyboard release affordance: no dim, elevation, or swallowed outside click.
 *
 * The state is one app-level record owned by the controller, never React
 * state and never a journal transition: it is a projection of where focus
 * physically is, changing with every focus event, so persisting it would
 * spam the journal. Components read it through `useSyncExternalStore`;
 * every surface is detected declaratively from the DOM, so this module is
 * the only authority:
 *
 *  - terminal / browser surfaces mark their interactive element
 *    with `data-control-focus-id` + `data-control-focus-kind`;
 *  - the markdown editor adapter forwards no attributes, so it is detected
 *    by its own `data-slot="markdown-editor"` root;
 *  - a cross-origin iframe takes focus without any :focus-visible signal
 *    the parent can see (CSS :focus-within and :has(iframe:focus) are all
 *    false for it), so frames are detected the probe-verified way: window
 *    blur + document.activeElement === the iframe.
 *
 * Every marker this module writes is namespaced `data-control-focus*`. The
 * bare `data-controlled` belongs to the onboarding shell, which renders it on
 * every guide bubble (`data-controlled={step === stage}`, stringified by React
 * so even "false" matches a bare attribute selector); sharing the name lifted
 * every bubble above the pinned navigation.
 */

export type ControlFocusKind = "terminal" | "browser" | "editor"

export interface ControlFocus {
  readonly surfaceId: string
  readonly kind: ControlFocusKind
  readonly since: number
}

export interface ControlFocusController {
  /** The `useSyncExternalStore` snapshot: the live record, or null. Stable until a change. */
  readonly snapshot: () => ControlFocus | null
  /** The `useSyncExternalStore` subscribe half. */
  readonly subscribe: (listener: () => void) => () => void
  readonly dispose: () => void
}

const KINDS: ReadonlyArray<ControlFocusKind> = ["terminal", "browser", "editor"]

/** What the release affordance calls each surface.  */
const NOUN: Record<ControlFocusKind, string> = {
  terminal: "terminal",
  browser: "browser",
  editor: "editor"
}

interface Detection {
  readonly element: HTMLElement
  readonly kind: ControlFocusKind
  readonly surfaceId: string
}

/*
 * The swallow listens on the WINDOW in the capture phase, which beats every
 * document-capture listener in the app (runtime/PressActions.ts,
 * SessionNavigation, the tab shortcuts) and React's root handlers.
 * `stopImmediatePropagation` means no other listener — not even another
 * window-capture one registered before us — sees the dismissing gesture.
 */
const SWALLOWED = ["mousedown", "mouseup", "click", "auxclick"] as const

/*
 * A controlled card's own menu, select or confirm dialog is portalled to the
 * body, so it renders outside the surface's subtree while belonging to it.
 * Pressing one is interaction, not dismissal: it neither releases control nor
 * loses its first click. `data-control-focus-portal` is the opt-in for a
 * portal root the list below does not already name.
 */
const PORTAL_ROOTS = [
  "[data-control-focus-portal]",
  "[data-slot='dialog-portal']",
  "[data-slot='dialog-content']",
  "[data-slot='dialog-overlay']",
  "[data-slot='select-content']",
  "[data-slot='tooltip-content']",
  "[data-radix-popper-content-wrapper]",
  "[role='dialog']",
  "[role='alertdialog']",
  "[role='menu']",
  "[role='listbox']",
  "[role='tooltip']"
].join(", ")

/** How far a finger may travel and still be a tap; past it the gesture is a pan and must scroll. */
const TAP_SLOP = 10
/** How long after a touch the browser's compat mouse tail is still that touch's, not a new press. */
const COMPAT_MS = 500
/*
 * The BOX, not the element that took focus. Will's words are "we show the box
 * it's in expand just a tad": the thing that lifts is the container the user
 * perceives as the object — the card, or the tab body for a terminal — never
 * the editor, iframe or xterm root that happens to hold the caret. Detection
 * stays on that inner element (it is what focus lands on, and what marks the
 * surface), but the ring, the hole in the dim and the release affordance all
 * dress the container, and `focusSurfaceHome` returns focus to the same box.
 *
 * Innermost wins, so a card opened as its own tab is dressed as the card, not
 * as the whole tab body around it. A surface under neither — a bare frame in
 * some future mount — falls back to the focused element, which is the only
 * box there is.
 */
const CONTAINER = ".smithers-card, .tab-body"

const containerOf = (element: HTMLElement): HTMLElement => element.closest<HTMLElement>(CONTAINER) ?? element

/** How far the release affordance sits inside the surface's visible corner. */
const RELEASE_INSET = 6
/** The ring's width when the page has no token to read (a test DOM with no stylesheet). */
const FALLBACK_OUTSET = 4

/*
 * The dim is ONE layer over the whole viewport with a hole cut where the
 * surface shows, so every pixel outside the surface is darkened exactly once
 * and the surface is not darkened at all. It replaces the earlier ladder of
 * one dim per trapping ancestor: those layers composited over each other
 * (measured −21% against a −12% token) and banded wherever an inner layer
 * stopped, because an outer dim still shows through an inner container's
 * transparent background however the two are stacked. A hole needs no
 * stacking argument at all: the layer is a child of the body, above the app's
 * own chrome, and paints nothing over the surface.
 */
interface Rect {
  readonly top: number
  readonly right: number
  readonly bottom: number
  readonly left: number
}

const intersect = (a: Rect, b: Rect): Rect => ({
  top: Math.max(a.top, b.top),
  right: Math.min(a.right, b.right),
  bottom: Math.min(a.bottom, b.bottom),
  left: Math.max(a.left, b.left)
})

const isEmpty = (rect: Rect): boolean => rect.right <= rect.left || rect.bottom <= rect.top

const outward = (rect: Rect, by: number): Rect => ({
  top: rect.top - by,
  right: rect.right + by,
  bottom: rect.bottom + by,
  left: rect.left - by
})

const boxOf = (element: Element): Rect => {
  const { top, right, bottom, left } = element.getBoundingClientRect()
  return { top, right, bottom, left }
}

const asElement = (target: EventTarget | null): Element | null =>
  target !== null && typeof (target as Element).closest === "function" ? (target as Element) : null

const detect = (target: EventTarget | null): Detection | null => {
  const element = asElement(target)
  if (element === null) return null
  const marked = element.closest<HTMLElement>("[data-control-focus-id]")
  if (marked !== null) {
    const kind = marked.getAttribute("data-control-focus-kind") ?? ""
    const surfaceId = marked.getAttribute("data-control-focus-id") ?? ""
    if (!KINDS.includes(kind as ControlFocusKind) || surfaceId === "") return null
    return { element: marked, kind: kind as ControlFocusKind, surfaceId }
  }
  const editor = element.closest<HTMLElement>("[data-slot='markdown-editor']")
  if (editor !== null) {
    const card = editor.closest("[data-testid^='card-']")
    return { element: editor, kind: "editor", surfaceId: `editor:${card?.getAttribute("data-testid") ?? "pane"}` }
  }
  return null
}

export const createControlFocus = (doc: Document | undefined): ControlFocusController => {
  let current: { readonly state: ControlFocus; readonly anchor: HTMLElement } | null = null
  const listeners = new Set<() => void>()
  /*
   * The dismissal gesture in flight, keyed to the pointer that started it: its
   * whole tail (mousedown, pointerup, mouseup, click) is swallowed, so the
   * press that dismissed never reaches the control underneath — only the NEXT
   * one does. It is never a sticky boolean waiting for a click that may never
   * come: a right press, a middle press, a release past the window edge and a
   * cancelled touch all end it, and so does the next press.
   */
  let armed: { readonly pointerId: number | null; sawMouseDown: boolean } | null = null
  /*
   * The press in flight: where it began, and whether it began inside the
   * surface — a drag that starts inside (selecting terminal text out past the
   * edge) never dismisses. It outlives the pointerup, because the mouse tail
   * that follows (mouseup, then the click the browser fires on the common
   * ancestor of press and release) has to know where the press began too.
   */
  let gesture: { readonly pointerId: number | null; readonly inside: boolean; readonly touch: boolean; readonly x: number; readonly y: number; sawMouseDown: boolean } | null = null
  /* Until when the browser's compat mouse tail still belongs to a finished touch. */
  let compatUntil = 0
  /* The one dim layer: a child of the body, with a hole cut where the surface shows. */
  let dim: HTMLDivElement | null = null
  /* Everything between the surface and the viewport that clips it, so the hole is the VISIBLE surface. */
  let clippers: Array<HTMLElement> = []
  /* The ring's painted width, so the hole clears the ring instead of dimming half of it. */
  let outset = FALLBACK_OUTSET
  /* The "Release control" button mounted beside the ringed surface while it is controlled. */
  let releaseButton: HTMLButtonElement | null = null
  /* The element we lent a tab stop to for one focus move, so it can be taken back. */
  let borrowedTabStop: HTMLElement | null = null
  let observer: MutationObserver | null = null
  let resizeObserver: ResizeObserver | null = null

  const notify = (): void => {
    for (const listener of listeners) listener()
  }

  const isInside = (target: Element | null): boolean => {
    if (target === null || current === null) return false
    return current.anchor.contains(target) || target.closest(PORTAL_ROOTS) !== null
  }

  /** A resolved overflow is never empty; only a test DOM reports one, and it clips nothing. */
  const clipsAxis = (value: string): boolean => value !== "" && value !== "visible"

  /*
   * A surface is rarely shown whole: the transcript scroller, the lesson
   * mount and the window itself each clip it. The hole and the release
   * affordance both belong to what is actually ON SCREEN, so the clipping
   * ancestors are collected once per control and re-measured on every fit.
   * A fixed surface (a maximized card) hangs off the viewport alone.
   */
  const findClippers = (anchor: HTMLElement, win: Window): Array<HTMLElement> => {
    const found: Array<HTMLElement> = []
    if (win.getComputedStyle(anchor).position === "fixed") return found
    for (let element = anchor.parentElement; element !== null && element !== win.document.body; element = element.parentElement) {
      const style = win.getComputedStyle(element)
      if (clipsAxis(style.overflowX) || clipsAxis(style.overflowY) || style.contain.includes("paint") || style.contain.includes("strict")) {
        found.push(element)
      }
    }
    return found
  }

  /** What the user can actually see of the surface: its box, clipped by every scroller and the window. */
  const visibleSurface = (anchor: HTMLElement, win: Window): Rect => {
    let rect = boxOf(anchor)
    for (const clipper of clippers) rect = intersect(rect, boxOf(clipper))
    return intersect(rect, { top: 0, right: win.innerWidth, bottom: win.innerHeight, left: 0 })
  }

  /*
   * The hole, and the affordance that rides in it. `clip-path: path(evenodd)`
   * cuts one rectangle out of the full-viewport layer: everything outside is
   * dimmed exactly once, the surface and its ring are not dimmed at all, and
   * there is no second layer anywhere to composite with. A surface scrolled
   * entirely out of view leaves the layer whole — there is nothing to spare.
   */
  const fit = (): void => {
    if (current === null || doc === undefined) return
    const win = doc.defaultView
    if (win === null) return
    const anchor = current.anchor
    const visible = visibleSurface(anchor, win)
    if (dim !== null) {
      if (isEmpty(visible)) dim.style.clipPath = "none"
      else {
        const hole = intersect(outward(visible, outset), { top: 0, right: win.innerWidth, bottom: win.innerHeight, left: 0 })
        const round = (value: number): number => Math.round(value * 100) / 100
        dim.style.clipPath =
          `path(evenodd, "M0 0H${round(win.innerWidth)}V${round(win.innerHeight)}H0Z` +
          ` M${round(hole.left)} ${round(hole.top)}H${round(hole.right)}V${round(hole.bottom)}H${round(hole.left)}Z")`
      }
    }
    if (releaseButton === null) return
    /*
     * The affordance is the only way out of a focused cross-origin frame, so
     * it is pinned to the surface's VISIBLE corner, not to the box's: a card
     * taller than its scroller used to carry the button below the fold, where
     * `elementFromPoint` found the scroller instead and no pointer could ever
     * reach it. Offsets are measured from the anchor's padding box, which is
     * what `right`/`bottom` resolve against.
     */
    const box = boxOf(anchor)
    const style = win.getComputedStyle(anchor)
    const padRight = box.right - (Number.parseFloat(style.borderRightWidth) || 0)
    const padBottom = box.bottom - (Number.parseFloat(style.borderBottomWidth) || 0)
    const edge = isEmpty(visible) ? intersect(box, { top: 0, right: win.innerWidth, bottom: win.innerHeight, left: 0 }) : visible
    if (isEmpty(edge)) return
    const width = releaseButton.offsetWidth
    const height = releaseButton.offsetHeight
    /*
     * Reachability is a property of the CENTRE, because that is where a
     * pointer — and `elementFromPoint` — lands. The corner placement is the
     * want; the clamp is the guarantee, and it matters: a sliver of card
     * shorter than the button itself still has a hittable middle row, and
     * without the clamp the button's centre sat one pixel past the scroller's
     * edge and the hit test returned the lesson behind it.
     */
    const centred = (low: number, high: number, wanted: number): number => Math.min(Math.max(wanted, low + 1), high - 1)
    const centreX = centred(edge.left, edge.right, edge.right - RELEASE_INSET - width / 2)
    const centreY = centred(edge.top, edge.bottom, edge.bottom - RELEASE_INSET - height / 2)
    releaseButton.style.right = `${Math.round(padRight - (centreX + width / 2))}px`
    releaseButton.style.bottom = `${Math.round(padBottom - (centreY + height / 2))}px`
  }

  const clearDim = (): void => {
    dim?.remove()
    dim = null
    clippers = []
  }

  /*
   * The tab stop is borrowed, not granted: an element that had none gets
   * `tabindex="-1"` only for as long as it holds this focus, so releasing
   * never leaves a stray programmatic focus target behind in the transcript.
   */
  const dropBorrowedTabStop = (): void => {
    if (borrowedTabStop === null) return
    borrowedTabStop.removeAttribute("tabindex")
    borrowedTabStop.removeEventListener("focusout", onBorrowerFocusOut)
    borrowedTabStop = null
  }

  /* Only the borrower's own focusout ends the loan; a descendant's (the frame it holds) bubbles through it. */
  const onBorrowerFocusOut = (event: Event): void => {
    if (event.target === borrowedTabStop) dropBorrowedTabStop()
  }

  const focusSurfaceHome = (anchor: HTMLElement): void => {
    /*
     * Focus goes back to the same box the ring dressed — never to body:
     * ChatCards.tsx records that focus on body breaks the shell's Escape.
     * `preventScroll` keeps the release from yanking the transcript to the
     * card the user was already looking at.
     */
    const target = containerOf(anchor)
    if (!target.hasAttribute("tabindex")) {
      dropBorrowedTabStop()
      borrowedTabStop = target
      target.setAttribute("tabindex", "-1")
      target.addEventListener("focusout", onBorrowerFocusOut)
    }
    target.focus({ preventScroll: true })
  }

  const clear = (refocus: boolean): void => {
    if (current === null) return
    const { anchor } = current
    current = null
    anchor.removeAttribute("data-control-focus")
    releaseButton?.remove()
    releaseButton = null
    clearDim()
    observer?.disconnect()
    observer = null
    resizeObserver?.disconnect()
    resizeObserver = null
    notify()
    if (refocus) focusSurfaceHome(anchor)
  }

  /*
   * A focused cross-origin frame consumes every key, so no chord can reach
   * this document, and xterm swallows Tab. Keyboard-only operation is a
   * product rule (apps/app/AGENTS.md), so the ring carries its own way out: a
   * small, quiet button in the surface's own corner, reachable by Tab and
   * activated by Enter like any other button.
   */
  const mountReleaseButton = (anchor: HTMLElement, kind: ControlFocusKind): void => {
    if (doc === undefined) return
    const button = doc.createElement("button")
    button.type = "button"
    /*
     * Its own recipe, never the shared ghost one: `.sui-button-ghost` and
     * `.sui-button-sm` are defined after this rule at equal specificity and
     * the tutorial's `.guide-shell button { font: inherit }` outranks a bare
     * class outright, so the affordance shipped at 16px with a transparent
     * background and border — a label, not a control, and illegible over a
     * terminal. The stylesheet pairs the class with the marker attribute to
     * outrank both honestly.
     */
    button.className = "control-focus-release"
    button.setAttribute("data-control-focus-release", "")
    button.setAttribute("aria-label", `Release control of the ${NOUN[kind]}`)
    button.textContent = "Release control"
    button.addEventListener("click", (event) => {
      event.preventDefault()
      event.stopPropagation()
      clear(true)
    })
    anchor.append(button)
    releaseButton = button
  }

  /*
   * A surface that unmounts while controlled releases silently — there is
   * nowhere to return focus to. The watch is childList on the anchor's own
   * ancestor chain, never a document-wide subtree: removing the anchor, or any
   * ancestor, is a childList mutation on that node's parent, so this sees
   * every unmount without the whole document's traffic running through a
   * callback for as long as a surface is controlled.
   */
  const watchForUnmount = (anchor: HTMLElement): void => {
    observer = new MutationObserver(() => {
      if (current !== null && !current.anchor.isConnected) clear(false)
    })
    for (let element = anchor.parentElement; element !== null; element = element.parentElement) {
      observer.observe(element, { childList: true })
    }
  }

  const enter = (detection: Detection): void => {
    if (current?.state.surfaceId === detection.surfaceId) return
    clear(false)
    /*
     * The ring dresses the BOX the surface sits in — the card for a card
     * surface, the tab body for a terminal — never the inner element focus
     * landed on. A terminal used to be ringed at its xterm root, so the tab's
     * own chrome stayed dimmed around a surface the user had in hand.
     */
    const anchor = containerOf(detection.element)
    current = { state: { surfaceId: detection.surfaceId, kind: detection.kind, since: Date.now() }, anchor }
    anchor.setAttribute("data-control-focus", "human")
    const win = doc?.defaultView ?? null
    if (doc !== undefined && win !== null) {
      /*
       * The dim is a child of the BODY, never of the app shell: in the
       * tutorial the shell is mounted inside `.guide-app`, which is
       * `opacity: 0` until the workspace step, so a layer rendered there
       * painted nothing at all and the window's top strip stayed bright.
       * From the body it covers the whole viewport, over the app's own
       * chrome, and the hole is what keeps the surface out of it.
       */
      clippers = findClippers(anchor, win)
      outset = Number.parseFloat(win.getComputedStyle(anchor).getPropertyValue("--control-focus-outset"))
      if (!Number.isFinite(outset)) outset = FALLBACK_OUTSET

        dim = doc.createElement("div")
        dim.className = "control-focus-dim"
        dim.setAttribute("aria-hidden", "true")
        doc.body.append(dim)
      
      mountReleaseButton(anchor, detection.kind)
      fit()
      /*
       * The hole tracks the surface: a pane opening, a breakpoint change or a
       * wheel over the dimmed transcript all move it. Scroll is watched in
       * the capture phase because a scroller's own scroll event never bubbles.
       */
      if (typeof win.ResizeObserver === "function") {
        resizeObserver = new win.ResizeObserver(() => fit())
        for (const element of [anchor, anchor.parentElement, ...clippers]) {
          if (element !== null) resizeObserver.observe(element)
        }
      }
      watchForUnmount(anchor)
    }
    notify()
  }

  const onFocusIn = (event: Event): void => {
    const detection = detect(event.target)
    if (detection !== null) {
      enter(detection)
      return
    }
    if (current === null) return
    if (isInside(asElement(event.target))) return
    /*
     * Focus arrived somewhere else entirely. A cross-origin frame fires no
     * focusout in this document, so tabbing out of one is only visible as the
     * focus that arrives; without this, control stayed lit over a surface the
     * user had already left. Release without stealing focus back.
     */
    clear(false)
  }

  const onFocusOut = (event: FocusEvent): void => {
    if (current === null) return
    if (isInside(asElement(event.relatedTarget))) return
    /* Focus left the surface (⌘K, a tab shortcut, a programmatic move): release without stealing focus back. */
    clear(false)
  }

  const onWindowBlur = (): void => {
    /* Whatever gesture was in flight cannot finish now: never leave the swallow armed for the next click. */
    armed = null
    const active = doc?.activeElement ?? null
    if (active === null || active.tagName !== "IFRAME") return
    const detection = detect(active)
    if (detection !== null) enter(detection)
  }

  const eat = (event: Event): void => {
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  const now = (): number => Date.now()

  /** The compat mouse tail a finished touch synthesizes is that touch's, never a new press. */
  const compatTail = (): boolean => now() < compatUntil

  const onPointerDown = (event: PointerEvent): void => {
    /* A fresh press ends any gesture still armed: whatever tail was expected never arrived. */
    armed = null
    gesture = null
    /* Only a real gesture dismisses; the press arbiter's own synthetic events are not the user's hand. */
    if (!event.isTrusted || current === null) return
    const target = asElement(event.target)
    const inside = isInside(target)

    gesture = { pointerId: event.pointerId, inside, touch: event.pointerType === "touch", x: event.clientX, y: event.clientY, sawMouseDown: false }
    if (inside) return
    /*
     * A touch is decided at pointerup: a tap dismisses, but a pan must still
     * scroll the dimmed content, so the pointerdown itself is left alone.
     */
    if (gesture.touch) return
    if (event.button !== 0) {
      /* A right or middle press releases, but arms nothing: no click follows it to disarm the swallow. */
      clear(true)
      return
    }
    eat(event)
    armed = { pointerId: event.pointerId, sawMouseDown: false }
    clear(true)
  }

  const onPointerUp = (event: PointerEvent): void => {
    const held = gesture
    if (held !== null && held.touch) compatUntil = now() + COMPAT_MS
    if (armed !== null) {
      if (armed.pointerId === null || armed.pointerId === event.pointerId) {
        /* The dismissing press's release belongs to the swallowed gesture: the press arbiter must not see it. */
        eat(event)
        return
      }
      armed = null
    }
    if (!event.isTrusted || current === null) return
    if (held === null || held.pointerId !== event.pointerId || held.inside || !held.touch) return
    /*
     * A touch release is a tap only within a finger's slop of where it began.
     * Past that it was a pan — the app kept the pointer and delivered
     * pointerup rather than pointercancel — and a pan must scroll, not dismiss.
     */
    if (Math.hypot(event.clientX - held.x, event.clientY - held.y) > TAP_SLOP) return
    eat(event)
    armed = { pointerId: event.pointerId, sawMouseDown: false }
    clear(true)
  }

  const onPointerCancel = (): void => {
    if (gesture !== null && gesture.touch) compatUntil = now() + COMPAT_MS
    gesture = null
    armed = null
  }

  /* No click follows a right press, so the context menu is where that gesture ends. */
  const onContextMenu = (): void => {
    armed = null
  }

  const onGestureTail = (event: MouseEvent): void => {
    if (armed !== null) {
      if (event.type !== "mousedown") {
        eat(event)
        if (event.type === "click" || event.type === "auxclick") armed = null
        return
      }
      if (!armed.sawMouseDown) {
        armed.sawMouseDown = true
        eat(event)
        return
      }
      /* A second press with the first still armed: that gesture is over, let this one through. */
      armed = null
    }
    if (!event.isTrusted || current === null || compatTail()) return
    const target = asElement(event.target)
    const inside = isInside(target)

    let held = gesture
    if (event.type === "mousedown") {
      if (held !== null && !held.sawMouseDown) {
        /* This press's own pointerdown already decided it: inside, a touch, or a dismissal. */
        held.sawMouseDown = true
        return
      }
      /* A mouse path with no pointer events at all still records where the press began. */
      held = { pointerId: null, inside, touch: false, x: event.clientX, y: event.clientY, sawMouseDown: true }
      gesture = held
    }
    if (event.type === "click" || event.type === "auxclick") gesture = null
    /*
     * The press began inside the surface: this is a drag out of it (selecting
     * terminal text past the edge), never a dismissal. The pointer path always
     * guarded this; the mouse tail did not, and released on every such drag.
     */
    if (held !== null && held.inside) return
    if (inside) return
    if (event.button !== 0) {
      clear(true)
      return
    }
    eat(event)
    armed = { pointerId: null, sawMouseDown: event.type === "mousedown" }
    clear(true)
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (current === null || event.key !== "Escape") return
    /*
     * Meta-Escape (or Ctrl-Escape: the app's own chords take either) is the
     * release chord. Plain Escape releases only the editor: a terminal cancels
     * Escape itself and a cross-origin frame never lets any key reach this
     * document at all — that surface is released with the ring's own
     * "Release control" button.
     */
    if (!event.metaKey && !event.ctrlKey && current.state.kind !== "editor") return
    eat(event)
    clear(true)
  }

  /* `fit` is a no-op while nothing is controlled, so both listeners can live for the controller's life. */
  const onReflow = (): void => fit()

  const win = doc?.defaultView ?? null
  if (doc !== undefined && win !== null) {
    /*
     * Every listener rides the WINDOW's capture phase: window capture runs
     * before the document-capture listeners the rest of the app installed
     * (runtime/PressActions.ts, SessionNavigation, the tab shortcuts), so
     * the dismissing gesture is gone before any of them could see it.
     */
    win.addEventListener("focusin", onFocusIn, true)
    win.addEventListener("focusout", onFocusOut, true)
    win.addEventListener("pointerdown", onPointerDown, true)
    win.addEventListener("pointerup", onPointerUp, true)
    win.addEventListener("pointercancel", onPointerCancel, true)
    win.addEventListener("contextmenu", onContextMenu, true)
    for (const type of SWALLOWED) win.addEventListener(type, onGestureTail as EventListener, true)
    win.addEventListener("keydown", onKeyDown, true)
    win.addEventListener("blur", onWindowBlur)
    win.addEventListener("resize", onReflow)
    /* A scroller's own scroll never bubbles, so the hole follows the surface from the capture phase. */
    win.addEventListener("scroll", onReflow, { capture: true, passive: true })
  }

  return {
    snapshot: () => current?.state ?? null,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose: () => {
      clear(false)
      dropBorrowedTabStop()
      armed = null
      gesture = null
      if (doc !== undefined && win !== null) {
        win.removeEventListener("focusin", onFocusIn, true)
        win.removeEventListener("focusout", onFocusOut, true)
        win.removeEventListener("pointerdown", onPointerDown, true)
        win.removeEventListener("pointerup", onPointerUp, true)
        win.removeEventListener("pointercancel", onPointerCancel, true)
        win.removeEventListener("contextmenu", onContextMenu, true)
        for (const type of SWALLOWED) win.removeEventListener(type, onGestureTail as EventListener, true)
        win.removeEventListener("keydown", onKeyDown, true)
        win.removeEventListener("blur", onWindowBlur)
        win.removeEventListener("resize", onReflow)
        win.removeEventListener("scroll", onReflow, true)
      }
    }
  }
}
