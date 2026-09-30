/**
 * Installs the process-wide module resolvers required by declaration evaluation.
 *
 * Targets, the planner, and the flow engine exchange values branded by Effect's
 * runtime symbols. A linked workspace can otherwise load another physical
 * `effect` installation—even at the same version—and hand the engine schemas
 * it cannot interpret. Declaration modules therefore resolve every `effect` bare
 * import from the CLI package that owns the runtime.
 *
 * The CLI also owns the declaration surface. Resolving
 * `@smthrs/targets` from here lets a globally installed `smithers-build` bootstrap a
 * repository before dependencies are installed; requiring it to install the
 * package would make generated package.json files circular to create.
 *
 * ## Hook order
 *
 * Two resolve hooks are registered, because the two jobs want opposite
 * positions in the chain. Node runs resolve hooks newest first, and tsx
 * registers a fresh namespace loader for every declaration module this CLI
 * evaluates.
 *
 * {@link parentHooks} pins a CLI-owned specifier, and has to run BEFORE tsx's
 * loader: tsx reads the namespace to apply from the `parentURL` it was handed
 * and stamps it onto whatever the rest of the chain returns, so a rewrite
 * performed underneath tsx changes the package the module is read from but not
 * the namespace it lands in. It is therefore re-registered after every tsx
 * registration; {@link importDeclarationModule} is what keeps that true.
 *
 * {@link formatHooks} pins a declaration module's format and identity, and has
 * to run AFTER tsx's loader, because both rules read what tsx resolved. It
 * stays where it was first registered and is never moved.
 *
 * ## Declaration module format
 *
 * The format hook below reports `format: "module"` for every declaration, so a
 * workspace whose nearest `package.json` declares no `type` still evaluates
 * its declaration as an ES module — but that override reaches tsx only when
 * these hooks were registered before tsx's loader was created. An evaluation
 * path that misses that window (a bootstrap that touches tsx first, or a
 * nested require from an already-CommonJS module) falls back to tsx's own
 * classification and evaluates it through the CommonJS bridge. Registering
 * tsx's public ESM loader once also covers nested, non-namespaced
 * requires through Node's synchronous hooks. Its global CommonJS loader
 * transpiles even built ESM dependencies during require(), creating a second
 * Effect schema runtime beside native ESM imports. Namespaced CommonJS
 * bridges remain registered for explicit declaration imports. tsx owns
 * TypeScript and file-URL handling; this package does not
 * patch Node's private CommonJS resolver. CommonJS callers must install their
 * dependencies where ordinary Node resolution can find them.
 *
 * @since 0.1.0
 */
import { randomUUID } from "node:crypto"
import { createRequire, isBuiltin, registerHooks } from "node:module"
import * as NodePath from "node:path"
import { fileURLToPath } from "node:url"
import { register as registerCommonJs } from "tsx/cjs/api"
import { register as registerModule } from "tsx/esm/api"

const installation = Symbol.for("smthrs/effect-resolution-installed")
const registration = Symbol.for("smthrs/effect-resolution-registration")
const ownership = Symbol.for("smthrs/effect-resolution-ownership")
const buildModuleParameter = "smithers-build-module"

/**
 * This file's own URL with every query stripped.
 *
 * `import.meta.url` is not it. A declaration module imports the CLI's modules,
 * so tsx evaluates a second copy of this file inside that module's namespace
 * and the copy's `import.meta.url` carries `?tsx-namespace=`. Resolving from
 * that URL asks tsx for `effect` in the very namespace this resolver exists to
 * escape. The bare path names one installation from every copy.
 *
 * This is the request-side half of the single-instance guard;
 * {@link withoutNamespace} is the result-side half. Either one alone holds the
 * bare specifiers, which is why removing just this one changes nothing
 * measurable. It is kept because the other half depends on resolving
 * {@link effectRoot}, and a host layout where that resolution fails would
 * otherwise leave the bare specifiers unguarded.
 */
const cliParentUrl = (() => {
  const url = new URL(import.meta.url)
  url.search = ""
  url.hash = ""
  return url.href
})()

/**
 * The bare specifiers the CLI owns, resolved from this file, not the importer.
 *
 * A package belongs here when two physical copies of it would disagree, not
 * merely when it is shared. `effect` holds schema sentinels compared by
 * identity. `@smthrs/plan` keeps each node's continuation and mapper in a
 * module-level `WeakMap` keyed by the AST object, so a second copy has a second
 * table: the node is registered in one and read from the other, and the graph
 * walk reports the continuation as missing with a message that blames
 * serialization. `@smthrs/core` and `@smthrs/flow` build and read those same
 * nodes, so they resolve from here for the same reason.
 */
const ownerOf = (specifier) => {
  if (specifier === "effect" || specifier.startsWith("effect/")) return cliParentUrl
  for (const [name, owner] of globalThis[ownership] ?? []) {
    if (specifier === name || specifier.startsWith(`${name}/`)) return owner
  }
  return cliOwnedPackages.some((name) => specifier === name || specifier.startsWith(`${name}/`))
    ? cliParentUrl
    : undefined
}

