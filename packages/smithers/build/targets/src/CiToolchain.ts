/**
 * What a generated CI job needs before it can run a target.
 *
 * A hosted runner starts empty. Something has to check the tree out, install an
 * interpreter, install the workspace, and put `cargo` or `jj` on `PATH` before
 * the first target executes. That "something" used to be a list of hand-written
 * steps in a PACKAGE.ts file, half `uses:` references and half shell.
 *
 * This module replaces the list with a declaration of what the job REQUIRES.
 * {@link GithubCiGen} derives the steps: the install argv comes from
 * {@link PackageManager.install}, the interpreter version from the declared
 * {@link Runtime}, the Rust install from {@link RustToolchain.install}. A
 * PACKAGE.ts file states requirements; only the generator knows how a runner
 * satisfies them, which is the same division {@link Runtime} draws between a
 * declared requirement and the service that measures the host.
 *
 * Every version a runner downloads is enumerated here rather than written as
 * free text, for the reason {@link Runtime.NodeVersion} is enumerated: the set
 * of versions a workspace may pin is reviewed. A pin that names a release the
 * publisher does not have is a CI failure at 03:00; a pin that is not in this
 * list is a type error at the call site.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"
import * as Attr from "./Attr.ts"
import * as NixDeclaration from "./Nix.ts"
import * as Runtime from "./Runtime.ts"
import * as RustToolchain from "./RustToolchain.ts"
import * as Secret from "./Secret.ts"

/**
 * Schema for the Node releases a runner may install.
 *
 * The entry is the floor `Runtime.NodeVersion` requires, spelled as the exact
 * release the setup action downloads. A range would let the runner resolve a
 * version nobody chose.
 *
 * @category schemas
 * @since 0.1.0
 */
export const NodeRelease = Schema.Literals(["26.4.0"])

/**
 * The Node releases a runner may install.
 *
 * @category models
 * @since 0.1.0
 */
export type NodeRelease = typeof NodeRelease.Type

/**
 * Schema for a workspace-relative file naming the Node release to install.
 *
 * The alternative to `NodeRelease`: rather than repeat an exact release in the
 * workflow, the job points `actions/setup-node` at a file the repository
 * already keeps, so the workflow, the shell bootstrap and a developer's
 * version manager all read one number. `.node-version` is the conventional
 * name and the one fnm, nvm and asdf look for.
 *
 * {@link Node} refuses anything but a workspace-relative path: no leading
 * slash and no `..`, because a workflow reads it from the checkout root.
 *
 * @category schemas
 * @since 1.0.0
 */
export const NodeVersionFile = Schema.String

/**
 * A workspace-relative file naming the Node release to install.
 *
 * @category models
 * @since 1.0.0
 */
export type NodeVersionFile = typeof NodeVersionFile.Type

/**
 * npm releases certified with the packed optional-peer consumer matrix.
 *
 * @category schemas
 * @since 1.0.0
 */
export const NpmRelease = Schema.Literals(["11.16.0"])

/**
 * A certified npm release installed alongside the declared Node runtime.
 *
 * @category models
 * @since 1.0.0
 */
export type NpmRelease = typeof NpmRelease.Type

/**
 * Schema for the Bun releases a runner may install.
 *
 * The pin has to name a published `oven-sh/bun` release: the setup action
 * downloads the release asset, so a version that exists only as a local build
 * 404s.
 *
 * @category schemas
 * @since 0.1.0
 */
export const BunRelease = Schema.Literals(["1.4.1"])

/**
 * The Bun releases a runner may install.
 *
 * @category models
 * @since 0.1.0
 */
export type BunRelease = typeof BunRelease.Type

/**
 * Schema for a declared Node installation.
 *
 * `release` is the exact interpreter the runner installs; the workspace's own
 * `runtime` declaration is the floor it must satisfy and is optional here,
 * because a PACKAGE.ts no longer restates the workspace toolchain.
 * `cachePackageStore` asks the setup action to restore the package manager's
 * store, which only a job that installs the workspace should do.
 *
 * @category schemas
 * @since 0.1.0
 */
