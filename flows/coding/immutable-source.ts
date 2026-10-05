/** Shared private immutable-source boundary for command and semantic checks. */
import { Effect, type FileSystem, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CodingError, type Revision } from "./schema.ts"

export const ExportedTree = Schema.Struct({
  commitId: Schema.String,
  changeId: Schema.String,
  treeId: Schema.String,
  path: Schema.String,
  fileCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})

export interface ImmutableSourceOptions {
  readonly repositoryPath: string
  /** Existing trusted host filesystem, captured before action workspace guards. */
  readonly fs: FileSystem.FileSystem
  readonly exporterPath?: string | undefined
  /** Host-selected build environment. No operator/provider credentials by default. */
  readonly environment?: Readonly<Record<string, string>> | undefined
}

const invalid = (message: string) => new CodingError({ code: "invalid_receipt", message })
const outputLimit = 128 * 1024
/** How much of each stream's end a failing check's finding carries to its repair. */
export const outputTailBytes = 4 * 1024
/** A stream's last `outputTailBytes`, in a buffer twice that size so each byte is copied a bounded number of times. */
const tailBuffer = () => {
  const buffer = new Uint8Array(2 * outputTailBytes)
  let length = 0
  return {
    push: (chunk: Uint8Array) => {
      if (chunk.length >= outputTailBytes) {
        buffer.set(chunk.subarray(chunk.length - outputTailBytes))
        length = outputTailBytes
        return
      }
      if (length + chunk.length > buffer.length) {
        buffer.copyWithin(0, length - outputTailBytes, length)
        length = outputTailBytes
      }
      buffer.set(chunk, length)
      length += chunk.length
    },
    bytes: () => buffer.subarray(Math.max(0, length - outputTailBytes), length)
  }
}
/** A cut end starts at the next whole UTF-8 character. */
const decodeTail = (bytes: Uint8Array, cut: boolean) => {
  let start = 0
  while (cut && start < Math.min(3, bytes.length) && (bytes[start]! & 0xc0) === 0x80) start++
  return new TextDecoder().decode(bytes.subarray(start))
}
/** Drain every byte, retaining a bounded prefix for the existing receipt and the stream's bounded end. */
const capture = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  Stream.runFold(
    stream,
    () => ({ text: "", bytes: 0, kept: 0, decoder: new TextDecoder(), tail: tailBuffer() }),
    (state, chunk) => {
      const selected = chunk.subarray(0, Math.max(0, outputLimit - state.kept))
      state.tail.push(chunk)
      return {
        text: state.text + state.decoder.decode(selected, { stream: true }),
        bytes: state.bytes + chunk.length,
        kept: state.kept + selected.length,
        decoder: state.decoder,
        tail: state.tail
      }
    }
  ).pipe(Effect.map((state) => {
    const cut = state.bytes > outputTailBytes
    return {
      text: state.text + state.decoder.decode(),
      truncated: state.bytes > outputLimit,
      tail: { text: decodeTail(state.tail.bytes(), cut), cut }
    }
  }))

const credentialName = /TOKEN|SECRET|PASSWORD|CREDENTIAL|_KEY$/i
const redaction = "[redacted]"

/** Credentials in a process's environment (a check's build-cache read token),
 * which its retained output must never carry. */
export const environmentSecrets = (environment: Readonly<Record<string, string>> | undefined): Array<string> =>
  [
    ...new Set(
      Object.entries(environment ?? {}).flatMap(([name, value]) =>
        credentialName.test(name) && value.length >= 8 ? [value] : []
      )
    )
  ]
    .sort((a, b) => b.length - a.length)

/** Replaces every secret in `text`, and a partial secret of four or more
 * characters at a cut edge: a prefix's end or a tail's start. */
const redact = (
  input: string,
  secrets: ReadonlyArray<string>,
  cut: { readonly start: boolean; readonly end: boolean }
) => {
  let text = input
  for (const secret of secrets) text = text.split(secret).join(redaction)
  for (const secret of secrets) {
    for (let length = Math.min(secret.length - 1, text.length); cut.end && length >= 4; length--) {
      if (text.endsWith(secret.slice(0, length))) {
        text = text.slice(0, text.length - length) + redaction
        break
      }
    }
    for (let length = Math.min(secret.length - 1, text.length); cut.start && length >= 4; length--) {
      if (text.startsWith(secret.slice(secret.length - length))) {
        text = redaction + text.slice(length)
        break
      }
    }
  }
  return text
}

/** Replaces every secret in retained output. A truncated prefix can end inside
 * one, so a trailing partial secret is removed too. */
export const redactOutput = (
  output: { readonly text: string; readonly truncated: boolean },
  secrets: ReadonlyArray<string>
) => ({ text: redact(output.text, secrets, { start: false, end: output.truncated }), truncated: output.truncated })

/** The same redaction for a stream's end. A cut end can start inside a secret,
 * so a leading partial secret is removed too. */
export const redactTail = (
  tail: { readonly text: string; readonly cut: boolean },
  secrets: ReadonlyArray<string>
) => ({ text: redact(tail.text, secrets, { start: tail.cut, end: false }), cut: tail.cut })

