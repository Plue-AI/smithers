import type { Action, CardCommandInput, CatalogTag } from "@smthrs/rpc/CardAction"
import { flowAction, type FlowActionProps } from "./FlowAction"

/** A Container owns command inputs and optional stable row scope. */
export type CardActionDefinition<Tag extends CatalogTag = CatalogTag> = Tag extends CatalogTag ? Action & {
    readonly tag: Tag
    readonly scope?: string
    readonly command_input: CardCommandInput[Tag]
    readonly resolve_input?: (input: Record<string, string>) => CardCommandInput[Tag]
  } :
  never

/** The catalog adapter preserves the tag's command input type. */
export type CardCommandDispatch = <Tag extends CatalogTag>(tag: Tag, input: CardCommandInput[Tag]) => unknown

export interface CardActionFailure {
  readonly tag: CatalogTag
  readonly reason: string
  readonly kind: "unavailable" | "disabled"
}

export interface CardActionBindings {
  readonly actions: Action[]
  readonly onAction: (tag: CatalogTag, input?: Record<string, string>) => void
  /** Spread onto the gesture so speculative loading receives the dispatched input. */
  readonly actionProps: (tag: CatalogTag, input?: Record<string, string>) => FlowActionProps
  /** Each row gets its own callback without changing the View's opaque tag contract. */
  readonly forScope: (scope: string) => CardActionBindings
}

/** Bind viewer-filtered actions through flowAction; row scopes share no command authority. */
export const cardActions = (
  dispatch: CardCommandDispatch,
  definitions: readonly CardActionDefinition[],
  onFailure: (failure: CardActionFailure) => void = () => {}
): CardActionBindings => {
  const scopes = new Map<string | undefined, Map<CatalogTag, CardActionDefinition>>()
  for (const definition of definitions) {
    let scope = scopes.get(definition.scope)
    if (!scope) scopes.set(definition.scope, scope = new Map())
    if (scope.has(definition.tag)) {
      throw new Error(`Duplicate card action in scope ${definition.scope ?? "card"}: ${definition.tag}`)
    }
    scope.set(definition.tag, definition)
  }
  const bindScope = (scope: string | undefined): CardActionBindings => {
    const bound = scopes.get(scope) ?? new Map<CatalogTag, CardActionDefinition>()
    const actionProps = (tag: CatalogTag, input?: Record<string, string>): FlowActionProps => {
      const definition = bound.get(tag)
      if (!definition || definition.disabled) {
        return flowAction(() => {
          onFailure({
            tag,
            kind: definition ? "disabled" : "unavailable",
            reason: definition?.disabled?.reason ?? `Card action is unavailable: ${tag}`
          })
        }, tag)
      }
      if (input !== undefined && definition.resolve_input === undefined) {
        throw new Error(`Card action ${tag} needs an input resolver`)
      }
      const commandInput = input === undefined ? definition.command_input : definition.resolve_input!(input)
      // The union remains correlated when definitions enter this helper; lookup erases its tag parameter.
      return flowAction(
        () => dispatch(tag, commandInput),
        tag,
        commandInput === undefined ? undefined : JSON.stringify(commandInput)
      )
    }
    return {
      actions: [...bound.values()].map((
        { command_input: _commandInput, resolve_input: _resolveInput, scope: _scope, ...action }
      ) => action),
      onAction: (tag, input) => {
        actionProps(tag, input).onClick()
      },
      actionProps,
      forScope: bindScope
    }
  }
  return bindScope(undefined)
}
