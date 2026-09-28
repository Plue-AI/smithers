// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Defines named wait points for durable flow executions.
 *
 * A `DurableDeferred` has a stable name and schemas for the value that will be
 * recorded later. Flows can await it, suspend when no result exists yet, and
 * resume after its result is recorded. Tokens identify the flow name,
 * execution id, and deferred name so external code can complete the correct
 * wait point later.
 *
 * @since 0.1.0
 */

import * as Arr from "effect/Array"
import type { NonEmptyReadonlyArray } from "effect/Array"
import type * as Brand from "effect/Brand"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Exit from "effect/Exit"
import * as Filter from "effect/Filter"
import { dual } from "effect/Function"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SchemaGetter from "effect/SchemaGetter"
import { CurrentAttempt } from "./Action/Context.ts"
import * as Flow from "./Flow/index.ts"
import { FlowInstance } from "./FlowRuntime/FlowInstance.ts"
import { FlowRuntime } from "./FlowRuntime/FlowRuntime.ts"

const TypeId = "@smthrs/flow/DurableDeferred"

/**
 * Named durable deferred value whose completion is persisted by the flow
 * engine and encoded with success and error schemas.
 *
 * @category models
 * @since 0.1.0
 */
export interface DurableDeferred<
  Success extends Schema.Constraint,
  Error extends Schema.Constraint = Schema.Never
> {
  readonly [TypeId]: typeof TypeId
  readonly name: string
  readonly successSchema: Success
  readonly errorSchema: Error
  readonly exitSchema: Schema.Exit<Schema.Top, Schema.Top, Schema.Top>
  readonly withActionAttempt: Effect.Effect<DurableDeferred<Success, Error>>
}

/**
 * Type-erased durable deferred shape for APIs that only need the deferred
 * identity and name.
 *
 * @category models
 * @since 0.1.0
 */
export interface Any {
  readonly [TypeId]: typeof TypeId
  readonly name: string
}

/**
 * Type-erased durable deferred shape that also exposes success, error, and
 * exit schemas.
 *
 * @category models
 * @since 0.1.0
 */
export interface AnyWithProps {
  readonly [TypeId]: typeof TypeId
  readonly name: string
  readonly successSchema: Schema.Top
  readonly errorSchema: Schema.Top
  readonly exitSchema: Schema.Exit<any, any, any>
}

// Queues, human tasks and clocks mint a deferred per item, attempt or sleep.
// Effect caches compiled parsers by AST identity, so the exit schema is shared
// per (success, error) pair rather than rebuilt for every deferred.
const exitSchemaCache = new WeakMap<object, WeakMap<object, Schema.Exit<any, any, any>>>()

const exitSchemaFor = (success: Schema.Constraint, error: Schema.Constraint): Schema.Exit<any, any, any> => {
  let byError = exitSchemaCache.get(success)
  if (byError === undefined) {
    byError = new WeakMap()
    exitSchemaCache.set(success, byError)
  }
  let cached = byError.get(error)
  if (cached === undefined) {
    cached = Schema.Exit(
      Schema.toCodecJson(success),
      Schema.toCodecJson(error),
      Schema.toCodecJson(Schema.Defect())
    )
    byError.set(error, cached)
  }
  return cached
}

