/**
 * The durable copy of the deployment's Alchemy state, kept in R2.
 *
 * Alchemy maps each logical resource to the physical Worker, D1 database, and
 * R2 bucket it created only through its state. State that lives on one
 * operator's disk is lost with that disk, and the next deployment from any
 * other machine creates a second production instead of updating the first.
 *
 * The deploy wrapper therefore treats the local state directory as a working
 * copy of one snapshot object in R2. It takes a remote lock, pulls the
 * snapshot over the local directory, runs Alchemy, redacts, and publishes the
 * snapshot back with a compare-and-swap on the version it pulled. The remote
 * copy only ever receives redacted state. The shared `alchemy-state-store`
 * Worker is not used because reading its bearer needs Cloudflare Secrets Store
 * access, which the deploy token does not have; R2 needs only the R2 access the
 * deployment already requires.
 *
 * @since 0.1.0
 */

import { errorCode } from "@smthrs/targets/SafeFs"
import { AwsClient } from "aws4fetch"
import * as Data from "effect/Data"
import { createHash } from "node:crypto"
import type { Dirent } from "node:fs"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import { stackName } from "../deployment.ts"

/**
 * The R2 bucket holding the deployment's Alchemy state.
 *
 * It is created once by hand, outside this stack, because the stack's own
 * state cannot record the bucket that holds it.
 *
 * @category constants
 * @since 0.1.0
 */
export const stateBucketName = "smithers-build-infra-state"

/**
 * The object holding the stack's state snapshot. Its lock is the same key
 * with `.lock` appended.
 *
 * @category constants
 * @since 0.1.0
 */
export const stateObjectKey = `alchemy/${stackName}.json`

const snapshotFormat = "smithers-alchemy-state/1"

/**
 * The precondition a state write must satisfy: the object is still at the
 * version that was read, or no object exists yet.
 *
 * @category models
 * @since 0.1.0
 */
export type PutCondition = { readonly ifMatch: string } | { readonly ifAbsent: true }

/**
 * One stored object and the version it was read at.
 *
 * @category models
 * @since 0.1.0
 */
export interface StateObject {
  readonly body: string
  readonly etag: string
}

/**
 * The object store the state snapshot and its lock live in.
 *
 * @category models
 * @since 0.1.0
 */
export interface StateBucket {
  /** Reads an object, or `undefined` when none exists. */
  readonly get: (key: string) => Promise<StateObject | undefined>
  /** Writes an object when `condition` holds; `false` when it does not. */
  readonly put: (key: string, body: string, condition: PutCondition) => Promise<boolean>
  /** Deletes an object; an absent object is already deleted. */
  readonly delete: (key: string) => Promise<void>
}

/**
 * Where one stack's durable state lives.
 *
 * @category models
 * @since 0.1.0
 */
export interface RemoteState {
  readonly bucket: StateBucket
  readonly key: string
}

/**
 * An in-process {@link StateBucket} with the same conditional-write rules as
 * R2. The suites use it in place of the real bucket.
 *
 * @category constructors
 * @since 0.1.0
 */
export const memoryStateBucket = (): StateBucket & { readonly objects: Map<string, StateObject> } => {
  const objects = new Map<string, StateObject>()
  let version = 0
  return {
    objects,
    get: async (key) => objects.get(key),
    put: async (key, body, condition) => {
      const current = objects.get(key)
      const holds = "ifAbsent" in condition ? current === undefined : current?.etag === condition.ifMatch
      if (!holds) return false
      version += 1
      objects.set(key, { body, etag: `"${version}"` })
      return true
    },
    delete: async (key) => {
      objects.delete(key)
    }
  }
}

/**
 * The R2 bucket and the S3 credentials that reach it.
 *
 * @category models
 * @since 0.1.0
 */
export interface R2StateBucketOptions {
  readonly accountId: string
  readonly bucket: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly fetch: typeof globalThis.fetch
}

/**
 * A refusal to condition a state write on a weak ETag.
 *
 * R2 serves a gzip-compressed object with a weak ETag (`W/"…"`) and answers
 * every `If-Match` on a weak ETag with 412, so a compare-and-swap on one can
 * never succeed and would read as a concurrent deployment.
 *
 * @category errors
 * @since 0.1.0
 */
