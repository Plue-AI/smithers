/**
 * Executes the exact planned Fetch payload. PackageExec owns cache and provenance.
 * @since 1.0.0
 */

import * as EgressHttpClient from "@smthrs/platform-node/EgressHttpClient"
import * as Cause from "effect/Cause"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Stream from "effect/Stream"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import * as NodeUtil from "node:util/types"
import * as Diagnostic from "../../Diagnostic.ts"
import type * as Rule from "../RuleContract.ts"
import * as NativeArtifactOutput from "./NativeArtifactOutput.ts"

/**
 * A typed fetch failure suitable for CLI diagnostics and direct callers.
 *
 * @category errors
 * @since 0.1.0
 */
export class FetchError extends Data.TaggedError("smithers-build/FetchError")<{
  readonly code:
    | "invalid_output"
    | "request_failed"
    | "unexpected_status"
    | "digest_mismatch"
    | "write_failed"
    | "body_too_large"
    | "insecure_redirect"
  readonly expectedSha256: string | undefined
  readonly actualSha256: string | undefined
  readonly message: string
  readonly cause?: unknown
}> {
  /**
   * Constructs a fetch failure without retaining response bytes or secrets.
   *
   * @since 0.1.0
   */
  constructor(
    code:
      | "invalid_output"
      | "request_failed"
      | "unexpected_status"
      | "digest_mismatch"
      | "write_failed"
      | "body_too_large"
      | "insecure_redirect",
    message: string,
    expectedSha256?: string,
    actualSha256?: string,
    options?: ErrorOptions
  ) {
    super({
      code,
      message,
      expectedSha256,
      actualSha256,
      ...(options?.cause === undefined ? {} : { cause: options.cause })
    })
  }
}

/**
 * The most specific readable text in a rejected value's own `cause` chain.
 *
 * Effect's `HttpClientError` keeps its `message` on the prototype, so
 * {@link Diagnostic.message} — which reads own data properties only, on
 * purpose — sees nothing on the outermost value and would report every
 * transport failure with the same generic fallback. The underlying Node error
 * one or two `cause` hops down does carry an own `message`
 * (`connect ECONNREFUSED …`), so the walk recovers the actual reason without
 * ever invoking an accessor.
 */
const transportReason = (cause: unknown, fallback: string): string => {
  let current = cause
  for (let hop = 0; hop < 4; hop += 1) {
    const rendered = Diagnostic.message(current, "")
    if (rendered !== "") return rendered
    if (typeof current !== "object" || current === null || NodeUtil.isProxy(current)) break
    const descriptor = Object.getOwnPropertyDescriptor(current, "cause")
    if (descriptor === undefined || !("value" in descriptor)) break
    current = descriptor.value
  }
  return fallback
}

/**
 * Largest response body one `S.Fetch` will accept, in bytes.
 *
 * A fetch used to call `arrayBuffer` with no bound and no deadline of its own,
 * so a large or endless chunked response exhausted memory or hung until an
 * optional caller-supplied signal fired — and a declared Fetch may pass none.
 * The body is measured as it arrives and abandoned the moment it crosses this
 * line. Accepted bytes stream to a same-directory temporary file rather than
 * accumulating in memory.
 *
 * @category limits
 * @since 0.1.0
 */
export const maximumFetchBytes = 512 * 1024 * 1024

/**
 * How long one fetch may take, in milliseconds, when the caller passed no
 * signal of its own.
 *
 * @category limits
 * @since 0.1.0
 */
export const fetchDeadlineMs = 30 * 60 * 1000

/**
 * Renders a URL without its credentials.
 *
 * The accepted grammar admits userinfo and a query, so a signed S3 URL or a
 * `https://user:token@host/...` form used to land verbatim in CLI output, the
 * reporter's stream, and every cached diagnostic. Only the origin and path
 * survive here; the full value stays in the failure's `cause`.
 *
 * @category rendering
 * @since 0.1.0
 */