/**
 * Creates a named durable deferred with optional success and error schemas for
 * persisted completion.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <
  Success extends Schema.Constraint = Schema.Void,
  Error extends Schema.Constraint = Schema.Never
>(
  name: string,
  options?: {
    readonly success?: Success | undefined
    readonly error?: Error | undefined
  }
): DurableDeferred<Success, Error> => {
  const successSchema = options?.success ?? (Schema.Void as any as Success)
  const errorSchema = options?.error ?? (Schema.Never as any as Error)
  return {
    [TypeId]: TypeId as typeof TypeId,
    name,
    successSchema,
    errorSchema,
    exitSchema: exitSchemaFor(successSchema, errorSchema) as any,
    withActionAttempt: Effect.gen(function*() {
      const attempt = yield* CurrentAttempt
      return make(`${name}/${attempt}`, {
        success: successSchema,
        error: errorSchema
      })
    })
  }
}

const await_: <Success extends Schema.Constraint, Error extends Schema.Constraint>(
  self: DurableDeferred<Success, Error>
) => Effect.Effect<
  Success["Type"],
  Error["Type"],
  | FlowRuntime
  | FlowInstance
  | Success["DecodingServices"]
  | Error["DecodingServices"]
> =
  // Untraced because deferred polling participates in the flow scheduler hot path.
  Effect.fnUntraced(function*<
    Success extends Schema.Constraint,
    Error extends Schema.Constraint
  >(self: DurableDeferred<Success, Error>) {
    const engine = yield* FlowRuntime
    const instance = yield* FlowInstance
    const exit = yield* Flow.wrapActionResult(
      engine.deferredResult(self),
      Option.isNone
    )
    if (Option.isNone(exit)) {
      return yield* Flow.suspend(instance)
    }
    const value = exit.value as Exit.Exit<any, any>
    // A recorded interruption is a durable *outcome*, not a request to
    // suspend: mark the instance interrupted before re-raising so
    // `Flow.intoResult` classifies the interrupt-only cause as a `Complete`
    // failure. Without this the driver mistakes the cause for an external
    // suspension interrupt, aborts without a terminal transition, and the
    // run spins in the suspended-retry loop forever.
    if (Exit.isFailure(value) && Cause.hasInterruptsOnly(value.cause)) {
      instance.interrupted = true
    }
    return yield* value
  })

export {
  /**
   * Waits for the durable deferred, suspending the current flow when no
   * persisted completion is available.
   *
   * @category combinators
   * @since 0.1.0
   */
  await_ as await
}

/**
 * Runs an effect and records its exit into the durable deferred, resuming
 * flows that are waiting on that deferred.
 *
 * @category combinators
 * @since 0.1.0
 */
export const into: {
  <Success extends Schema.Constraint, Error extends Schema.Constraint>(
    self: DurableDeferred<Success, Error>
  ): <R>(
    effect: Effect.Effect<Success["Type"], Error["Type"], R>
  ) => Effect.Effect<
    Success["Type"],
    Error["Type"],
    | R
    | FlowRuntime
    | FlowInstance
    | Success["DecodingServices"]
    | Success["EncodingServices"]
    | Error["DecodingServices"]
    | Error["EncodingServices"]
  >
  <Success extends Schema.Constraint, Error extends Schema.Constraint, R>(
    effect: Effect.Effect<Success["Type"], Error["Type"], R>,
    self: DurableDeferred<Success, Error>
  ): Effect.Effect<
    Success["Type"],
    Error["Type"],
    | R
    | FlowRuntime
    | FlowInstance
    | Success["DecodingServices"]
    | Success["EncodingServices"]
    | Error["DecodingServices"]
    | Error["EncodingServices"]
  >
} = dual(
  2,
  <Success extends Schema.Constraint, Error extends Schema.Constraint, R>(
    effect: Effect.Effect<Success["Type"], Error["Type"], R>,
    self: DurableDeferred<Success, Error>
  ): Effect.Effect<
    Success["Type"],
    Error["Type"],
    | R
    | FlowRuntime
    | FlowInstance
    | Success["DecodingServices"]
    | Success["EncodingServices"]
    | Error["DecodingServices"]
    | Error["EncodingServices"]
  > =>
    Effect.contextWith(
      (context: Context.Context<FlowRuntime | FlowInstance>) => {
        const engine = Context.get(context, FlowRuntime)
        const instance = Context.get(context, FlowInstance)
        // Keep the original instance: action regions identify their ancestors
        // by reference, and suspension metadata belongs to the enclosing flow.
        return Effect.onExit(
          effect,
          // Untraced because completion encoding is called for each deferred result.
          Effect.fnUntraced(function*(exit) {
            if (Exit.isFailure(exit)) {
              const [reasons, interrupts] = Arr.partition(
                exit.cause.reasons,
                Filter.fromPredicate(Cause.isInterruptReason)
              )
              const hasInterruptsOnly = interrupts.length === exit.cause.reasons.length
              if (hasInterruptsOnly) {
                // An interrupt-only exit is never a result: the effect was
                // suspended, preempted, or interrupted, so record nothing.
                // Recording here would durably persist the empty non-interrupt
                // partition, and first-writer-wins would replay that empty
                // cause forever instead of the real completion.
                return
              } else if (interrupts.length > 0) {
                exit = Exit.failCause(Cause.fromReasons(reasons))
              }
            }
            yield* engine.deferredDone(self, {
              flowName: instance.flow._tag,
              executionId: instance.executionId,
              deferredName: self.name,
              exit
            })
          })
        )
      }
    )
)