export const NodeSetup = Schema.Struct({
  name: Schema.Literal("node"),
  runtime: Schema.optional(Runtime.NodeRuntime),
  release: Schema.optional(NodeRelease),
  versionFile: Schema.optional(NodeVersionFile),
  npmRelease: Schema.optional(NpmRelease),
  cachePackageStore: Schema.Boolean
})

/**
 * One declared Node installation.
 *
 * @category models
 * @since 0.1.0
 */
export type NodeSetup = typeof NodeSetup.Type

/**
 * Schema for a declared Bun installation.
 *
 * @category schemas
 * @since 0.1.0
 */
export const BunSetup = Schema.Struct({
  name: Schema.Literal("bun"),
  runtime: Schema.optional(Runtime.BunRuntime),
  release: BunRelease
})

/**
 * One declared Bun installation.
 *
 * @category models
 * @since 0.1.0
 */
export type BunSetup = typeof BunSetup.Type

/**
 * Schema for one declared interpreter installation.
 *
 * @category schemas
 * @since 0.1.0
 */
export const RuntimeSetup = Schema.Union([NodeSetup, BunSetup])

/**
 * One declared interpreter installation.
 *
 * @category models
 * @since 0.1.0
 */
export type RuntimeSetup = typeof RuntimeSetup.Type

/**
 * Declares that a job installs Node.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * export const node = Smithers.CiToolchain.Node({ versionFile: ".node-version" })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const Node = (options: {
  /**
   * The workspace's own runtime declaration, when the caller has one to hand.
   * A PACKAGE.ts omits it: `release` or `versionFile` is what the runner
   * installs, and the workspace declares the interpreter it develops against
   * once.
   */
  readonly runtime?: Runtime.NodeRuntime | undefined
  /** The exact release to install. Mutually exclusive with `versionFile`. */
  readonly release?: NodeRelease | undefined
  /**
   * A checked-in file naming the release to install, read by the setup action
   * at run time. Mutually exclusive with `release`, and the better of the two
   * when anything outside the workflow needs the same number.
   */
  readonly versionFile?: NodeVersionFile | undefined
  /** Install and verify this npm release instead of the one bundled with Node. */
  readonly npmRelease?: NpmRelease | undefined
  /** @default true */
  readonly cachePackageStore?: boolean | undefined
}): NodeSetup => {
  // Exactly one source, so the generated job can never carry a literal that
  // disagrees with the file beside it, and never leaves the release to chance.
  if ((options.release === undefined) === (options.versionFile === undefined)) {
    throw new Error("CiToolchain.Node: declare exactly one of release or versionFile")
  }
  // A workflow reads the file from the checkout root, so an absolute path or one
  // that climbs out of the workspace names something the runner does not have.
  if (
    options.versionFile !== undefined
    && (!/^[\w.][\w./-]*$/.test(options.versionFile) || options.versionFile.split("/").includes(".."))
  ) {
    throw new Error(`CiToolchain.Node: versionFile must be workspace-relative: ${JSON.stringify(options.versionFile)}`)
  }
  return NodeSetup.make({
    name: "node",
    ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
    ...(options.release === undefined ? {} : { release: options.release }),
    ...(options.versionFile === undefined ? {} : { versionFile: options.versionFile }),
    ...(options.npmRelease === undefined ? {} : { npmRelease: options.npmRelease }),
    cachePackageStore: options.cachePackageStore ?? true
  })
}

/**
 * Declares that a job installs Bun.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Bun = (options: {
  /** See {@link Node}; a PACKAGE.ts omits it. */
  readonly runtime?: Runtime.BunRuntime | undefined
  readonly release: BunRelease
}): BunSetup =>
  BunSetup.make({
    name: "bun",
    ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
    release: options.release
  })

/**
 * Schema for the jj-cli releases a runner may install.
 *
 * @category schemas
 * @since 0.1.0
 */
export const JjRelease = Schema.Literals(["0.39.0"])

/**
 * The jj-cli releases a runner may install.
 *
 * @category models
 * @since 0.1.0
 */
export type JjRelease = typeof JjRelease.Type

/**
 * The ripgrep releases a runner may install.
 *
 * @category schemas
 * @since 0.1.0
 */