export class WeakEtagError extends Data.TaggedError("@smthrs/build-infra/WeakEtagError")<{
  readonly key: string
  readonly etag: string
}> {
  override readonly name = "WeakEtagError"
  override get message(): string {
    return `R2 state ${this.key} carries the weak ETag ${this.etag}, which R2 never matches on a conditional write`
  }
}

const isWeakEtag = (etag: string): boolean => etag.startsWith("W/")

const describeFailure = async (method: string, key: string, response: Response): Promise<Error> =>
  new Error(`R2 state ${method} ${key} answered ${response.status}: ${(await response.text()).slice(0, 200)}`)

/**
 * A {@link StateBucket} over R2's S3 API, which honours `If-Match` and
 * `If-None-Match` on writes. Cloudflare's REST object API ignores both, so it
 * cannot hold a lock or a compare-and-swap.
 *
 * Reads ask for `accept-encoding: identity`. Otherwise R2 serves the object
 * gzip-compressed with a weak ETag that no `If-Match` accepts, and the state
 * could never be saved back. A weak ETag is refused with a
 * {@link WeakEtagError} on read and as a write condition.
 *
 * @category constructors
 * @since 0.1.0
 */
export const r2StateBucket = (options: R2StateBucketOptions): StateBucket => {
  const client = new AwsClient({
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    service: "s3",
    region: "auto"
  })
  const fetch = options.fetch
  const url = (key: string): string =>
    `https://${options.accountId}.r2.cloudflarestorage.com/${options.bucket}/${
      key.split("/").map(encodeURIComponent).join("/")
    }`
  const send = async (key: string, init: RequestInit): Promise<Response> => fetch(await client.sign(url(key), init))
  return {
    get: async (key) => {
      const response = await send(key, { method: "GET", headers: { "accept-encoding": "identity" } })
      if (response.status === 404) {
        await response.body?.cancel()
        return undefined
      }
      if (!response.ok) throw await describeFailure("GET", key, response)
      const etag = response.headers.get("etag")
      const body = await response.text()
      if (etag === null) throw new Error(`R2 state GET ${key} returned no ETag, so no write can be conditioned on it`)
      if (isWeakEtag(etag)) throw new WeakEtagError({ key, etag })
      return { body, etag }
    },
    put: async (key, body, condition) => {
      if ("ifMatch" in condition && isWeakEtag(condition.ifMatch)) {
        throw new WeakEtagError({ key, etag: condition.ifMatch })
      }
      const headers = "ifAbsent" in condition ? { "if-none-match": "*" } : { "if-match": condition.ifMatch }
      const response = await send(key, {
        method: "PUT",
        body,
        headers: { ...headers, "content-type": "application/json" }
      })
      if (response.status === 412) {
        await response.body?.cancel()
        return false
      }
      if (!response.ok) throw await describeFailure("PUT", key, response)
      await response.body?.cancel()
      return true
    },
    delete: async (key) => {
      const response = await send(key, { method: "DELETE" })
      if (!response.ok && response.status !== 404) throw await describeFailure("DELETE", key, response)
      await response.body?.cancel()
    }
  }
}

const verifiedTokenId = async (
  fetch: typeof globalThis.fetch,
  url: string,
  apiToken: string
): Promise<string | undefined> => {
  const response = await fetch(url, { headers: { authorization: `Bearer ${apiToken}` } })
  const payload = (await response.json()) as { success?: boolean; result?: { id?: unknown } }
  return payload.success === true && typeof payload.result?.id === "string" ? payload.result.id : undefined
}

/**
 * Derives R2 S3 credentials from a Cloudflare API token.
 *
 * R2 accepts an API token as S3 credentials: the token's id is the access key
 * id and the SHA-256 of its value is the secret. The id comes from
 * Cloudflare's own verification, first as an account token, then as a user
 * token, so the deployment needs no second secret.
 *
 * @category constructors
 * @since 0.1.0
 */