/**
 * Runs effects as a durable race, returning a previously persisted result when
 * present or completing a named deferred with the first success. The race
 * fails only when every effect fails.
 *
 * @category racing
 * @since 0.1.0
 */
export const raceAll = <
  const Effects extends NonEmptyReadonlyArray<Effect.Effect<any, any, any>>,
  Success extends Schema.Schema<Effect.Success<Effects[number]>>,
  Error extends Schema.Schema<Effect.Error<Effects[number]>>
>(options: {
  name: string
  success: Success
  error: Error
  effects: Effects
}): Effect.Effect<
  Effect.Success<Effects[number]>,
  Effect.Error<Effects[number]>,
  | Effect.Services<Effects[number]>
  | Success["DecodingServices"]
  | Success["EncodingServices"]
  | Error["DecodingServices"]
  | Error["EncodingServices"]
  | FlowRuntime
  | FlowInstance
> => {
  const deferred = make<any, any>(`raceAll/${options.name}`, {
    success: options.success,
    error: options.error
  })
  return Effect.gen(function*() {
    const engine = yield* FlowRuntime
    const exit = yield* engine.deferredResult(deferred)
    if (Option.isSome(exit)) {
      return yield* exit.value
    }
    return yield* into(
      Effect.raceAll(options.effects),
      deferred
    )
  })
}

/**
 * Runtime brand identifier for durable deferred tokens.
 *
 * @category type IDs
 * @since 0.1.0
 */
export const TokenTypeId = "@smthrs/flow/DurableDeferred/Token"

/**
 * Type-level brand identifier for `Token` values.
 *
 * @category type IDs
 * @since 0.1.0
 */
export type TokenTypeId = typeof TokenTypeId

/**
 * Branded string token identifying a durable deferred for a flow
 * execution.
 *
 * A token is an address, not a credential. It is unsigned base64url JSON of
 * the flow name, execution id, and deferred name, and `tokenFromExecutionId`
 * and `tokenFromPayload` rebuild it from those values alone. Anyone who can
 * call `done`, `succeed`, `fail`, `failCause`, or `HumanTask.answer` against
 * the run's `FlowRuntime` can complete an open wait whose address they know or
 * derive. A host that exposes completion to other parties must authorize the
 * caller before it calls one of them.
 *
 * @category token
 * @since 0.1.0
 */
export type Token = Brand.Branded<string, TokenTypeId>

/**
 * Schema for branded durable deferred tokens.
 *
 * @category token
 * @since 0.1.0
 */
export const Token: Schema.brand<Schema.String, TokenTypeId> = Schema.String.pipe(Schema.brand(TokenTypeId))

/**
 * A completion token could not be decoded into its durable address.
 *
 * @category errors
 * @since 0.1.0
 */
export class TokenInvalid extends Schema.TaggedError<TokenInvalid>()("@smthrs/flow/DurableDeferred/TokenInvalid", {
  code: Schema.Literals(["malformed_token", "deferred_mismatch"]).pipe(
    Schema.withConstructorDefault(Effect.succeed("malformed_token"))
  ),
  message: Schema.String
}) {}

/**
 * Schema for a decoded durable deferred token containing the flow
 * name, execution ID, and deferred name.
 *
 * @category token
 * @since 0.1.0
 */
