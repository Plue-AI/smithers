/**
 * Syntax-only parsing with TypeScript's native compiler.
 *
 * The compiler sees a closed, two-file virtual project, never the caller's
 * tsconfig, imports, libraries, or filesystem. It does not check types or emit.
 * Each call owns and closes its compiler process; the returned tree is backed
 * by the already transferred source buffer and survives closing the session.
 *
 * @since 1.0.0-rc.0
 * @private
 */

import { resolve } from "node:path"
import type { SourceFile } from "typescript/unstable/ast"
import { API } from "typescript/unstable/sync"

/**
 * Parses one module without granting the compiler a real filesystem view.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const parseModule = (path: string, text: string): SourceFile => {
  const directory = resolve(".__smithers_syntax__").replace(/\\/g, "/")
  const extension = /\.(tsx|jsx|mts|cts|mjs|cjs|js)$/i.exec(path)?.[1]?.toLowerCase() ?? "ts"
  const file = `${directory}/input.${extension}`
  const config = `${directory}/tsconfig.json`
  const files = new Map([
    [file, text],
    [
      config,
      JSON.stringify({
        files: [`input.${extension}`],
        compilerOptions: { noLib: true, noResolve: true, allowJs: true, types: [] }
      })
    ]
  ])
  const api = new API({
    cwd: directory,
    fs: {
      readFile: (name) => files.get(name) ?? null,
      fileExists: (name) => files.has(name),
      directoryExists: (name) => name === directory,
      getAccessibleEntries: () => ({ files: [], directories: [] }),
      realpath: (name) => name
    }
  })
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] })
    const source = snapshot.getProject(config)?.program.getSourceFile(file)
    if (source === undefined) throw new Error(`TypeScript did not return a syntax tree for ${path}`)
    return source
  } finally {
    api.close()
  }
}
