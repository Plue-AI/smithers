/** Semantic checking runs only on the unprivileged flow-load guest. */
import ts from "typescript"
import { dirname, relative, resolve } from "node:path"

interface TypeInputs {
  readonly files: Readonly<Record<string, string>>
  readonly entries: Readonly<Record<string, string>>
  readonly lib: string
  readonly node: string
}
declare const __SMITHERS_FLOW_TYPES__: TypeInputs | undefined

/** One main-built compiler/type graph, embedded and hashed with the host. */
const inputs = (): TypeInputs => {
  if (typeof __SMITHERS_FLOW_TYPES__ === "undefined") {
    throw new Error("The coding host has no packaged flow type inputs")
  }
  return __SMITHERS_FLOW_TYPES__
}

// Install sources never change during this guest host lifetime. Reuse their
// syntax trees across catalog entries and loads; repository trees stay local.
const trustedSources = new Map<string, ts.SourceFile>()

export const checkFlowTypes = (repository: string, entries: ReadonlyArray<string>): ReadonlyMap<string, string> => {
  const trusted = inputs()
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
    allowImportingTsExtensions: true, skipLibCheck: true, noEmit: true,
    types: [], lib: [trusted.lib],
    paths: Object.fromEntries(Object.entries(trusted.entries).map(([key, value]) => [key, [value]]))
  }
  // Never read tsconfig plugins or execute a repository compiler. Filesystem
  // reads of repository dependencies are ordinary guest data reads.
  const host = ts.createCompilerHost(options)
  host.getDefaultLibFileName = () => trusted.lib
  host.getDefaultLibLocation = () => dirname(trusted.lib)
  const fileExists = host.fileExists, readFile = host.readFile, directoryExists = host.directoryExists!
  const prefix = "/__smithers_types__/"
  const directories = new Set<string>()
  for (const name of Object.keys(trusted.files)) {
    for (let parent = resolve(name, ".."); !directories.has(parent); parent = resolve(parent, "..")) {
      directories.add(parent)
      if (parent === resolve(parent, "..")) break
    }
  }
  host.fileExists = name => name.startsWith(prefix) ? trusted.files[name] !== undefined : fileExists(name)
  host.readFile = name => name.startsWith(prefix) ? trusted.files[name] : readFile(name)
  host.directoryExists = name => name.startsWith(prefix) ? directories.has(name) : directoryExists(name)
  host.realpath = name => name.startsWith(prefix) ? name : ts.sys.realpath?.(name) ?? name
  const sources = new Map<string, ts.SourceFile>()
  host.getSourceFile = (name, languageVersion) => {
    const cache = name.startsWith(prefix) ? trustedSources : sources
    const cached = cache.get(name)
    if (cached !== undefined) return cached
    const text = host.readFile(name)
    if (text === undefined) return undefined
    const source = ts.createSourceFile(name, text, languageVersion)
    cache.set(name, source)
    return source
  }
  const failures = new Map<string, string>()
  for (const entry of entries) {
    const program = ts.createProgram([entry, trusted.node], options, host)
    const repositorySources = program.getSourceFiles().filter(source => !source.fileName.startsWith(prefix))
    const diagnostics = [
      ...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics(),
      ...repositorySources.flatMap(source => [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)])
    ].filter(diagnostic =>
      diagnostic.category === ts.DiagnosticCategory.Error &&
      (diagnostic.file === undefined || !diagnostic.file.fileName.startsWith(prefix) || [2307, 2688, 6053].includes(diagnostic.code))
    )
    const diagnostic = diagnostics[0]
    if (diagnostic === undefined) continue
    const file = diagnostic.file
    const location = file === undefined ? relative(repository, entry) : relative(repository, file.fileName)
    const line = file === undefined || diagnostic.start === undefined ? "" : `:${file.getLineAndCharacterOfPosition(diagnostic.start).line + 1}`
    failures.set(entry, `${location}${line}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`.slice(0, 2000))
  }
  return failures
}