export const RipgrepRelease = Schema.Literals(["14.1.1"])

/**
 * The ripgrep releases a runner may install.
 *
 * @category models
 * @since 0.1.0
 */
export type RipgrepRelease = typeof RipgrepRelease.Type

/**
 * Schema for a declared ripgrep installation.
 *
 * `@smthrs/std` ships two search implementations and its conformance suite runs
 * both against each other: the portable one it implements, and the native one
 * that drives a real `rg`. The parity is the gate, so a runner without the
 * binary does not weaken the suite, it removes the only check that proves the
 * portable implementation still matches ripgrep.
 *
 * @category schemas
 * @since 0.1.0
 */
export const RipgrepSetup = Schema.Struct({ release: RipgrepRelease })

/**
 * Schema for the system packages a Linux runner installs with `apt-get`.
 *
 * The sandbox mechanism on Linux is bubblewrap, and a hosted runner image does
 * not ship it. A job whose targets run confined declares the package here; the
 * generated step is a no-op on a runner without `apt-get`, so one job
 * declaration serves a platform matrix.
 *
 * @category schemas
 * @since 0.1.0
 */
export const AptSetup = Schema.Struct({
  packages: Schema.NonEmptyArray(Schema.NonEmptyString.check(Schema.isPattern(/^[a-z0-9][a-z0-9+.-]*$/)))
})

/**
 * One declared `apt-get` installation.
 *
 * @category models
 * @since 0.1.0
 */
export type AptSetup = typeof AptSetup.Type

/**
 * One declared ripgrep installation.
 *
 * @category models
 * @since 0.1.0
 */
export type RipgrepSetup = typeof RipgrepSetup.Type

/**
 * The Go toolchains a runner may install.
 *
 * @category schemas
 * @since 0.1.0
 */
export const GoRelease = Schema.Literals(["1.26.0", "1.26.8"])

/**
 * The Go toolchains a runner may install.
 *
 * @category models
 * @since 0.1.0
 */
export type GoRelease = typeof GoRelease.Type

/**
 * Schema for a declared Go installation.
 *
 * `@smthrs/build-cli` supports Go packages as a first-class package type and
 * proves it by building and testing a real Go tree. Without the toolchain the
 * suite does not weaken, it fails, and the only check that the Go package type
 * still works is the one that stops running.
 *
 * @category schemas
 * @since 0.1.0
 */
export const GoSetup = Schema.Struct({ release: GoRelease })

/**
 * One declared Go installation.
 *
 * @category models
 * @since 0.1.0
 */
export type GoSetup = typeof GoSetup.Type

/**
 * The Foundry releases a runner may install.
 *
 * @category schemas
 * @since 0.1.0
 */
export const FoundryRelease = Schema.Literals(["v1.8.1"])

/**
 * The Foundry releases a runner may install.
 *
 * @category models
 * @since 0.1.0
 */
export type FoundryRelease = typeof FoundryRelease.Type

/**
 * Schema for a declared Foundry installation.
 *
 * The build tool's Foundry support is proved against a real `forge`: the suite
 * builds and tests a Foundry package, caches both results, and asserts that
 * `forge fmt --check` reports drift. Every one of those assertions is about
 * what the binary does, so a runner without it removes the check rather than
 * relaxing it.
 *
 * The value is a Foundry RELEASE TAG, not the version `forge --version`
 * prints. Those are different numbering schemes: release `v1.8.1` ships a
 * binary that calls itself `forge 1.31.2`. Pinning the binary's number makes
 * `foundryup --install` fail on a version that was never a release.
 *
 * @category schemas
 * @since 0.1.0
 */
export const FoundrySetup = Schema.Struct({ release: FoundryRelease })

/**
 * One declared Foundry installation.
 *
 * @category models
 * @since 0.1.0
 */
export type FoundrySetup = typeof FoundrySetup.Type

/**
 * The PostgreSQL major releases a runner may install.
 *
 * @category schemas
 * @since 1.0.0
 */
export const PostgresRelease = Schema.Literals(["18"])

/**
 * The PostgreSQL major releases a runner may install.
 *
 * @category models
 * @since 1.0.0
 */
