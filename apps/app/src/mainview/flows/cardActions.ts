import type { Action, CardCommandInput, CatalogTag } from "@smthrs/rpc/CardAction"
import { flowArgs, hasFlowArgs } from "./FlowArgs"
import { flowAction, type FlowActionProps } from "./FlowAction"

/**
 * A Container owns command inputs and optional stable row scope. A definition with `gesture` is a named
 * non-button gesture (hover, definition, a docs link): it is bound like a button but returned in `gestures`.
 */
export type CardActionDefinition<Tag extends CatalogTag = CatalogTag, Gesture extends string = string> =
  Tag extends CatalogTag ? Action & {
      readonly tag: Tag
      readonly scope?: string
      readonly gesture?: Gesture
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

export interface CardActionBindings<Gesture extends string = string> {
  readonly actions: Action[]
  /** The View's `CardProps["gestures"]`: each named gesture's action, bound through the same dispatch. */
  readonly gestures: Partial<Record<Gesture, Action>>
  readonly onAction: (tag: CatalogTag, input?: Record<string, string>) => void
  /** Spread onto the gesture so speculative loading receives the dispatched input. */
  readonly actionProps: (tag: CatalogTag, input?: Record<string, string>) => FlowActionProps
  /** Each row gets its own callback without changing the View's opaque tag contract. */
  readonly forScope: (scope: string) => CardActionBindings<Gesture>
}

/** Catalog commands whose input carries a secret value (`CardCommandInput["secrets.set"].value`). */
const SECRET_INPUT_TAGS: ReadonlySet<CatalogTag> = new Set<CatalogTag>(["secrets.set"])

/**
 * The speculative-load line: the command's canonical `flowArgs` encoding, which `payloadFor` decodes back.
 * A tag without an encoder preloads by name only; T-CAT-01 adds catalog encoders to FlowArgs. An action whose
 * input can carry a secret (a `secret` form field, or a secret-bearing command) preloads by name only, so the
 * value never reaches a DOM attribute or the preload path.
 */
const preloadArgs = (definition: Action, tag: CatalogTag, input: unknown): string | undefined =>
  input === undefined || !hasFlowArgs(tag) || SECRET_INPUT_TAGS.has(tag) ||
    definition.input?.some((field) => field.kind === "secret") === true
    ? undefined
    : flowArgs(tag, input as never)

/** One definition per tag and bound `args` in a scope, so a row can offer Move up and Move down (`stack.move`). */
const definitionKey = (definition: Action): string =>
  `${definition.tag} ${JSON.stringify(Object.entries(definition.args ?? {}).sort(([a], [b]) => a.localeCompare(b)))}`

/** The View sends `{...action.args, ...input}`; the part that is not the action's own `args` is form input. */
const formInput = (definition: Action, input: Record<string, string> | undefined) => {
  if (input === undefined) return undefined
  const form = Object.entries(input).filter(([key, value]) => definition.args?.[key] !== value)
  return form.length === 0 ? undefined : Object.fromEntries(form)
}

/**
 * Bind viewer-filtered actions and gestures through flowAction; row scopes share no command authority. A tag bound
 * more than once in a scope is told apart by the `args` the View passes back.
 */
export const cardActions = <Gesture extends string = never>(
  dispatch: CardCommandDispatch,
  definitions: readonly CardActionDefinition<CatalogTag, Gesture>[],
  onFailure: (failure: CardActionFailure) => void = () => {}
): CardActionBindings<Gesture> => {
  const scopes = new Map<string | undefined, Map<string, CardActionDefinition<CatalogTag, Gesture>>>()
  for (const definition of definitions) {
    let scope = scopes.get(definition.scope)
    if (!scope) scopes.set(definition.scope, scope = new Map())
    if (scope.has(definitionKey(definition))) {
      throw new Error(`Duplicate card action in scope ${definition.scope ?? "card"}: ${definition.tag}`)
    }
    if (
      definition.gesture !== undefined &&
      [...scope.values()].some((other) => other.gesture === definition.gesture)
    ) throw new Error(`Duplicate card gesture in scope ${definition.scope ?? "card"}: ${definition.gesture}`)
    scope.set(definitionKey(definition), definition)
  }
  const bindScope = (scope: string | undefined): CardActionBindings<Gesture> => {
    const bound = scopes.get(scope) ?? new Map<string, CardActionDefinition<CatalogTag, Gesture>>()
    const find = (tag: CatalogTag, input?: Record<string, string>) => {
      const candidates = [...bound.values()].filter((definition) => definition.tag === tag)
      return candidates.length <= 1 ? candidates[0] : candidates.find((definition) =>
        Object.entries(definition.args ?? {}).every(([key, value]) => input?.[key] === value)
      )
    }
    const actionProps = (tag: CatalogTag, input?: Record<string, string>): FlowActionProps => {
      const definition = find(tag, input)
      if (!definition || definition.disabled) {
        return flowAction(() => {
          onFailure({
            tag,
            kind: definition ? "disabled" : "unavailable",
            reason: definition?.disabled?.reason ?? `Card action is unavailable: ${tag}`
          })
        }, tag)
      }
      const form = formInput(definition, input)
      if (form !== undefined && definition.resolve_input === undefined) {
        throw new Error(`Card action ${tag} needs an input resolver`)
      }
      const commandInput = form === undefined ? definition.command_input : definition.resolve_input!(input!)
      // The union remains correlated when definitions enter this helper; lookup erases its tag parameter.
      return flowAction(() => dispatch(tag, commandInput), tag, preloadArgs(definition, tag, commandInput))
    }
    const viewAction = (
      { command_input: _commandInput, resolve_input: _resolveInput, scope: _scope, gesture: _gesture, ...action }:
        CardActionDefinition<CatalogTag, Gesture>
    ): Action => action
    const gestures: Partial<Record<Gesture, Action>> = {}
    for (const definition of bound.values()) {
      if (definition.gesture !== undefined) gestures[definition.gesture] = viewAction(definition)
    }
    return {
      actions: [...bound.values()].filter((definition) => definition.gesture === undefined).map(viewAction),
      gestures,
      onAction: (tag, input) => {
        actionProps(tag, input).onClick()
      },
      actionProps,
      forScope: bindScope
    }
  }
  return bindScope(undefined)
}