export const redactUrl = (url: string): string => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return "<unparsable url>"
  }
  const credentials = parsed.username !== "" || parsed.password !== ""
  const query = parsed.search !== "" || parsed.hash !== ""
  return `${parsed.protocol}//${credentials ? "<redacted>@" : ""}${parsed.host}${parsed.pathname}` +
    `${query ? "?<redacted>" : ""}`
}

/**
 * Most redirects one `S.Fetch` follows before it reports the redirect status.
 *
 * @category limits
 * @since 0.1.0
 */
export const maximumFetchRedirects = 10

/**
 * The URL a redirect leads to, or a refusal to follow it.
 *
 * The sha256 pin stops content substitution but not where the request goes:
 * a followed redirect used to accept any scheme change, so an `https` Fetch
 * could be steered onto cleartext `http`, where anyone on the path reads the
 * URL (a signed query included) and steers every further hop. A redirect must
 * stay on `http` or `https` and never leave `https` once the chain is on it.
 * Cross-host redirects stay allowed: release downloads (GitHub, S3) hop hosts.
 *
 * @category execution
 * @since 0.1.0
 */
export const redirectTarget = (from: string, location: string): string => {
  let next: URL
  try {
    next = new URL(location, from)
  } catch (cause) {
    throw new FetchError(
      "insecure_redirect",
      `Fetch redirect from ${redactUrl(from)} names an unparsable location`,
      undefined,
      undefined,
      { cause }
    )
  }
  const secure = new URL(from).protocol === "https:"
  if (next.protocol !== "https:" && (secure || next.protocol !== "http:")) {
    throw new FetchError(
      "insecure_redirect",
      `Fetch refused a redirect from ${redactUrl(from)} to ${redactUrl(next.href)}: ${
        secure ? "it leaves https" : "it leaves http(s)"
      }`
    )
  }
  return next.href
}

interface DownloadedFile {
  readonly bytes: number
  readonly sha256: string
}

const writeFailure = (destination: string, cause: unknown): FetchError =>
  new FetchError(
    "write_failed",
    `Fetch could not publish ${destination}: ${Diagnostic.describe(cause)}`,
    undefined,
    undefined,
    { cause }
  )

/** Writes one complete response chunk, accounting for partial file writes. */
const writeChunk = async (handle: Fs.FileHandle, chunk: Uint8Array): Promise<void> => {
  let offset = 0
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset, null)
    if (bytesWritten === 0) throw new Error("the temporary fetch file accepted a zero-byte write")
    offset += bytesWritten
  }
}