export type PostgresRelease = typeof PostgresRelease.Type

/**
 * The oldest PostgreSQL major a runner image may supply in place of an install.
 *
 * Memory full-text search collates with `pg_c_utf8`, which PostgreSQL 17
 * introduced. The Windows image ships a disabled PostgreSQL 17 server, and
 * the generated step uses its binaries rather than run an installer.
 *
 * @category constants
 * @since 1.0.0
 */
export const postgresFloor = 17

/**
 * Schema for a declared PostgreSQL installation.
 *
 * The storage conformance matrix runs every SQL-backed suite once on SQLite
 * and once on a throwaway PostgreSQL cluster it starts with `initdb` and
 * `pg_ctl`, and it refuses rather than skips when they are missing. The
 * generated step puts those binaries on `PATH`: PGDG `postgresql-<release>` on
 * Linux, Homebrew `postgresql@<release>` on macOS, and the image's own server
 * on Windows when it is at least {@link postgresFloor}.
 *
 * @category schemas
 * @since 1.0.0
 */
export const PostgresSetup = Schema.Struct({ release: PostgresRelease })

/**
 * One declared PostgreSQL installation.
 *
 * @category models
 * @since 1.0.0
 */
export type PostgresSetup = typeof PostgresSetup.Type

/**
 * Schema for the docker daemon configuration a job needs.
 *
 * Hosted runners ship a docker daemon whose default `docker` build driver
 * cannot export an OCI archive (`--output type=oci`), which is what
 * `Docker.Build` and `Docker.Bake` produce: buildx answers "OCI exporter is
 * not supported for the docker driver. Switch to a different driver, or turn
 * on the containerd image store". The image store is the daemon-side fix and
 * the only one that leaves every other docker invocation unchanged, so a job
 * that runs those rules declares it here and the generated step turns it on.
 *
 * @category schemas
 * @since 0.1.0
 */
export const DockerSetup = Schema.Struct({ imageStore: Schema.Literal("containerd") })

/**
 * One declared docker daemon configuration.
 *
 * @category models
 * @since 0.1.0
 */
export type DockerSetup = typeof DockerSetup.Type

/**
 * Schema for a declared jj installation.
 *
 * `colocate` asks the generator for the `jj git init --colocate` step: a GitHub
 * checkout is a git repository and not a jj one, so a suite that drives a real
 * jj binary finds no repository without it.
 *
 * @category schemas
 * @since 0.1.0
 */
export const JjSetup = Schema.Struct({
  release: JjRelease,
  colocate: Schema.Boolean
})

/**
 * One declared jj installation.
 *
 * @category models
 * @since 0.1.0
 */
export type JjSetup = typeof JjSetup.Type

/**
 * Declares that a job installs ripgrep.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Ripgrep = (options: { readonly release: RipgrepRelease }): RipgrepSetup =>
  RipgrepSetup.make({ release: options.release })

/**
 * Declares that a Linux job installs system packages with `apt-get`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Apt = (options: { readonly packages: ReadonlyArray<string> }): AptSetup =>
  AptSetup.make({ packages: [...options.packages] as [string, ...Array<string>] })

/**
 * Declares that a job installs a Go toolchain.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Go = (options: { readonly release: GoRelease }): GoSetup => GoSetup.make({ release: options.release })

/**
 * Declares that a job installs Foundry.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Foundry = (options: { readonly release: FoundryRelease }): FoundrySetup =>
  FoundrySetup.make({ release: options.release })

/**
 * Declares that a job puts the PostgreSQL server binaries on `PATH`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const Postgres = (options: { readonly release: PostgresRelease }): PostgresSetup =>
  PostgresSetup.make({ release: options.release })

/**
 * Declares that a job's docker daemon uses the containerd image store, so
 * buildx can export OCI archives.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Docker = (options: { readonly imageStore: "containerd" }): DockerSetup =>
  DockerSetup.make({ imageStore: options.imageStore })

/**
 * Declares that a job installs the jj CLI.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Jj = (options: {
  readonly release: JjRelease
  /** @default true */
  readonly colocate?: boolean | undefined
}): JjSetup => JjSetup.make({ release: options.release, colocate: options.colocate ?? true })

