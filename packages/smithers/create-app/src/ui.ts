/**
 * Panes and cards: the UI a flow or an agent can put on screen.
 *
 * A pane is a React component named by file location: `app/panes/<name>.tsx`
 * exports `Pane`, built by {@link definePane}. The agent renders one with
 * `ctx.call("ui/pane", { name, props })` and the shell embeds it as a card in
 * the transcript, offering a maximize control only when the pane declares
 * `fullscreen`; the wire card's flag does not restrict that capability. A pane
 * is always embedded first. Maximizing presents the same mounted component in
 * an overlay, preserving local state. Context changes may render it again.
 *
 * Cards are the transcript's data model. Every kind here is app-owned.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"
import type { ReactNode } from "react"

/**
 * What the shell tells a pane about its own presentation.
 *
 * @category models
 * @since 0.1.0
 */
export interface PaneContext {
  readonly fullscreen: boolean
  readonly maximize: () => void
  readonly restore: () => void
}

/**
 * A pane with its props type erased, which is what a registry holds.
 *
 * The erased half is `renderUnknown` rather than `render`, because props reach
 * the shell as `unknown` over the wire: a heterogeneous registry cannot hand
 * back a typed renderer, and decoding is the pane's own schema's job either
 * way.
 *
 * @category models
 * @since 0.1.0
 */
export interface AnyPaneDefinition {
  readonly _tag: "PaneDefinition"
  readonly title?: string
  /** Whether the shell offers a fullscreen presentation. */
  readonly fullscreen: boolean
  /**
   * Decodes wire props with the pane's schema and renders them. Throws the
   * schema's own error when the props are rejected, which is what lets a shell
   * show the message in place of the pane.
   */
  readonly renderUnknown: (props: unknown, context: PaneContext) => ReactNode
}

/**
 * One pane: a props schema and a render function over the decoded props.
 *
 * @category models
 * @since 0.1.0
 */
export interface PaneDefinition<P> extends AnyPaneDefinition {
  readonly props: Schema.Codec<P, unknown>
  readonly render: (props: P, context: PaneContext) => ReactNode
}

/**
 * Declares the `Pane` export of an `app/panes/<name>.tsx` file.
 *
 * @example
 * ```tsx
 * import { definePane } from "@smthrs/create-app/ui"
 * import * as Schema from "effect/Schema"
 *
 * export const Pane = definePane({
 *   props: Schema.Struct({ address: Schema.String, wei: Schema.String }),
 *   title: "Balance",
 *   render: ({ address, wei }) => <dl><dt>{address}</dt><dd>{wei}</dd></dl>
 * })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const definePane = <P>(options: {
  readonly props: Schema.Codec<P, unknown>
  readonly title?: string
  readonly fullscreen?: boolean
  readonly render: (props: P, context: PaneContext) => ReactNode
}): PaneDefinition<P> => {
  const decode = Schema.decodeUnknownSync(options.props)
  return {
    _tag: "PaneDefinition",
    props: options.props,
    fullscreen: options.fullscreen ?? false,
    render: options.render,
    renderUnknown: (props, context) => options.render(decode(props), context),
    ...(options.title === undefined ? {} : { title: options.title })
  }
}

/**
 * The registry the shell builds from `routes.ui.gen.ts`: pane name to
 * definition. A name the app does not route is `undefined`, not an error, so
 * an agent asking for a pane that was deleted renders a message.
 *
 * @category models
 * @since 0.1.0
 */
export type PaneRegistry = Readonly<Partial<Record<string, AnyPaneDefinition>>>

/**
 * A rendered pane in the transcript.
 *
 * @category schemas
 * @since 0.1.0
 */
export const PaneCard = Schema.Struct({
  kind: Schema.Literal("pane"),
  id: Schema.String,
  name: Schema.String,
  title: Schema.optionalKey(Schema.String),
  props: Schema.Unknown,
  /** Wire metadata for hosts without a pane registry; the definition owns capability. */
  fullscreen: Schema.Boolean
})

/**
 * A rendered pane in the transcript.
 *
 * @category models
 * @since 0.1.0
 */
export type PaneCard = typeof PaneCard.Type

/**
 * Model-authored HTML in the transcript, for output no pane covers.
 *
 * @category schemas
 * @since 0.1.0
 */
export const HtmlCard = Schema.Struct({
  kind: Schema.Literal("html"),
  id: Schema.String,
  title: Schema.optionalKey(Schema.String),
  html: Schema.String
})

/**
 * Model-authored HTML in the transcript.
 *
 * @category models
 * @since 0.1.0
 */
export type HtmlCard = typeof HtmlCard.Type

/**
 * A flow execution the transcript is following, step by step.
 *
 * @category schemas
 * @since 0.1.0
 */
export const FlowRunCard = Schema.Struct({
  kind: Schema.Literal("flow-run"),
  id: Schema.String,
  flowId: Schema.String,
  executionId: Schema.String,
  phase: Schema.Literals(["running", "waiting-approval", "completed", "failed", "cancelled"]),
  steps: Schema.Array(Schema.Struct({
    name: Schema.String,
    status: Schema.Literals(["pending", "running", "done", "failed", "cached"])
  })),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.String)
})

/**
 * A flow execution the transcript is following.
 *
 * @category models
 * @since 0.1.0
 */
export type FlowRunCard = typeof FlowRunCard.Type

/**
 * A flow the agent wrote to the app's own source tree.
 *
 * @category schemas
 * @since 0.1.0
 */
export const FlowSavedCard = Schema.Struct({
  kind: Schema.Literal("flow-saved"),
  id: Schema.String,
  flowId: Schema.String,
  description: Schema.String,
  files: Schema.Array(Schema.String)
})

/**
 * A flow the agent wrote to the app's own source tree.
 *
 * @category models
 * @since 0.1.0
 */
export type FlowSavedCard = typeof FlowSavedCard.Type

/**
 * Every card kind a transcript can hold.
 *
 * @category schemas
 * @since 0.1.0
 */
export const AppCard = Schema.Union([PaneCard, HtmlCard, FlowRunCard, FlowSavedCard])

/**
 * Every card kind a transcript can hold.
 *
 * @category models
 * @since 0.1.0
 */
export type AppCard = typeof AppCard.Type

/**
 * One frame of the NDJSON stream a turn emits.
 *
 * `delta` is assistant text, `cell` is a code cell the agent ran, `call` is one
 * host call with its outcome, `card` and `card.update` carry the transcript's
 * cards, `park` suspends the run for a human, and `done` or `error` ends it.
 *
 * @category schemas
 * @since 0.1.0
 */
export const TurnFrame = Schema.Union([
  Schema.Struct({ type: Schema.Literal("delta"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("cell"), source: Schema.String, ordinal: Schema.Number }),
  Schema.Struct({
    type: Schema.Literal("call"),
    flow: Schema.String,
    input: Schema.Unknown,
    outcome: Schema.Literals(["success", "failure"]),
    message: Schema.optionalKey(Schema.String)
  }),
  Schema.Struct({ type: Schema.Literal("card"), card: AppCard }),
  Schema.Struct({ type: Schema.Literal("card.update"), card: AppCard }),
  Schema.Struct({ type: Schema.Literal("park"), reason: Schema.String, message: Schema.String }),
  Schema.Struct({ type: Schema.Literal("done"), output: Schema.Unknown }),
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String })
])

/**
 * One frame of the NDJSON stream a turn emits.
 *
 * @category models
 * @since 0.1.0
 */
export type TurnFrame = typeof TurnFrame.Type