export const contained = (root: string, candidate: string, path: Path.Path) => {
  const relative = path.relative(root, candidate)
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}
export const runSourceProcess = (
  options: ImmutableSourceOptions,
  argv: ReadonlyArray<string>,
  cwd: string,
  timeoutMs: number
) =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const process = yield* spawner.spawn(ChildProcess.make(argv[0]!, argv.slice(1), {
      cwd,
      env: options.environment ?? {},
      extendEnv: false,
      stdin: "ignore"
    }))
    const [stdout, stderr, exitCode] = yield* Effect.all([
      capture(process.stdout),
      capture(process.stderr),
      process.exitCode
    ], { concurrency: "unbounded" })
    const secrets = environmentSecrets(options.environment)
    const redacted = (output: typeof stdout) => ({
      ...redactOutput(output, secrets),
      tail: redactTail(output.tail, secrets)
    })
    return { stdout: redacted(stdout), stderr: redacted(stderr), exitCode }
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () =>
        Effect.fail(
          new CodingError({ code: "execution", message: "Revision check process exceeded its declared timeout" })
        )
    })
  )

/** The callback finishes before scoped cleanup. Only captured values may leave. */
export const withImmutableSource = <A, E, R>(
  options: ImmutableSourceOptions,
  revision: Revision,
  use: (tree: typeof ExportedTree.Type, root: string) => Effect.Effect<A, E, R>
) =>
  !/^[0-9a-f]{40}$/.test(revision.commitId) || !/^[0-9a-f]{40}$/.test(revision.treeId)
    ? Effect.fail(invalid("Checks require full immutable native commit and tree IDs"))
    : exportTree(options, revision, use)

/**
 * {@link withImmutableSource} for a commit known only by its full ID, such as
 * the parent a candidate was rebased onto: the export must be that commit, and
 * its tree and change IDs are the exporter's.
 */
export const withImmutableCommit = <A, E, R>(
  options: ImmutableSourceOptions,
  commitId: string,
  use: (tree: typeof ExportedTree.Type, root: string) => Effect.Effect<A, E, R>
) =>
  !/^[0-9a-f]{40}$/.test(commitId)
    ? Effect.fail(invalid("Checks require a full immutable native commit ID"))
    : exportTree(options, { commitId }, use)

const exportTree = <A, E, R>(
  options: ImmutableSourceOptions,
  revision: Pick<Revision, "commitId"> & Partial<Pick<Revision, "treeId" | "changeId">>,
  use: (tree: typeof ExportedTree.Type, root: string) => Effect.Effect<A, E, R>
) =>
  Effect.gen(function*() {
    const fs = options.fs, path = yield* Path.Path
    // Keep dependency hardlinks on the workspace filesystem: Cloud /tmp is a
    // small tmpfs and copying the monorepo dependencies there exhausts it. A
    // confined check reads and writes only inside the workspace root, so the
    // tree is exported under the root's .jj directory, which jj never snapshots.
    const checkCache = path.join(options.repositoryPath, ".jj", "smithers-checks")
    yield* fs.makeDirectory(checkCache, { recursive: true })
    const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "smithers-check-", directory: checkCache })
    const temporaryRoot = yield* fs.realPath(temporary)
    const exported = yield* runSourceProcess(
      options,
      [
        options.exporterPath ?? "/usr/local/bin/smithers-jj-export",
        options.repositoryPath,
        revision.commitId,
        temporaryRoot
      ],
      options.repositoryPath,
      60_000
    )
    if (exported.exitCode !== 0 || exported.stdout.truncated) {
      return yield* invalid(
        `Native immutable tree export failed; no check receipt was accepted${
          exported.stderr.tail.text ? `\n${exported.stderr.tail.text}` : ""
        }`
      )
    }
    const tree = yield* Effect.try({
      try: () => JSON.parse(exported.stdout.text) as unknown,
      catch: () => invalid("Native tree exporter returned no valid identity")
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ExportedTree)),
      Effect.mapError(() => invalid("Native tree exporter returned no valid identity"))
    )
    if (
      tree.commitId !== revision.commitId || (revision.treeId !== undefined && tree.treeId !== revision.treeId) ||
      (revision.changeId !== undefined && tree.changeId !== revision.changeId)
    ) {
      return yield* invalid("Native exported tree does not match the planned revision")
    }
    const root = yield* fs.realPath(tree.path)
    if (root === temporaryRoot || !contained(temporaryRoot, root, path)) {
      return yield* invalid("Native exporter returned a path outside its private temporary directory")
    }
    // A committed symlink into the editing checkout would make old source read
    // live bytes. Inspect links before any check starts; internal aliases are
    // allowed and canonical directories are visited only once.
    const pending = [root], visited = new Set<string>()
    while (pending.length) {
      const directory = pending.pop()!
      if (visited.has(directory)) continue
      visited.add(directory)
      for (const name of yield* fs.readDirectory(directory)) {
        const entry = yield* fs.realPath(path.join(directory, name)).pipe(
          Effect.mapError(() => invalid("Exported source contains an unresolved symbolic link or missing entry"))
        )
        if (!contained(root, entry, path)) {
          return yield* invalid("Exported source contains a symbolic link outside its immutable tree")
        }
        if ((yield* fs.stat(entry)).type === "Directory") pending.push(entry)
      }
    }

    return yield* use(tree, root)
  }).pipe(Effect.scoped)