export const r2CredentialsFromApiToken = async (options: {
  readonly apiToken: string
  readonly accountId: string
  readonly fetch: typeof globalThis.fetch
}): Promise<{ readonly accessKeyId: string; readonly secretAccessKey: string }> => {
  const api = "https://api.cloudflare.com/client/v4"
  const accessKeyId =
    (await verifiedTokenId(options.fetch, `${api}/accounts/${options.accountId}/tokens/verify`, options.apiToken)) ??
      (await verifiedTokenId(options.fetch, `${api}/user/tokens/verify`, options.apiToken))
  if (accessKeyId === undefined) {
    throw new Error("Cloudflare did not verify CLOUDFLARE_API_TOKEN, so it cannot reach the R2 state bucket")
  }
  return { accessKeyId, secretAccessKey: createHash("sha256").update(options.apiToken, "utf8").digest("hex") }
}

/**
 * The production remote state, reached with the deploying shell's Cloudflare
 * credentials.
 *
 * @category constructors
 * @since 0.1.0
 */
export const remoteStateFromEnvironment = async (
  env: NodeJS.ProcessEnv = process.env,
  fetch: typeof globalThis.fetch = globalThis.fetch
): Promise<RemoteState> => {
  const apiToken = env["CLOUDFLARE_API_TOKEN"]
  const accountId = env["CLOUDFLARE_ACCOUNT_ID"]
  if (apiToken === undefined || apiToken === "") {
    throw new Error("CLOUDFLARE_API_TOKEN is required to reach the R2 state bucket")
  }
  if (accountId === undefined || accountId === "") {
    throw new Error("CLOUDFLARE_ACCOUNT_ID is required to reach the R2 state bucket")
  }
  const credentials = await r2CredentialsFromApiToken({ apiToken, accountId, fetch })
  return {
    bucket: r2StateBucket({ accountId, bucket: stateBucketName, ...credentials, fetch }),
    key: stateObjectKey
  }
}