/**
 * Schema for a declared Rust installation.
 *
 * `cache` restores the registry and the compiled dependency tree, keyed on
 * `Cargo.lock`. A job whose entire point is an uncached rebuild declares
 * `cache: false`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const RustSetup = Schema.Struct({
  toolchain: RustToolchain.RustToolchain,
  cache: Schema.Boolean
})

/**
 * One declared Rust installation.
 *
 * @category models
 * @since 0.1.0
 */
export type RustSetup = typeof RustSetup.Type

/**
 * Declares that a job installs the pinned Rust toolchain.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Rust = (options: {
  /**
   * The toolchain the job installs. Omitted, it is the checked-in `rustup`
   * pin, which is the same file the workspace `S.Rust.Toolchain` declaration
   * names, so a PACKAGE.ts never restates it.
   *
   * @default Smithers.Rust.Pinned({})
   */
  readonly toolchain?: RustToolchain.RustToolchain | undefined
  /** @default true */
  readonly cache?: boolean | undefined
}): RustSetup =>
  RustSetup.make({
    toolchain: options.toolchain ?? RustToolchain.Pinned({}),
    cache: options.cache ?? true
  })

/**
 * Schema for the installers a generated job may install Nix with.
 *
 * @category schemas
 * @since 0.1.0
 */
export const NixInstaller = Schema.Literals(["determinate", "cachix"])

/**
 * The installers a generated job may install Nix with.
 *
 * @category models
 * @since 0.1.0
 */
export type NixInstaller = typeof NixInstaller.Type

/**
 * Schema for a declared Nix installation.
 *
 * `environment` is the workspace's `S.Nix.Environment`; every step of the job
 * runs inside `nix develop` of it, so the runner's own interpreters are never
 * used. `substituter` and `publicKey` are {@link Secret} declarations naming
 * the repository secrets that hold a binary cache URL and its signing public
 * key; the values reach the generated workflow only as `secrets.<NAME>`
 * expressions, never as literals.
 *
 * @category schemas
 * @since 0.1.0
 */
export const NixSetup = Schema.Struct({
  environment: NixDeclaration.EnvironmentDeclaration,
  installer: NixInstaller,
  substituter: Schema.optional(Secret.Declaration),
  publicKey: Schema.optional(Secret.Declaration)
})

/**
 * One declared Nix installation.
 *
 * @category models
 * @since 0.1.0
 */
export type NixSetup = typeof NixSetup.Type

/**
 * Declares that a job installs Nix and runs every step inside the declared
 * environment.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * const environment = Smithers.Nix.Environment({ flake: Smithers.file("//flake.nix") })
 *
 * export const needs = Smithers.CiToolchain.Needs({
 *   nix: Smithers.CiToolchain.Nix({
 *     environment,
 *     substituter: Smithers.Secret("NIX_CACHE_URL"),
 *     publicKey: Smithers.Secret("NIX_CACHE_PUBLIC_KEY")
 *   })
 * })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const Nix = (options: {
  readonly environment: NixDeclaration.Environment
  /** @default "determinate" */
  readonly installer?: NixInstaller | undefined
  readonly substituter?: Secret.Secret | undefined
  readonly publicKey?: Secret.Secret | undefined
}): NixSetup => {
  if (typeof options !== "object" || options === null) throw new TypeError("CiToolchain.Nix options must be an object")
  if (!NixDeclaration.isEnvironment(options.environment)) {
    throw new TypeError("CiToolchain.Nix environment must be an S.Nix.Environment declaration")
  }
  if (options.substituter !== undefined && !Secret.isSecret(options.substituter)) {
    throw new TypeError("CiToolchain.Nix substituter must be an S.Secret declaration")
  }
  if (options.publicKey !== undefined && !Secret.isSecret(options.publicKey)) {
    throw new TypeError("CiToolchain.Nix publicKey must be an S.Secret declaration")
  }
  if ((options.substituter === undefined) !== (options.publicKey === undefined)) {
    throw new Error("CiToolchain.Nix substituter and publicKey are declared together")
  }
  return NixSetup.make({
    environment: options.environment,
    installer: options.installer ?? "determinate",
    ...(options.substituter === undefined ? {} : { substituter: options.substituter }),
    ...(options.publicKey === undefined ? {} : { publicKey: options.publicKey })
  })
}