export class TokenParsed extends Schema.Class<TokenParsed>(
  "@smthrs/flow/DurableDeferred/TokenParsed"
)({
  flowName: Schema.String,
  executionId: Schema.String,
  deferredName: Schema.String
}) {
  /**
   * Encodes the parsed flow, execution, and deferred names back into a token.
   *
   * @since 0.1.0
   */
  get asToken(): Token {
    return Encoding.encodeBase64Url(
      JSON.stringify([this.flowName, this.executionId, this.deferredName])
    ) as Token
  }

  /**
   * Schema for decoding and encoding durable deferred tokens as strings.
   *
   * @since 0.1.0
   */
  static readonly FromString = Schema.String.pipe(
    Schema.decodeTo(
      Schema.fromJsonString(
        Schema.Tuple([Schema.String, Schema.String, Schema.String])
      ),
      {
        decode: SchemaGetter.decodeBase64UrlString(),
        encode: SchemaGetter.encodeBase64Url()
      }
    ),
    Schema.decodeTo(TokenParsed, {
      decode: SchemaGetter.transform(
        ([flowName, executionId, deferredName]) =>
          new TokenParsed({
            flowName,
            executionId,
            deferredName
          })
      ),
      encode: SchemaGetter.transform(
        (parsed) =>
          [
            parsed.flowName,
            parsed.executionId,
            parsed.deferredName
          ] as const
      )
    })
  )

  /**
   * Decodes a durable deferred token string into its parsed components.
   *
   * @since 0.1.0
   */
  static readonly fromString = Schema.decodeSync(TokenParsed.FromString)

  /**
   * Encodes parsed durable deferred token components into a token string.
   *
   * @since 0.1.0
   */
  static readonly encode = Schema.encodeSync(TokenParsed.FromString)

  /**
   * Parses an untrusted token into its durable address with a typed,
   * bounded diagnostic on failure.
   *
   * @category token
   * @since 1.0.0
   */
  static readonly parse = (token: string): Effect.Effect<TokenParsed, TokenInvalid> =>
    Effect.mapError(
      Schema.decodeEffect(TokenParsed.FromString)(token),
      (issue) =>
        new TokenInvalid({
          message: `The supplied token "${tokenExcerpt(token)}" is not a durable deferred token: ${issue.message}`
        })
    )
}

const maxTokenExcerptChars = 64

/** Renders a bounded excerpt of untrusted token content for a diagnostic. */
const tokenExcerpt = (token: string): string =>
  token.length <= maxTokenExcerptChars
    ? token
    : `${token.slice(0, maxTokenExcerptChars)} [${token.length - maxTokenExcerptChars} characters dropped]`

/**
 * Creates a token for a durable deferred using the current flow instance's
 * flow name and execution ID.
 *
 * @category token
 * @since 0.1.0
 */
export const token: <Success extends Schema.Constraint, Error extends Schema.Constraint>(
  self: DurableDeferred<Success, Error>
) => Effect.Effect<Token, never, FlowInstance> =
  // Untraced because token allocation is on the durable-deferred hot path.
  Effect.fnUntraced(
    function*<Success extends Schema.Constraint, Error extends Schema.Constraint>(
      self: DurableDeferred<Success, Error>
    ) {
      const instance = yield* FlowInstance
      return tokenFromExecutionId(self, instance)
    }
  )

/**
 * Creates a durable deferred token from an explicit flow, execution ID,
 * and deferred name.
 *
 * @category token
 * @since 0.1.0
 */
export const tokenFromExecutionId: {
  (options: {
    readonly flow: Flow.Any
    readonly executionId: string
  }): <Success extends Schema.Constraint, Error extends Schema.Constraint>(
    self: DurableDeferred<Success, Error>
  ) => Token
  <Success extends Schema.Constraint, Error extends Schema.Constraint>(
    self: DurableDeferred<Success, Error>,
    options: { readonly flow: Flow.Any; readonly executionId: string }
  ): Token
} = dual(
  2,
  <Success extends Schema.Constraint, Error extends Schema.Constraint>(
    self: DurableDeferred<Success, Error>,
    options: {
      readonly flow: Flow.Any
      readonly executionId: string
    }
  ): Token =>
    new TokenParsed({
      flowName: options.flow._tag,
      executionId: options.executionId,
      deferredName: self.name
    }).asToken
)