/** Workspace packages whose module-level state is compared by identity. */
const cliOwnedPackages = ["@smthrs/targets", "@smthrs/plan", "@smthrs/core", "@smthrs/flow"]

/** tsx's marker for the CommonJS virtual module it wraps a CJS `.ts` file in. */
const commonjsVirtualParameter = "tsx-commonjs-virtual-query"

/** tsx's marker for the module registry one `tsImport` call evaluates into. */
const namespaceParameter = "tsx-namespace"

/**
 * The directory holding the Effect installation this CLI runs on.
 *
 * A bare `effect` import is pinned by rewriting `parentURL`, but a declaration
 * module may also import one of these files by absolute URL — a declaration that
 * writes `import.meta.resolve("effect/Schema")` into a generated file does.
 * That specifier names the right file already; what it lacks is protection
 * from tsx stamping a namespace onto the result and producing a second
 * instance of it. This root is what lets {@link withoutNamespace} recognize
 * the resolutions that must stay on one instance.
 *
 * This is the only rule covering that absolute-URL import, which the CLI's own
 * fixtures write with `import.meta.resolve("effect/Schema")`: the
 * specifier is not bare, so re-parenting never sees it. Removing this rule puts
 * a second Effect instance back into such a workspace.
 *
 * Only Effect is pinned this way. Effect ships built JavaScript, so a
 * namespace-free URL still loads; `@smthrs/targets` ships TypeScript sources
 * whose namespaced form only tsx's loader compiles, and stripping a namespace
 * it already carries hands Node a file it cannot parse. Two copies of the
 * target definitions interoperate as long as both build their schemas out of
 * one Effect.
 */
const effectRoot = (() => {
  try {
    return NodePath.dirname(createRequire(cliParentUrl).resolve("effect/package.json")) + NodePath.sep
  } catch {
    // A host without the package resolves nothing through it either.
    return undefined
  }
})()

/** Strips tsx's namespace from a resolution that must stay on one instance. */
const withoutNamespace = (url) => {
  if (effectRoot === undefined || !url.startsWith("file:") || !url.includes(namespaceParameter)) return url
  const parsed = new URL(url)
  if (!parsed.searchParams.has(namespaceParameter)) return url
  if (!fileURLToPath(`${parsed.protocol}//${parsed.host}${parsed.pathname}`).startsWith(effectRoot)) return url
  parsed.searchParams.delete(namespaceParameter)
  return parsed.href
}

/**
 * The declaration module a resolved URL names, as a `file:` URL with no query.
 *
 * tsx re-encodes a nested import's own query into the pathname
 * (`…/PACKAGE.ts%3Fnamespace=…`) and appends its search parameters, so neither
 * the href nor the raw pathname ends in the file's extension. Cutting at the
 * encoded query first makes the match hold for a nested declaration module,
 * not only for the one an import started at.
 *
 * Returns `undefined` for everything that is not a declaration module.
 */
const fileModuleBase = (url) => {
  if (!url.startsWith("file:")) return undefined
  const parsed = new URL(url)
  const encoded = parsed.pathname.search(/%3F/i)
  const filePart = encoded === -1 ? parsed.pathname : parsed.pathname.slice(0, encoded)
  return `file://${parsed.host}${filePart}`
}

const buildModuleBase = (url) => {
  const base = fileModuleBase(url)
  if (base === undefined) return undefined
  const parsed = new URL(url)
  if (parsed.searchParams.get(buildModuleParameter) === "1") return base
  const pathname = decodeURIComponent(new URL(base).pathname)
  // File flows and the registry's content-pinned load siblings are authored
  // ES modules too, even when their repository declares type: commonjs.
  // PACKAGE.ts, WORKSPACE.ts, and the .smithers/*.ts siblings WORKSPACE.ts
  // imports are declaration modules.
  // All are authored as ES modules regardless of the host repository's
  // package.json `type`, so their format is pinned here.
  const declaration = /\/\.smithers-[a-f0-9]{64}-[^/]+\.ts$/.test(pathname) ||
    /\/flows\/[^/]+\/flow\.ts$/.test(pathname) ||
    pathname.endsWith("/PACKAGE.ts") ||
    pathname.endsWith("/WORKSPACE.ts") ||
    (pathname.includes("/.smithers/") && pathname.endsWith(".ts"))
  return declaration ? base : undefined
}

/**
 * The resolution a declaration module gets: the ES-module format, always.
 *
 * On Node 22.19.0, which this repository once pinned, tsx answers a declaration
 * module whose nearest package.json declares no `type` with a CommonJS virtual
 * module. That module is a second instance of a file the ES-module graph may
 * already hold, so a workspace mixing `type` declarations across its packages
 * loaded one PACKAGE.ts twice and reported the shared targets it exports as
 * unowned. Rewriting the URL back to the plain file drops tsx's virtual wrapper
 * and leaves one instance per file, which is what a newer Node already does.
 */