/**
 * A workspace-relative path a generated step may name.
 *
 * A leading `/` is allowed, for the absolute paths a runner image fixes. `*` is
 * allowed because an artifact source is a set of files. Nothing else that a
 * shell would treat as syntax is: no quote, no `$`, no backtick, no `;`, `&`,
 * `|`, `(`, `)`, `<`, `>`, and no whitespace, so a declared path is always one
 * word and always the word that was declared.
 *
 * @category constants
 * @since 0.1.0
 */
export const pathShape = /^[A-Za-z0-9_./*-][A-Za-z0-9_./*-]*$/

/**
 * Validates one declared path, or throws naming what rejected it.
 *
 * @category validation
 * @since 0.1.0
 */
export const validatePath = (value: string, what: string): string => {
  if (!pathShape.test(value) || value.includes("..")) {
    throw new Error(`CiToolchain: ${JSON.stringify(value)} is not a usable ${what}`)
  }
  return value
}

/**
 * A path a generated step spawns rather than matches.
 *
 * {@link pathShape} admits `*` and a leading `-` because it also validates
 * artifact globs, and neither belongs in something the shell is asked to
 * execute: `*` expands against the runner's working directory, so the step
 * would test and then run whichever entry sorts first, and a leading `-` turns
 * the value into an option to `[`. Two capabilities, two shapes.
 *
 * @category constants
 * @since 0.1.0
 */
export const executableShape = /^[A-Za-z0-9_./][A-Za-z0-9_./-]*$/

/**
 * Validates one declared executable path, or throws naming what rejected it.
 *
 * @category validation
 * @since 0.1.0
 */
export const validateExecutable = (value: string, what: string): string => {
  if (!executableShape.test(value) || value.includes("..")) {
    throw new Error(`CiToolchain: ${JSON.stringify(value)} is not a usable ${what}`)
  }
  return value
}

/**
 * Schema for a declared system browser requirement.
 *
 * The runner image is expected to ship it; the generated step asserts the path
 * exists and prints its version, so an image change fails with a readable
 * message instead of inside a connect timeout.
 *
 * @category schemas
 * @since 0.1.0
 */
export const SystemBrowser = Schema.Struct({
  executable: Schema.NonEmptyString,
  reason: Schema.NonEmptyString
})

/**
 * One declared system browser requirement.
 *
 * @category models
 * @since 0.1.0
 */
export type SystemBrowser = typeof SystemBrowser.Type

/**
 * Declares that a job requires a browser the runner image already ships.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Browser = (options: {
  readonly executable: string
  readonly reason: string
}): SystemBrowser =>
  SystemBrowser.make({
    executable: validateExecutable(options.executable, "browser executable"),
    reason: options.reason
  })

/**
 * Schema for one source an artifact upload collects.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ArtifactSource = Schema.Struct({
  from: Schema.NonEmptyString,
  as: Schema.optional(Schema.NonEmptyString),
  /** Fail collection if this path is missing or this glob has no existing matches. */
  required: Schema.optional(Schema.Boolean)
})

/**
 * One source an artifact upload collects.
 *
 * @category models
 * @since 0.1.0
 */
export type ArtifactSource = typeof ArtifactSource.Type

/**
 * Schema for a declared artifact upload.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ArtifactUpload = Schema.Struct({
  artifact: Schema.NonEmptyString,
  sources: Schema.Array(ArtifactSource)
})

/**
 * One declared artifact upload.
 *
 * @category models
 * @since 0.1.0
 */
export type ArtifactUpload = typeof ArtifactUpload.Type

