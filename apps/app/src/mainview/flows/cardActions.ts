import type { Action, CardCommandInput, CatalogTag } from "@smthrs/rpc/CardAction"
import { flowArgs, hasFlowArgs } from "./FlowArgs"
import { flowAction, type FlowActionProps } from "./FlowAction"
import type { CardViewProps } from "../ChatCards"
import type { AppController } from "../state/AppController"
import type { Card } from "../state/AppState"
import { writeOnlyGesture, type CommandGesture } from "./CommandGesture"
import type { InstallModel } from "../state/seams/InstallModel"

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

/*
 * The CardView command bindings, built once per controller.
 *
 * Every act a card raises is a flow name, bound to the same controller.
 *
 * Bindings are cached by controller and card record. Unchanged cards keep
 * the same callbacks through unrelated transcript renders, and replaced
 * records can be collected. Their origin affects presentation, never permission.
 */

/** The CardView callbacks that dispatch its flows. */
type CardBindings = Omit<
  CardViewProps,
  "card" | "maximized" | "worldDocuments" | "debugVerbose" | "signedOut" | "workflowCatalogs" | "triggerCatalogs" | "fileCards"
>

const bound = new WeakMap<AppController, CardBindings>()
const cardBound = new WeakMap<AppController, WeakMap<Card, CardBindings>>()

/** Stable bindings capture the originating card, never its mutable presentation. */
export const controllerCardActions = (controller: AppController, card?: Card): CardBindings => {
  const cards = cardBound.get(controller) ?? new WeakMap<Card, CardBindings>()
  if (card !== undefined) cardBound.set(controller, cards)
  const cached = card === undefined ? bound.get(controller) : cards.get(card)
  if (cached !== undefined) return cached
  const runCommand: AppController["runCommand"] = (name, args) => card === undefined
    ? controller.runCommand(name, args)
    : controller.runCommand(name, args, card.id)
  const actions: CardBindings = {
    projectionStore: controller.store,
    // Saved confirmations retain their command door; removed commands report
    // the controller's explicit refusal rather than silently doing nothing.
    onGrantConfirm: (id) => runCommand("admin.grant.confirm", id),
    onGrantCancel: (id) => runCommand("admin.grant.cancel", id),
    onDecideApproval: (id, decision, answer, question) =>
      // Structured human answers keep their value shape through the controller.
      answer === undefined
        ? runCommand(
          decision === "approved" ? "approval.approve" : "approval.deny",
          id
        )
        : controller.answerApproval(id, answer, question),
    onMaximize: (id) => runCommand("card.maximize", id),
    onMinimize: () => runCommand("card.minimize"),
    onFrameBack: () => runCommand("frame.back"),
    onFrameForward: () => runCommand("frame.forward"),
    onConnectGitHub: () => runCommand("auth.sign-in"),
    onRunWorkflow: (name) => runCommand("flow.run", name),
    onStopRun: (id) => runCommand("flow.run.stop", id),
    onRetryRun: (id) => runCommand("flow.run.retry", id),
    onChooseWorkflowRepo: (name) => runCommand("flow.repo.choose", name),
    onChangeWorldDocument: (id, body) =>
      runCommand("wiki.edit", `${id} ${JSON.stringify(body)}`),
    onAttachWorldEditor: controller.attachWorldEditor,
    onRunCommand: (name, commandArgs) => runCommand(name, commandArgs)
  }
  if (card === undefined) bound.set(controller, actions)
  else cards.set(card, actions)
  return actions
}


/** The command host forwards this nonserializable gesture to commands.submit. */
export type InstallCardDispatch = <Tag extends CatalogTag>(tag: Tag, input: CardCommandInput[Tag], gesture?: CommandGesture) => unknown

// T-APP-03: direct key fields and slash-opened forms use the same write-only door.
export const installKeyAction = (dispatch: InstallCardDispatch, model: InstallModel) => {
  let reserved: CommandGesture | undefined
  const coding = model.models.find(role => role.role === "coding")!
  const definition: CardActionDefinition<"settings.model-key"> = {
    tag: "settings.model-key", label: "Change model key", command_input: { role: "coding", provider: coding.provider },
    resolve_input: input => {
      reserved?.release()
      reserved = input.value ? writeOnlyGesture("settings.model-key", { value: input.value }) : undefined
      delete input.value
      const role = input.role === "fast" || input.role === "jev" ? input.role : "coding"
      return { role, provider: input.provider ?? model.models.find(model => model.role === role)!.provider }
    }
  }
  const run: CardCommandDispatch = (tag, input) => {
    const gesture = reserved
    reserved = undefined
    try {
      const result = dispatch(tag, input, tag === "settings.model-key" ? gesture : undefined)
      if (result instanceof Promise) void result.finally(() => gesture?.release()).catch(() => {})
      return result
    } catch (cause) { gesture?.release(); throw cause }
  }
  return { definition, dispatch: run }
}