const downloadedFile = async (
  url: string,
  signal: AbortSignal | undefined,
  temporary: string,
  destination: string,
  limitBytes: number,
  checkParent: () => Promise<void>
): Promise<DownloadedFile> => {
  const safeUrl = redactUrl(url)
  let handle: Fs.FileHandle | undefined
  const openTemporary = async (): Promise<Fs.FileHandle> => {
    if (handle !== undefined) return handle
    await checkParent()
    handle = await Fs.open(temporary, "wx", 0o644)
    return handle
  }
  const effect = Effect.scoped(Effect.gen(function*() {
    const transport = yield* HttpClient.HttpClient
    let current = url
    let response = yield* transport.execute(HttpClientRequest.get(current))
    for (
      let hop = 0;
      hop < maximumFetchRedirects && response.status >= 300 && response.status < 400 &&
      response.headers.location !== undefined;
      hop += 1
    ) {
      const location = response.headers.location
      current = yield* Effect.try({
        try: () => redirectTarget(current, location),
        catch: (cause) => cause as FetchError
      })
      response = yield* transport.execute(HttpClientRequest.get(current))
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(
        new FetchError("unexpected_status", `Fetch request for ${safeUrl} answered HTTP ${response.status}`)
      )
    }
    const declared = response.headers["content-length"]
    if (declared !== undefined && /^\d+$/.test(declared)) {
      const declaredBytes = Number(declared)
      if (Number.isSafeInteger(declaredBytes) && declaredBytes > limitBytes) {
        return yield* Effect.fail(
          new FetchError(
            "body_too_large",
            `Fetch response for ${safeUrl} declares ${declaredBytes} bytes, over the ${limitBytes} limit`
          )
        )
      }
    }
    const hash = createHash("sha256")
    let received = 0
    yield* Stream.runForEach(response.stream, (chunk: Uint8Array) =>
      Effect.tryPromise({
        try: async () => {
          const next = received + chunk.byteLength
          if (next > limitBytes) {
            throw new FetchError(
              "body_too_large",
              `Fetch response for ${safeUrl} exceeded the ${limitBytes} byte limit`
            )
          }
          const output = await openTemporary()
          await writeChunk(output, chunk)
          hash.update(chunk)
          received = next
        },
        catch: (cause) => cause instanceof FetchError ? cause : writeFailure(destination, cause)
      }))
    yield* Effect.tryPromise({
      try: async () => {
        const output = await openTemporary()
        // `open`'s mode is masked by the process umask, but a CAS restore of
        // the same file chmods it to 0o644. Keep a fresh download identical.
        await output.chmod(0o644)
        await output.sync()
        await output.close()
        handle = undefined
      },
      catch: (cause) => writeFailure(destination, cause)
    })
    return { bytes: received, sha256: hash.digest("hex") }
  })).pipe(
    // A declared Fetch is outbound traffic like any other: it leaves through
    // the egress proxy this build's environment names, and directly when it
    // names none.
    Effect.provide(EgressHttpClient.layer(process.env)),
    // A declared Fetch may carry no signal at all, so the request owns a
    // deadline of its own rather than trusting the caller to interrupt it.
    Effect.timeoutOrElse({
      duration: fetchDeadlineMs,
      orElse: () => Effect.fail(new FetchError("request_failed", `Fetch request for ${safeUrl} did not finish in time`))
    })
  )
  try {
    const exit = await Effect.runPromiseExit(effect, { signal })
    if (Exit.isSuccess(exit)) return exit.value
    const cause: unknown = Cause.squash(exit.cause)
    if (cause instanceof FetchError) throw cause
    throw new FetchError(
      "request_failed",
      `Fetch request failed for ${safeUrl}: ${transportReason(cause, "HTTP transport failed")}`,
      undefined,
      undefined,
      { cause }
    )
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined)
  }
}

/**
 * The successful result logged by the package executor.
 *
 * @category models
 * @since 0.1.0
 */
export interface Result {
  readonly bytes: number
  readonly sha256: string
}

/**
 * Executes the Fetch variant selected by the family planner.
 *
 * The request is already reduced: no target declaration is read during dispatch.
 * The public declaration adapter and this contract share one download.
 *
 * @category execution
 * @since 1.0.0
 */
export const execute = (
  node: Rule.Planned<Rule.Fetch>,
  context: Rule.ExecutionContext
): Promise<Result> =>
  download({
    root: context.root,
    signal: context.signal,
    outFile: node.outFiles[0],
    url: node.lane.url,
    sha256: node.lane.sha256
  })

/** The shared transport used by the exact rule and the public declaration adapter.
 * @category execution
 * @since 1.0.0
 */
export const download = async (options: {
  readonly root: string
  readonly url: string
  readonly sha256: string
  readonly outFile: string
  readonly signal?: AbortSignal | undefined
  /** Internal test seam; production callers use {@link maximumFetchBytes}. */
  readonly limitBytes?: number | undefined
}): Promise<Result> => {
  const destination = NodePath.join(options.root, ...options.outFile.split("/"))
  try {
    return await NativeArtifactOutput.publish(options.root, options.outFile, async (temporary, checkParent) => {
      const downloaded = await downloadedFile(
        options.url,
        options.signal,
        temporary,
        destination,
        options.limitBytes ?? maximumFetchBytes,
        checkParent
      )
      if (downloaded.sha256 !== options.sha256) {
        throw new FetchError(
          "digest_mismatch",
          `Fetch sha256 mismatch: expected ${options.sha256}, actual ${downloaded.sha256}`,
          options.sha256,
          downloaded.sha256
        )
      }
      return downloaded
    }, options.signal)
  } catch (cause) {
    throw cause instanceof FetchError ? cause : writeFailure(destination, cause)
  }
}
