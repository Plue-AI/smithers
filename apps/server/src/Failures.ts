import * as Data from "effect/Data"

/*
 * The typed failures every service in this Worker speaks. Each one names a
 * seam or an operation and carries the native cause, so a route can map it to
 * the HTTP answer the contract requires without inspecting `Error` prototypes.
 *
 * Interruption is never one of these: a fiber interrupted because the client
 * went away, or because a deadline elsewhere won, stays an interruption and is
 * settled at the Web boundary (src/Boundary.ts), never restated as a 500.
 */

/** An upstream did not send headers before the seam's deadline. */
export class UpstreamTimeout extends Data.TaggedError("UpstreamTimeout")<{
  readonly seam: string
  readonly timeoutMs: number
}> {
  override get message(): string {
    return `${this.seam} did not answer within ${this.timeoutMs}ms.`
  }
}

/** The connection to an upstream failed outright (DNS, TLS, reset, abort). */
export class UpstreamUnreachable extends Data.TaggedError("UpstreamUnreachable")<{
  readonly seam: string
  readonly cause: unknown
}> {
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : `${this.seam} is unreachable.`
  }
}

export type UpstreamFailure = UpstreamTimeout | UpstreamUnreachable

/** A request body past the route's byte ceiling, measured in bytes, not characters. */
export class BodyTooLarge extends Data.TaggedError("BodyTooLarge")<{
  readonly limit: number
}> {}

/** A body whose stream failed before it ended. */
export class BodyUnreadable extends Data.TaggedError("BodyUnreadable")<{
  readonly cause: unknown
}> {}

/** A body that was read whole and is not JSON. */
export class BodyNotJson extends Data.TaggedError("BodyNotJson")<{
  readonly cause: unknown
}> {}

export type BodyFailure = BodyTooLarge | BodyUnreadable | BodyNotJson

/** A Durable Object storage or stub call that threw. */
export class StorageFailure extends Data.TaggedError("StorageFailure")<{
  readonly operation: string
  readonly cause: unknown
}> {
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : `${this.operation} failed`
  }
}