/**
 * Declares that a job collects and uploads artifacts after its targets run.
 *
 * Sources are optional by default: missing paths and unmatched globs are skipped.
 * Set `required: true` on a source to fail collection when it is absent. Existing
 * sources must always copy successfully. The upload rejects an empty collection
 * if any source is required; otherwise it ignores one, including with no sources.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Artifacts = (options: {
  readonly artifact: string
  readonly sources: ReadonlyArray<{
    readonly from: string
    readonly as?: string | undefined
    readonly required?: boolean | undefined
  }>
}): ArtifactUpload =>
  ArtifactUpload.make({
    artifact: options.artifact,
    sources: options.sources.map((source) => ({
      from: validatePath(source.from, "artifact source"),
      ...(source.as === undefined ? {} : { as: validatePath(source.as, "artifact destination") }),
      ...(source.required === undefined ? {} : { required: source.required })
    }))
  })

/**
 * Schema for the actionlint releases a runner may run.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ActionlintRelease = Schema.Literals(["1.7.11"])

/**
 * The actionlint releases a runner may run.
 *
 * @category models
 * @since 0.1.0
 */
export type ActionlintRelease = typeof ActionlintRelease.Type

/**
 * Schema for a declared workflow-lint requirement.
 *
 * `workflows` names every file to lint. It is declared rather than globbed
 * because a workflow that nobody named is a workflow whose expression errors
 * surface on a schedule instead of in review.
 *
 * @category schemas
 * @since 0.1.0
 */
export const WorkflowLint = Schema.Struct({
  release: ActionlintRelease,
  workflows: Schema.Array(Schema.NonEmptyString)
})

/**
 * One declared workflow-lint requirement.
 *
 * @category models
 * @since 0.1.0
 */
export type WorkflowLint = typeof WorkflowLint.Type

/**
 * Declares that a job lints the repository's workflow files.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Actionlint = (options: {
  readonly release: ActionlintRelease
  readonly workflows: ReadonlyArray<string>
}): WorkflowLint =>
  WorkflowLint.make({
    release: options.release,
    workflows: options.workflows.map((workflow) => validatePath(workflow, "workflow path"))
  })

/**
 * Schema for a repository Cargo binary required by a CI job.
 * The reviewed compiler pin and platform list make installation reproducible.
 * @category schemas
 * @since 1.0.0
 */
export const CargoBinary = Schema.Struct({
  package: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)),
  binary: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)),
  toolchain: Schema.Literal("1.98.0"),
  environment: Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9_]*$/)),
  platforms: Attr.HostPlatforms
})

/**
 * A repository Cargo binary built for the runner and installed outside the checkout.
 * Its absolute path is exported under the declared environment name.
 * @category models
 * @since 1.0.0
 */
export type CargoBinary = typeof CargoBinary.Type

/**
 * Schema for a generated job's checkout, runtimes, tools and artifacts.
 * @category schemas
 * @since 1.0.0
 */
export const Toolchain = Schema.Struct({
  /** Check the tree out with its git submodules. */
  submodules: Schema.Boolean,
  /**
   * `fetch-depth` for the checkout, when this job needs more than the single
   * commit `actions/checkout` fetches by default. `0` is the whole history
   * with every remote-tracking ref, which is what a target that diffs against
   * a base revision needs: on a pull request the default checkout has no
   * `refs/remotes/origin/main` at all, and a target expanding
   * `Smithers.gitDiff("origin/main")` dies at plan time with
   * `bad revision`. Omitted leaves the action's own default.
   */
  fetchDepth: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  /** Set the package manager up and run the frozen workspace install. */
  install: Schema.Boolean,
  /** The interpreters this job installs. */
  runtimes: Schema.Array(RuntimeSetup),
  rust: Schema.optional(RustSetup),
  cargoBinaries: Schema.optional(Schema.Array(CargoBinary)),
  jj: Schema.optional(JjSetup),
  ripgrep: Schema.optional(RipgrepSetup),
  apt: Schema.optional(AptSetup),
  go: Schema.optional(GoSetup),
  foundry: Schema.optional(FoundrySetup),
  /** Put the PostgreSQL server binaries on `PATH`. */
  postgres: Schema.optional(PostgresSetup),
  /** Configure the runner's docker daemon; a no-op where there is none. */
  docker: Schema.optional(DockerSetup),
  /** Install Nix and run every step inside the declared environment. */
  nix: Schema.optional(NixSetup),
  browser: Schema.optional(SystemBrowser),
  workflowLint: Schema.optional(WorkflowLint),
  artifacts: Schema.optional(ArtifactUpload)
})