/** Every `.json` state file under `directory`, relative to it with `/` separators. */
const stateFiles = async (directory: string, prefix = ""): Promise<Array<string>> => {
  let entries: Array<Dirent>
  try {
    entries = await Fs.readdir(NodePath.join(directory, prefix), { withFileTypes: true })
  } catch (error) {
    // A stack that has never been deployed has no state directory yet.
    if (errorCode(error) === "ENOENT") return []
    throw error
  }
  const files: Array<string> = []
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`
    if (entry.isSymbolicLink()) {
      throw new TypeError(`Alchemy state contains a symbolic link, which a snapshot will not follow: ${relative}`)
    }
    if (entry.isDirectory()) files.push(...(await stateFiles(directory, relative)))
    else if (entry.isFile() && entry.name.endsWith(".json")) files.push(relative)
  }
  return files
}

const renderSnapshot = (files: Record<string, string>): string => {
  const sorted = Object.fromEntries(Object.keys(files).sort().map((file) => [file, files[file]!]))
  return JSON.stringify({ format: snapshotFormat, files: sorted }, null, 2)
}

/**
 * Serializes every Alchemy state file under a stack's state directory.
 *
 * The rendering is deterministic, so a run that changed nothing renders the
 * bytes it pulled and publishes nothing. Lock files and Alchemy's temporary
 * siblings are not state and are left out.
 *
 * @category utilities
 * @since 0.1.0
 */
export const readStateSnapshot = async (directory: string): Promise<string> => {
  const files: Record<string, string> = {}
  for (const file of await stateFiles(directory)) {
    files[file] = await Fs.readFile(NodePath.join(directory, ...file.split("/")), "utf8")
  }
  return renderSnapshot(files)
}

const safeSegment = (segment: string): boolean =>
  segment !== "" && segment !== "." && segment !== ".." && !/[\\\u0000-\u001f]/.test(segment)

const parseSnapshot = (body: string): Record<string, string> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new TypeError("remote Alchemy state is not JSON")
  }
  if (typeof parsed !== "object" || parsed === null || (parsed as { format?: unknown }).format !== snapshotFormat) {
    throw new TypeError(`remote Alchemy state is not a ${snapshotFormat} snapshot`)
  }
  const files = (parsed as { files?: unknown }).files
  if (typeof files !== "object" || files === null || Array.isArray(files)) {
    throw new TypeError("remote Alchemy state has no file map")
  }
  for (const [file, contents] of Object.entries(files)) {
    if (typeof contents !== "string") throw new TypeError(`remote Alchemy state file ${file} is not text`)
    if (!file.endsWith(".json") || !file.split("/").every(safeSegment)) {
      throw new TypeError(`remote Alchemy state names a path outside the stack: ${JSON.stringify(file)}`)
    }
    for (let separator = file.indexOf("/"); separator !== -1; separator = file.indexOf("/", separator + 1)) {
      const ancestor = file.slice(0, separator)
      if (Object.prototype.hasOwnProperty.call(files, ancestor)) {
        throw new TypeError(
          `remote Alchemy state file ${JSON.stringify(ancestor)} is an ancestor of ${JSON.stringify(file)}`
        )
      }
    }
  }
  return files as Record<string, string>
}

/**
 * Replaces every Alchemy state file under `directory` with a snapshot's.
 *
 * The snapshot is validated in full before any local file changes, so a
 * refused snapshot leaves local state as it was. Files that are not state,
 * such as the ownership lock, are kept.
 *
 * @throws A `TypeError` when the snapshot is not one this module rendered, or
 * names a path outside the directory or a file that is another file's ancestor.
 * @category utilities
 * @since 0.1.0
 */
export const writeStateSnapshot = async (directory: string, body: string): Promise<void> => {
  const files = parseSnapshot(body)
  for (const file of await stateFiles(directory)) {
    await Fs.rm(NodePath.join(directory, ...file.split("/")))
  }
  for (const [file, contents] of Object.entries(files)) {
    const target = NodePath.join(directory, ...file.split("/"))
    await Fs.mkdir(NodePath.dirname(target), { recursive: true })
    await Fs.writeFile(target, contents, { encoding: "utf8", mode: 0o600 })
  }
}

/**
 * Who holds the remote lock, recorded in the lock object.
 *
 * @category models
 * @since 0.1.0
 */
export interface LockHolder {
  readonly host: string
  readonly pid: number
  readonly startedAt: string
}

/**
 * One deployment's hold on the remote state.
 *
 * @category models
 * @since 0.1.0
 */
export interface RemoteStateSession {
  /** Publishes local state when it differs from what was pulled. */
  readonly push: () => Promise<"published" | "unchanged">
  /** Deletes the remote lock. */
  readonly release: () => Promise<void>
}

const describeHolder = (body: string): string => {
  try {
    const holder = JSON.parse(body) as LockHolder
    if (typeof holder.host === "string" && typeof holder.pid === "number") {
      return `${holder.host} pid ${holder.pid} since ${String(holder.startedAt)}`
    }
  } catch {
    // Reported below as unreadable.
  }
  return "an unreadable holder"
}

/**
 * Locks the remote state and pulls it over the local state directory.
 *
 * A held lock refuses the caller with its holder. When no snapshot exists yet,
 * local state is left as it is and becomes the first snapshot on push, which
 * is how a stack's existing local state moves to R2. The lock is released if
 * the pull fails.
 *
 * @category constructors
 * @since 0.1.0
 */
export const openRemoteState = async (
  remote: RemoteState,
  directory: string,
  holder: LockHolder
): Promise<RemoteStateSession> => {
  const lockKey = `${remote.key}.lock`
  if (!(await remote.bucket.put(lockKey, JSON.stringify(holder), { ifAbsent: true }))) {
    const current = await remote.bucket.get(lockKey)
    if (current === undefined) {
      throw new Error(`remote Alchemy state lock ${lockKey} was released while it was read; retry the deployment`)
    }
    throw new Error(
      `remote Alchemy state is locked by ${describeHolder(current.body)}; delete ${stateBucketName}/${lockKey} ` +
        `only once that deployment is gone`
    )
  }
  const release = (): Promise<void> => remote.bucket.delete(lockKey)
  let pulled: StateObject | undefined
  try {
    pulled = await remote.bucket.get(remote.key)
    if (pulled !== undefined) await writeStateSnapshot(directory, pulled.body)
  } catch (error) {
    await release()
    throw error
  }
  const baseline = pulled === undefined ? renderSnapshot({}) : await readStateSnapshot(directory)
  return {
    push: async () => {
      const snapshot = await readStateSnapshot(directory)
      if (snapshot === baseline) return "unchanged"
      const condition: PutCondition = pulled === undefined ? { ifAbsent: true } : { ifMatch: pulled.etag }
      if (!(await remote.bucket.put(remote.key, snapshot, condition))) {
        throw new Error(
          `remote Alchemy state ${remote.key} changed during this deployment; local state was kept in ${directory}`
        )
      }
      return "published"
    },
    release
  }
}
