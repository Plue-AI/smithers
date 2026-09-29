/**
 * Named Microsandbox disk snapshots: capture a prepared machine, ask whether
 * one exists, and prune a family down to its newest members.
 *
 * A snapshot is the machine's whole root disk. A machine booted from it with
 * the provider's `snapshot` option starts with everything the captured
 * machine had installed, so an expensive preparation runs once per snapshot
 * rather than once per machine. Capture scrubs credential files and refuses a
 * disk that still holds a registered secret, so no credential is restored.
 *
 * Every snapshot this module captures is named `<family>.<member>` by
 * {@link snapshotName}: the family is the preparation the snapshot repeats
 * (one per repository, say) and the member distinguishes its captures. The
 * member never contains the separator, so a name belongs to exactly one
 * family and pruning one family cannot reach another whose name extends it.
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import { attemptIn } from "../internal/attempt.ts"
import { encodeBase64 } from "../internal/base64.ts"
import { runGuest } from "../internal/microsandboxProcess.ts"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import type { Sdk } from "./Sdk.ts"

const attempt = attemptIn("microsandbox")

/** How long the captured machine's graceful stop may take. */
const defaultStopTimeoutMs = 30_000

const isMissingSnapshot = (cause: unknown): boolean =>
  /\[SnapshotNotFound\]/.test(cause instanceof Error ? cause.message : String(cause))

/**
 * The character between a snapshot's family and its member.
 *
 * @category constants
 * @since 1.0.0
 */
export const snapshotSeparator = "."

/**
 * The name of `family`'s `member` snapshot, or `undefined` when the pair
 * cannot name exactly one family's snapshot: an empty part, or a member that
 * contains {@link snapshotSeparator} (it would read as a longer family).
 *
 * @category snapshots
 * @since 1.0.0
 */
export const snapshotName = (family: string, member: string): string | undefined =>
  family.length === 0 || member.length === 0 || member.includes(snapshotSeparator)
    ? undefined
    : `${family}${snapshotSeparator}${member}`

/**
 * The family a snapshot name belongs to: everything before its last
 * {@link snapshotSeparator}. `undefined` for a name this module did not
 * shape.
 *
 * @category snapshots
 * @since 1.0.0
 */
export const snapshotFamily = (name: string): string | undefined => {
  const at = name.lastIndexOf(snapshotSeparator)
  return at <= 0 || at === name.length - 1 ? undefined : name.slice(0, at)
}

/**
 * Files that hold nothing but credentials, relative to a home directory:
 * git's store, netrc, PyPI, GitHub CLI, Cargo, AWS, Google Cloud, and the
 * agent CLIs' sign-ins.
 * {@link captureSnapshot} removes these from every home before it captures.
 * Files that mix credentials with configuration, such as `.npmrc` or Docker's
 * `config.json`, stay; the secret search refuses one that holds a token.
 */
const credentialFiles: ReadonlyArray<string> = [
  ".git-credentials",
  ".netrc",
  ".pypirc",
  ".config/gh/hosts.yml",
  ".cargo/credentials.toml",
  ".aws/credentials",
  ".config/gcloud/application_default_credentials.json",
  ".config/gcloud/credentials.db",
  ".config/gcloud/access_tokens.db",
  ".claude/.credentials.json",
  ".codex/auth.json",
  ".gemini/oauth_creds.json",
  ".config/github-copilot/hosts.json",
  ".config/github-copilot/apps.json",
  ".local/share/opencode/auth.json"
]

/**
 * Removes {@link credentialFiles} from `/root` and every `/home/*`, then,
 * with patterns on standard input, lists every file under `/` outside the
 * kernel's own trees whose bytes hold one: grep exits 0 with a list, 1 with
 * none, 2 when it could not search. Paths are relative because the command
 * runs at `/`.
 */
const scrubScript = (search: boolean): string =>
  [
    `for home in root home/*; do rm -f -- ${
      credentialFiles.map((file) => `"$home/${file}"`).join(" ")
    } || exit 2; done`,
    ...search
      ? [
        "set --",
        `for entry in * .[!.]* ..?*; do case "$entry" in proc|sys|dev) ;; *) if [ -e "$entry" ]; then set -- "$@" "$entry"; fi ;; esac; done`,
        `grep -rlF -f - -- "$@"`
      ]
      : []
  ].join("\n")

/** The fewest bytes a secret's searched line may hold; a shorter one would match unrelated files. */
const minimumPatternBytes = 8

const encoder = new TextEncoder()

/**
 * The base64 characters `line` determines wherever it sits in an encoded
 * stream: one run per byte alignment (0, 1, or 2 bytes before it), cut to the
 * characters no neighbouring byte touches.
 */
