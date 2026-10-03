/*
 * One typed way to bind an affordance to a flow.
 *
 * Every visible affordance runs a registered flow, and it says which one in
 * `data-flow`. Nobody writes that attribute by hand: `flowProps` takes a
 * `FlowName` — the union derived from the registry — so a name the registry
 * does not declare is a type error rather than a button that does nothing,
 * and the attribute's spelling lives here alone. `flowAction` adds the click.
 *
 * A name that only exists at runtime (a repository's flow leaf, a projected
 * suggestion, a toast's action) cannot be checked against the union, so it
 * goes through the `dynamic*` pair. The escape hatch is named on purpose: a
 * plain string at a call site is visible as one.
 */
import type { CatalogTag } from "@smthrs/rpc/catalog/index"
import type { FlowName } from "./FlowName"

/** The attributes that name the flow behind one affordance. */
export type FlowBindingProps = {
  readonly "data-flow": string
  readonly "data-flow-args": string | undefined
}

/** The attributes plus the click that runs the flow. */
export type FlowActionProps = FlowBindingProps & { readonly onClick: () => void }

/** Bind an affordance to a registered flow, attributes only (the element keeps its own handler). */
export const flowProps = (flow: FlowName, args?: string): FlowBindingProps => ({
  "data-flow": flow,
  "data-flow-args": args
})

/** Bind an affordance to a flow whose name is only known at runtime. */
export const dynamicFlowProps = (flow: string, args?: string): FlowBindingProps => ({
  "data-flow": flow,
  "data-flow-args": args
})

/** Bind a registry or catalog tag once; click and speculative loading share arguments. */
export const flowAction = <Name extends FlowName | CatalogTag>(
  run: (name: Name, args?: string) => unknown,
  flow: Name,
  args?: string
): FlowActionProps => ({
  "data-flow": flow,
  "data-flow-args": args,
  onClick: () => {
    run(flow, args)
  }
})

/** `flowAction` for a flow whose name is only known at runtime. */
export const dynamicFlowAction = (
  run: (name: string, args?: string) => unknown,
  flow: string,
  args?: string
): FlowActionProps => ({
  ...dynamicFlowProps(flow, args),
  onClick: () => {
    run(flow, args)
  }
})

/** Write the binding onto an element the host built itself (no JSX to spread into). */
export const applyFlow = (element: HTMLElement, flow: FlowName, args?: string): void => {
  element.dataset.flow = flow
  if (args !== undefined) element.dataset.flowArgs = args
}

/** The flow an affordance is bound to, or `undefined` when it is not an affordance. */
export const flowOf = (element: Element | null | undefined): string | undefined =>
  element?.getAttribute("data-flow") ?? undefined

/** True when this element is the affordance for exactly this registered flow. */
export const isFlowAffordance = (element: Element | null | undefined, flow: FlowName): boolean =>
  flowOf(element) === flow

/** A CSS selector matching the affordances of one registered flow. */
export const flowSelector = (flow: FlowName): string => `[data-flow="${flow}"]`

/** One delegated listener covers native buttons, library buttons, menus and suggestion pills. */
export function bindFlowPreloading(root: Document, preload: (name: string, args?: string) => Promise<void>) {
  const prepare = (event: Event) => {
    const element = (event.target as Element | null)?.closest?.("[data-flow]") as HTMLElement | null | undefined
    if (
      !element || element.matches(":disabled, [aria-disabled=true]") ||
      element.closest("[hidden], [inert], [aria-hidden=true]")
    ) return
    // Moving between a button's icon and label is still the same intent.
    const host = root.defaultView
    if (
      host && event instanceof host.MouseEvent && event.relatedTarget instanceof host.Node &&
      element.contains(event.relatedTarget)
    ) return
    void preload(element.dataset.flow!, element.dataset.flowArgs).catch(() => {})
  }
  for (const event of ["pointerover", "focusin", "pointerdown"]) root.addEventListener(event, prepare)
  return () => {
    for (const event of ["pointerover", "focusin", "pointerdown"]) root.removeEventListener(event, prepare)
  }
}

/**
 * A surface bound to two flows: the one a rest gesture runs and the one its
 * primary activation runs (the code surface's hover and definition pair).
 */
export const flowGestureProps = (flow: FlowName, activate: FlowName) => ({
  ...flowProps(flow),
  "data-flow-activate": activate
})