/**
 * Creates a durable deferred token by deriving the flow execution ID from
 * the supplied flow payload.
 *
 * The payload identifies a previously started execution only when the flow
 * declares `idempotencyKey` or the host installs the opt-in `derived`
 * execution-id source. Otherwise the default `fresh` source mints a new
 * execution ID on every call, so the token addresses no earlier run. To
 * complete an existing execution without stable identity, keep its execution
 * ID and use {@link tokenFromExecutionId}.
 *
 * @category token
 * @since 0.1.0
 */
export const tokenFromPayload: {
  <W extends Flow.Any>(options: {
    readonly flow: W
    readonly payload: Flow.PayloadSchema<W>["~type.make.in"]
  }): <Success extends Schema.Constraint, Error extends Schema.Constraint>(
    self: DurableDeferred<Success, Error>
  ) => Effect.Effect<Token, never, Crypto.Crypto | Flow.PayloadSchema<W>["EncodingServices"]>
  <
    Success extends Schema.Constraint,
    Error extends Schema.Constraint,
    W extends Flow.Any
  >(
    self: DurableDeferred<Success, Error>,
    options: {
      readonly flow: W
      readonly payload: Flow.PayloadSchema<W>["~type.make.in"]
    }
  ): Effect.Effect<Token, never, Crypto.Crypto | Flow.PayloadSchema<W>["EncodingServices"]>
} = dual(
  2,
  <
    Success extends Schema.Constraint,
    Error extends Schema.Constraint,
    W extends Flow.Any
  >(
    self: DurableDeferred<Success, Error>,
    options: {
      readonly flow: W
      readonly payload: Flow.PayloadSchema<W>["~type.make.in"]
    }
  ): Effect.Effect<Token, never, Crypto.Crypto | Flow.PayloadSchema<W>["EncodingServices"]> =>
    Effect.map(options.flow.executionId(options.payload), (executionId) =>
      tokenFromExecutionId(self, {
        flow: options.flow,
        executionId
      }))
)

/**
 * Completes the durable deferred identified by a token with the supplied exit,
 * encoding the result through the deferred schemas.
 *
 * The token is not a credential (see {@link Token}): authorize the caller
 * before completing a wait on its behalf.
 *
 * @category combinators
 * @since 0.1.0
 */
export const done: {
  <Success extends Schema.Constraint, Error extends Schema.Constraint>(options: {
    readonly token: Token
    readonly exit: Exit.Exit<Success["Type"], Error["Type"]>
  }): (
    self: DurableDeferred<Success, Error>
  ) => Effect.Effect<
    void,
    TokenInvalid,
    FlowRuntime | Success["EncodingServices"] | Error["EncodingServices"]
  >
  <Success extends Schema.Constraint, Error extends Schema.Constraint>(
    self: DurableDeferred<Success, Error>,
    options: {
      readonly token: Token
      readonly exit: Exit.Exit<Success["Type"], Error["Type"]>
    }
  ): Effect.Effect<
    void,
    TokenInvalid,
    FlowRuntime | Success["EncodingServices"] | Error["EncodingServices"]
  >
} = dual(
  2,
  // Untraced because awaiting a deferred re-enters the scheduler recursively.
  Effect.fnUntraced(function*<
    Success extends Schema.Constraint,
    Error extends Schema.Constraint
  >(
    self: DurableDeferred<Success, Error>,
    options: {
      readonly token: Token
      readonly exit: Exit.Exit<Success["Type"], Error["Type"]>
    }
  ) {
    const token = yield* TokenParsed.parse(options.token)
    if (token.deferredName !== self.name) {
      return yield* Effect.fail(
        new TokenInvalid({
          code: "deferred_mismatch",
          message: `The token addresses deferred "${tokenExcerpt(token.deferredName)}", but it was submitted through ` +
            `deferred "${self.name}".`
        })
      )
    }
    const engine = yield* FlowRuntime
    yield* engine.deferredDone(self, {
      flowName: token.flowName,
      executionId: token.executionId,
      deferredName: token.deferredName,
      exit: options.exit
    })
  })
)

