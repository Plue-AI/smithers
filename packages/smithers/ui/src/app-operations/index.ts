/*
 * App operations: what one Smithers act declares, apart from any host that
 * runs it (#2125). An operation is the name, the typed input, the catalog
 * copy and the actor and confirmation rules. It carries no handler: the GUI
 * binds a controller call to it (apps/app flows/entries/Declare.ts `flow`),
 * and every other host binds its own implementation to the same declaration.
 *
 * Pure: no store, no DOM, no Effect runtime.
 */
import { Schema } from "effect"
import type { FormHints } from "../flow-form"

/**
 * The input schemas an operation may declare: anything that decodes from
 * unknown without asking the host for a service, so every host decodes a
 * call's input on its own.
 */
export type OperationPayload = Schema.Top & Schema.ConstraintDecoder<unknown, never>

/**
 * The catalog, requirement and confirmation rules around one operation.
 *
 * `Capability` and `Host` are the host-service and host-kind vocabularies of
 * the runtime that registers the operation; a host-neutral declaration names
 * neither.
 */
export interface OperationMetadata<Capability extends string = string, Host extends string = string> {
  readonly summary: string
  /** Not listed in the slash menu (id-scoped button actions); still invocable. */
  readonly hidden?: boolean
  /** Teach a hidden control to the model without adding it to the human menu. */
  readonly discloseToAgent?: boolean
  /**
   * The slash argument hint, e.g. `<number> [owner/repo]`. Its presence is
   * what makes `/name <text>` parse as an invocation rather than a prompt;
   * the text itself is catalog copy for the human and the model.
   */
  readonly args?: string
  /*
   * The requirement axis: requirement ids that must be satisfied before this
   * operation executes. A user invocation with an unmet requirement DEFERS:
   * the host parks it and dispatches the requirement's fulfilling operation
   * instead, then resumes it when the requirement holds. A model invocation
   * never defers: an unmet requirement is an honest failure carrying the
   * reason, because a model must not enqueue work that fires after its turn
   * ends.
   */
  readonly requires?: ReadonlyArray<string>
  /** Host services this operation needs; a host without them does not register it. */
  readonly runtime?: ReadonlyArray<Capability>
  /**
   * Host services of which at least ONE must be present. An operation that
   * serves two hosts names both; `runtime` alone cannot say "either".
   */
  readonly runtimeAny?: ReadonlyArray<Capability>
  /**
   * The host kinds this operation exists on; absent means every host. Unlike
   * `runtime`, a missing host satisfies nothing: no host, no operation.
   */
  readonly hosts?: ReadonlyArray<Host>
  /**
   * The repository flow this door launches (`issue.implement` runs
   * `coding/request`; a repository leaf names itself).
   */
  readonly workflow?: string
  /**
   * A consequential act the MODEL may ask for but never perform: a model
   * invocation does not run the handler; it posts a confirmation whose button
   * runs the operation as the user. The string is the human-readable label of
   * the act ("land pull request #12"). User invocations are unaffected.
   *
   * The function form decides per decoded payload: the label when THIS
   * invocation needs the human's confirmation, undefined when the handler may
   * run for the model as it stands.
   */
  readonly confirm?: string | ((payload: Record<string, unknown>) => string | undefined)
  /**
   * The sentence the confirmation asks, when "Smithers wants to <label>" is
   * not what happened. Absent keeps the model's sentence.
   */
  readonly confirmQuestion?: string
  /**
   * The slash line the confirmation carries, when the raw one the model typed
   * would not name the act. An operation whose bare form resolves an implicit
   * target ("the active repository") resolves it at ASK time and returns it
   * here, so the button runs the act the confirmation described.
   */
  readonly confirmArgs?: (payload: Record<string, unknown>) => string | undefined
  /**
   * Why a user-only operation is the human's alone: the gesture is physically
   * theirs, or the answer is theirs to give. The model's refusal quotes it.
   */
  readonly userOnlyReason?: string
  /**
   * THE FORM LAW: what the operation says about the form a missing-input
   * invocation renders. The fields derive from the input schema
   * (`flow-form.ts`); an operation with no hints still gets a derived form.
   */
  readonly form?: FormHints
}

/** One declared act: its name and typed input beside its rules, with no handler. */
export interface Operation<
  I extends OperationPayload = OperationPayload,
  Capability extends string = string,
  Host extends string = string
> extends OperationMetadata<Capability, Host> {
  readonly name: string
  readonly input: I
  /**
   * The human's alone: never disclosed to, or callable by, a model or a
   * robot. Reserved for a gesture that is physically the human's or an
   * answer only they may give, never for an act that is merely consequential
   * (that is `confirm`). Every user-only operation states `userOnlyReason`.
   */
  readonly userOnly?: boolean
}

/**
 * Declares one operation. The literal type is kept, so a host binding reads
 * the exact input schema and only the rules the declaration states.
 */
export const operation = <const O extends Operation>(declared: O): O => declared

/** The input of an operation that takes nothing. */
export const NoInput = Schema.Record(Schema.String, Schema.Never)