const asBuildModule = (resolved, base) => {
  const parsed = new URL(resolved.url)
  if (!parsed.searchParams.has(commonjsVirtualParameter)) return { ...resolved, format: "module" }
  const rewritten = new URL(base)
  for (const [name, value] of parsed.searchParams) {
    if (name !== commonjsVirtualParameter) rewritten.searchParams.set(name, value)
  }
  return { ...resolved, url: rewritten.href, format: "module" }
}

/**
 * Pins every CLI-owned specifier to this installation. Runs before tsx's
 * loader; see the hook-order note above.
 */
const parentHooks = {
  resolve(specifier, context, nextResolve) {
    // CommonJS consumers must install their ordinary dependencies. Node 26
    // also sends require() through these synchronous hooks.
    const owner = ownerOf(specifier)
    const resolved = !context.conditions.includes("require") && owner !== undefined
      ? nextResolve(specifier, { ...context, parentURL: owner })
      : nextResolve(specifier, context)
    const url = withoutNamespace(resolved.url)
    return url === resolved.url ? resolved : { ...resolved, url }
  }
}

/**
 * Pins a declaration module's format and identity. Runs after tsx's loader;
 * see the hook-order note above.
 */
// Format admission only; no alternate declaration or execution graph.
const declarationHelpers = new Set()
const formatHooks = {
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context)
    // Native require resolution can omit the format. Mark builtins before
    // tsx's namespace hook, which otherwise stamps a query onto node: URLs
    // and sends them through its file loader.
    if (isBuiltin(resolved.url)) return { ...resolved, format: "builtin" }
    let base = buildModuleBase(resolved.url)
    // Relative typed helpers are part of the admitted declaration's ESM
    // evaluation. A CommonJS package default must not move their imports into
    // the ordinary require graph, which has no bootstrap package ownership.
    const parent = context.parentURL === undefined ? undefined : fileModuleBase(context.parentURL)
    const helper = fileModuleBase(resolved.url)
    if (
      base === undefined && parent !== undefined && helper !== undefined &&
      (buildModuleBase(context.parentURL) !== undefined || declarationHelpers.has(parent)) &&
      // tsx resolves directory indexes to file: URLs before this hook.
      (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("file:")) &&
      /\.(?:ts|tsx|mts)$/.test(new URL(helper).pathname) && !new URL(helper).pathname.includes("/node_modules/")
    ) {
      declarationHelpers.add(helper)
      base = helper
    }
    return base === undefined ? resolved : asBuildModule(resolved, base)
  }
}

/**
 * Re-registers {@link parentHooks} so it runs before every hook registered so
 * far.
 *
 * Each tsx namespace loader wraps this resolver and derives its namespace from
 * the importer it was handed, so `effect` imported from a declaration lands in
 * that declaration's namespace and `effect` imported from the CLI lands in the
 * CLI's — two physical module instances whose schema internals do not
 * interoperate. Moving this resolver back to the front after each tsx
 * registration restores the single instance: tsx then reads the rewritten
 * `parentURL`, which names one installation and carries no namespace, and
 * leaves the resolution alone.
 * @slop
 */
const reassert = () => {
  const previous = globalThis[registration]
  if (previous === undefined) return
  previous.deregister()
  globalThis[registration] = registerHooks(parentHooks)
}

/**
 * Evaluates one declaration module through tsx with the parent resolver in
 * front of tsx's namespace loader.
 *
 * `tsImport` registers that loader and imports in one call, which leaves no
 * point at which the resolver can be moved back to the front. The two steps
 * are taken separately here for that reason. The loader stays registered
 * afterwards, as `tsImport` leaves it, so a module the declaration imports
 * lazily still resolves.
 * @slop
 */
export const importDeclarationModule = async (url, parentURL) => {
  installEffectResolution()
  const namespace = randomUUID()
  // Both halves, as `tsImport` registers them. The CommonJS half is what
  // answers a `require` that a declaration module reaches through the
  // CommonJS bridge, and it must know this namespace or the request arrives
  // carrying a namespace nothing resolves.
  registerCommonJs({ namespace })
  const loader = registerModule({ namespace, parentURL, tsconfig: false })
  reassert()
  return await loader.import(url, parentURL)
}

/**
 * Installs the resolvers once per process.
 * @slop
 */
export const installEffectResolution = (packages = {}) => {
  globalThis[ownership] ??= new Map()
  for (const [name, owner] of Object.entries(packages)) {
    const url = new URL(owner)
    url.search = ""
    url.hash = ""
    globalThis[ownership].set(name, url.href)
  }
  if (globalThis[installation] === true) return
  // Oldest first, so the format hook ends up behind tsx and the parent hook in
  // front of it. See the hook-order note above.
  registerHooks(formatHooks)
  globalThis[registration] = registerHooks(parentHooks)
  // The ESM loader supports ordinary typed CommonJS bridges through Node's
  // public hooks without transpiling native Effect modules during require().
  registerModule({ tsconfig: false })
  reassert()
  Object.defineProperty(globalThis, installation, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false
  })
}

/**
 * Marks one admitted declaration URL for ES-module evaluation.
 * @slop
 */
export const buildModuleUrl = (url) => {
  const marked = new URL(url)
  marked.searchParams.set(buildModuleParameter, "1")
  return marked.href
}