const base64Forms = (line: string): ReadonlyArray<string> => {
  const bytes = encoder.encode(line)
  return [0, 1, 2].map((lead) => {
    const padded = new Uint8Array(lead + bytes.length)
    padded.set(bytes, lead)
    const whole = Math.floor(padded.length / 3) * 4
    return encodeBase64(padded).slice(lead === 0 ? 0 : lead + 1, whole)
  })
}

/**
 * Each line is searched raw and in the encodings preparation tools commonly
 * write a token in: base64 and base64url at every alignment (Basic auth,
 * Docker's `auths`, Kubernetes secrets), percent-encoding (URLs, form bodies),
 * and JSON string escaping.
 */
const encodedForms = (line: string): ReadonlyArray<string> => {
  const base64 = base64Forms(line)
  return [
    line,
    ...base64,
    ...base64.map((form) => form.replaceAll("+", "-").replaceAll("/", "_")),
    encodeURIComponent(line),
    JSON.stringify(line).slice(1, -1)
  ].filter((form) => encoder.encode(form).length >= minimumPatternBytes)
}

/**
 * What the disk is searched for: each secret's longest line, raw and in its
 * {@link encodedForms}. A multi-line secret such as a PEM key is found by its
 * body, not by an armor or brace line any file might hold. `tooShort` names
 * the first secret whose longest line is too short to search for.
 */
const secretPatterns = (
  secrets: ReadonlyArray<string>
): { readonly patterns: ReadonlyArray<string> } | { readonly tooShort: number } => {
  const patterns: Array<string> = []
  for (const [index, secret] of secrets.entries()) {
    const longest = secret.split(/\r?\n/).reduce((best, line) => line.length > best.length ? line : best, "")
    if (encoder.encode(longest).length < minimumPatternBytes) return { tooShort: index }
    patterns.push(...encodedForms(longest))
  }
  return { patterns: [...new Set(patterns)] }
}

/**
 * Scrubs the machine's credential files, then refuses when any secret's
 * pattern is still anywhere on its disk, naming the files that hold one.
 */
const scrubbed = (
  sandbox: Awaited<ReturnType<Awaited<ReturnType<Sdk["Sandbox"]["get"]>>["connect"]>>,
  patterns: ReadonlyArray<string>,
  machine: string,
  name: string
): Effect.Effect<void, ProviderError> => {
  const searched = `the disk of ${machine} could not be scrubbed of credentials`
  return Effect.flatMap(
    runGuest(sandbox, {
      program: "/bin/sh",
      args: ["-c", scrubScript(patterns.length > 0)],
      cwd: "/",
      env: {},
      stdin: patterns.length > 0 ? encoder.encode(`${patterns.join("\n")}\n`) : undefined
    }, searched),
    ({ code, stderr, stdout }) => {
      // grep lists what it found even when it could not read every file.
      const found = new TextDecoder().decode(stdout).split("\n").filter((line) => line.length > 0)
      if (found.length === 0 && code === (patterns.length > 0 ? 1 : 0)) return Effect.void
      return Effect.fail(
        new ProviderError({
          code: "unavailable",
          message: found.length > 0
            ? `microsandbox: the microVM ${machine} was not captured as ${name}: a secret is still on its disk at ${
              found.map((path) => `/${path}`).join(", ")
            }`
            : `microsandbox: ${searched} (exit ${code}): ${stderr.trim()}`
        })
      )
    }
  )
}

/**
 * What {@link captureSnapshot} captures and names.
 *
 * @category models
 * @since 1.0.0
 */
export interface CaptureOptions {
  /** The injected Microsandbox SDK module. */
  readonly sdk: Sdk
  /** The machine's Microsandbox name (a session's `remoteId`). */
  readonly machine: string
  /** The family the snapshot joins; {@link pruneSnapshots} prunes by it. */
  readonly family: string
  /** What tells this capture from the family's others; never contains {@link snapshotSeparator}. */
  readonly member: string
  /**
   * Every credential value the machine was handed while it was prepared. The
   * capture is refused while any of them is still on its disk. Empty states
   * that preparation ran without credentials. Each value's longest line is
   * what is searched for and must hold at least 8 bytes.
   */
  readonly secrets: ReadonlyArray<string>
  /** How long the machine's graceful stop may take. Default 30000. */
  readonly stopTimeoutMs?: number | undefined
}