/**
 * Everything one generated job requires before its targets run.
 *
 * @category models
 * @since 0.1.0
 */
export type Toolchain = typeof Toolchain.Type

/**
 * Declares what one generated job requires.
 *
 * The defaults are what a job that runs workspace targets needs: the workspace
 * installed, no submodules, and no toolchain beyond the interpreters it names.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * const runtime = Smithers.Runtime.Node({ version: ">=26.4.0" })
 *
 * export const needs = Smithers.CiToolchain.Needs({
 *   runtimes: [Smithers.CiToolchain.Node({ runtime, release: "26.4.0" })]
 * })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const Needs = (options: {
  /** @default false */
  readonly submodules?: boolean | undefined
  /** Checkout depth; `0` fetches the whole history and every remote-tracking ref. */
  readonly fetchDepth?: number | undefined
  /** @default true */
  readonly install?: boolean | undefined
  /** @default [] */
  readonly runtimes?: ReadonlyArray<RuntimeSetup> | undefined
  readonly rust?: RustSetup | undefined
  /** Repository binaries required by tests; compiled and installed before targets run. */
  readonly cargoBinaries?: ReadonlyArray<CargoBinary> | undefined
  readonly jj?: JjSetup | undefined
  readonly ripgrep?: RipgrepSetup | undefined
  /** System packages a Linux runner installs before its targets run; a no-op elsewhere. */
  readonly apt?: AptSetup | undefined
  readonly go?: GoSetup | undefined
  readonly foundry?: FoundrySetup | undefined
  readonly postgres?: PostgresSetup | undefined
  readonly docker?: DockerSetup | undefined
  readonly nix?: NixSetup | undefined
  readonly browser?: SystemBrowser | undefined
  readonly workflowLint?: WorkflowLint | undefined
  readonly artifacts?: ArtifactUpload | undefined
} = {}): Toolchain => {
  if (options.nix !== undefined) {
    // The environment supplies every interpreter and language toolchain, so a
    // job that also installs one on the runner would run two copies and the
    // generated PATH would decide which. Refuse the mix rather than pick.
    const mixed = (["runtimes", "rust", "cargoBinaries", "jj", "ripgrep", "go", "foundry", "postgres"] as const).filter(
      (name) => {
        const value = options[name]
        return Array.isArray(value) ? value.length > 0 : value !== undefined
      }
    )
    if (mixed.length > 0) {
      throw new Error(
        `CiToolchain.Needs: a Nix environment supplies the toolchain; remove ${mixed.join(", ")} from the job`
      )
    }
  }
  if (
    options.fetchDepth !== undefined &&
    (!Number.isInteger(options.fetchDepth) || options.fetchDepth < 0)
  ) {
    throw new Error(
      `CiToolchain.Needs: fetchDepth must be a whole number of commits, or 0 for the whole history, received ${options.fetchDepth}`
    )
  }
  return Toolchain.make({
    submodules: options.submodules ?? false,
    ...(options.fetchDepth === undefined ? {} : { fetchDepth: options.fetchDepth }),
    install: options.install ?? true,
    runtimes: options.runtimes ?? [],
    ...(options.rust === undefined ? {} : { rust: options.rust }),
    ...(options.cargoBinaries === undefined ? {} : { cargoBinaries: options.cargoBinaries }),
    ...(options.jj === undefined ? {} : { jj: options.jj }),
    ...(options.ripgrep === undefined ? {} : { ripgrep: options.ripgrep }),
    ...(options.apt === undefined ? {} : { apt: options.apt }),
    ...(options.go === undefined ? {} : { go: options.go }),
    ...(options.foundry === undefined ? {} : { foundry: options.foundry }),
    ...(options.postgres === undefined ? {} : { postgres: options.postgres }),
    ...(options.docker === undefined ? {} : { docker: options.docker }),
    ...(options.nix === undefined ? {} : { nix: options.nix }),
    ...(options.browser === undefined ? {} : { browser: options.browser }),
    ...(options.workflowLint === undefined ? {} : { workflowLint: options.workflowLint }),
    ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts })
  })
}