/**
 * Completes the durable deferred identified by a token with a successful
 * value.
 *
 * @category combinators
 * @since 0.1.0
 */
export const succeed: {
  <Success extends Schema.Constraint, Error extends Schema.Constraint>(options: {
    readonly token: Token
    readonly value: Success["Type"]
  }): (
    self: DurableDeferred<Success, Error>
  ) => Effect.Effect<void, TokenInvalid, FlowRuntime | Success["EncodingServices"]>
  <Success extends Schema.Constraint, Error extends Schema.Constraint>(
    self: DurableDeferred<Success, Error>,
    options: {
      readonly token: Token
      readonly value: Success["Type"]
    }
  ): Effect.Effect<void, TokenInvalid, FlowRuntime | Success["EncodingServices"]>
} = dual(
  2,
  <Success extends Schema.Constraint, Error extends Schema.Constraint>(
    self: DurableDeferred<Success, Error>,
    options: {
      readonly token: Token
      readonly value: Success["Type"]
    }
  ): Effect.Effect<void, TokenInvalid, FlowRuntime | Success["EncodingServices"]> =>
    done(self, {
      token: options.token,
      exit: Exit.succeed(options.value)
    })
)

/**
 * Completes the durable deferred identified by a token with a typed failure.
 *
 * @category combinators
 * @since 0.1.0
 */
export const fail: {
  <Success extends Schema.Constraint, Error extends Schema.Constraint>(options: {
    readonly token: Token
    readonly error: Error["Type"]
  }): (
    self: DurableDeferred<Success, Error>
  ) => Effect.Effect<void, TokenInvalid, FlowRuntime | Error["EncodingServices"]>
  <Success extends Schema.Constraint, Error extends Schema.Constraint>(
    self: DurableDeferred<Success, Error>,
    options: {
      readonly token: Token
      readonly error: Error["Type"]
    }
  ): Effect.Effect<void, TokenInvalid, FlowRuntime | Error["EncodingServices"]>
} = dual(
  2,
  <Success extends Schema.Constraint, Error extends Schema.Constraint>(
    self: DurableDeferred<Success, Error>,
    options: {
      readonly token: Token
      readonly error: Error["Type"]
    }
  ): Effect.Effect<void, TokenInvalid, FlowRuntime | Error["EncodingServices"]> =>
    done(self, {
      token: options.token,
      exit: Exit.fail(options.error)
    })
)

/**
 * Completes the durable deferred identified by a token with a failure cause.
 *
 * @category combinators
 * @since 0.1.0
 */
export const failCause: {
  <Success extends Schema.Constraint, Error extends Schema.Constraint>(options: {
    readonly token: Token
    readonly cause: Cause.Cause<Error["Type"]>
  }): (
    self: DurableDeferred<Success, Error>
  ) => Effect.Effect<void, TokenInvalid, FlowRuntime | Error["EncodingServices"]>
  <Success extends Schema.Constraint, Error extends Schema.Constraint>(
    self: DurableDeferred<Success, Error>,
    options: {
      readonly token: Token
      readonly cause: Cause.Cause<Error["Type"]>
    }
  ): Effect.Effect<void, TokenInvalid, FlowRuntime | Error["EncodingServices"]>
} = dual(
  2,
  <Success extends Schema.Constraint, Error extends Schema.Constraint>(
    self: DurableDeferred<Success, Error>,
    options: {
      readonly token: Token
      readonly cause: Cause.Cause<Error["Type"]>
    }
  ): Effect.Effect<void, TokenInvalid, FlowRuntime | Error["EncodingServices"]> =>
    done(self, {
      token: options.token,
      exit: Exit.failCause(options.cause)
    })
)