/**
 * Captures a prepared machine's root disk as the snapshot
 * {@link snapshotName} names, removes the machine, and returns that name.
 *
 * A snapshot is restored into every later machine, so a credential left on
 * the disk would reach all of them. Before the capture the machine is started
 * if stopped, the credential files of `/root` and every `/home/*` are removed
 * (git's store, `.netrc`, `.pypirc`, GitHub CLI, Cargo, AWS, Google Cloud,
 * and the Claude, Codex, Gemini, Copilot, and OpenCode sign-ins), and the
 * whole disk is searched for the longest line of every value in `secrets`,
 * raw, base64 or base64url at any alignment, percent-encoded, or
 * JSON-escaped; a value still found anywhere
 * refuses the capture and names the files, never the value. A secret whose
 * longest line is under 8 bytes is refused before any guest call. Hand credentials
 * to later machines at run time, after the restore.
 *
 * The machine is removed whether or not the capture succeeded. A family and
 * member that cannot name a snapshot fail with `unavailable` before any
 * vendor call, and the machine stays.
 *
 * @category snapshots
 * @since 1.0.0
 */
export const captureSnapshot = (options: CaptureOptions): Effect.Effect<string, ProviderError> => {
  const name = snapshotName(options.family, options.member)
  if (name === undefined) {
    return Effect.fail(
      new ProviderError({
        code: "unavailable",
        message: `microsandbox: family ${JSON.stringify(options.family)} and member ${
          JSON.stringify(options.member)
        } do not name a snapshot; both are non-empty and the member has no ${JSON.stringify(snapshotSeparator)}`
      })
    )
  }
  const searched = secretPatterns(options.secrets)
  if ("tooShort" in searched) {
    return Effect.fail(
      new ProviderError({
        code: "unavailable",
        message: `microsandbox: secret ${searched.tooShort} has no line of ${minimumPatternBytes} or more bytes ` +
          `to search ${options.machine}'s disk for`
      })
    )
  }
  const failed = `the microVM ${options.machine} could not be captured as ${name}`
  return Effect.flatMap(
    attempt(() => options.sdk.Sandbox.get(options.machine), "unavailable", failed),
    (handle) =>
      Effect.flatMap(
        Effect.exit(Effect.gen(function*() {
          const sandbox = yield* attempt(
            () => handle.status === "running" ? handle.connect() : handle.start(),
            "unavailable",
            failed
          )
          yield* scrubbed(sandbox, searched.patterns, options.machine, name)
          yield* attempt(
            async () => {
              await handle.stop()
              await handle.snapshot(name)
            },
            "unavailable",
            failed
          )
          return name
        })),
        (exit) =>
          Effect.andThen(
            attempt(
              () => handle.destroy({ timeoutMs: options.stopTimeoutMs ?? defaultStopTimeoutMs, force: true }),
              "unavailable",
              failed
            ),
            exit
          )
      )
  )
}

/**
 * Whether a snapshot of that name exists.
 *
 * @category snapshots
 * @since 1.0.0
 */
export const hasSnapshot = (sdk: Sdk, name: string): Effect.Effect<boolean, ProviderError> =>
  Effect.tryPromise({
    try: () => sdk.Snapshot.get(name),
    catch: (cause) => cause
  }).pipe(
    Effect.as(true),
    Effect.catch((cause) =>
      isMissingSnapshot(cause)
        ? Effect.succeed(false)
        : Effect.fail(
          new ProviderError({ code: "unavailable", message: `microsandbox: snapshot ${name} could not be read`, cause })
        )
    )
  )

/**
 * Removes `family`'s snapshots (those {@link snapshotFamily} places in it,
 * exactly), except the `keep` newest and any named in `retain` (snapshots a
 * machine is about to boot from), and returns the removed names. Another
 * family whose name extends this one is never touched.
 *
 * @category snapshots
 * @since 1.0.0
 */
export const pruneSnapshots = (
  sdk: Sdk,
  family: string,
  keep: number,
  retain: ReadonlyArray<string> = []
): Effect.Effect<ReadonlyArray<string>, ProviderError> =>
  attempt(
    async () => {
      const members = (await sdk.Snapshot.list())
        .flatMap((entry) =>
          entry.name !== null && snapshotFamily(entry.name) === family
            ? [{ name: entry.name, createdAt: entry.createdAt }]
            : []
        )
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      const removed: Array<string> = []
      for (const { name } of members.slice(Math.max(0, keep))) {
        if (retain.includes(name)) continue
        await sdk.Snapshot.remove(name, { force: true })
        removed.push(name)
      }
      return removed
    },
    "unavailable",
    `the snapshot family ${family} could not be pruned`
  )

/**
 * Removes the named snapshot; one that is already gone is not an error.
 *
 * @category snapshots
 * @since 1.0.0
 */
export const removeSnapshot = (sdk: Sdk, name: string): Effect.Effect<void, ProviderError> =>
  Effect.tryPromise({ try: () => sdk.Snapshot.remove(name, { force: true }), catch: (cause) => cause }).pipe(
    Effect.catch((cause) =>
      isMissingSnapshot(cause)
        ? Effect.void
        : Effect.fail(
          new ProviderError({
            code: "unavailable",
            message: `microsandbox: snapshot ${name} could not be removed`,
            cause
          })
        )
    )
  )
