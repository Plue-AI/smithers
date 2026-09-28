import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { copyInputDeclarations } from "../../../../repo-targets/scripts/build-library.mjs"
import { compileCommonJs } from "../../../scripts/compile-commonjs.mjs"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const sourceRoot = resolve(packageRoot, "src")
const esmRoot = resolve(packageRoot, "dist/esm")
const tsc = resolve(packageRoot, "node_modules/typescript/bin/tsc")

const files = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? files(path) : [path]
  })

rmSync(resolve(packageRoot, "dist"), { recursive: true, force: true })
const declarationResult = spawnSync(process.execPath, [tsc, "-p", "tsconfig.json"], {
  cwd: packageRoot,
  stdio: "inherit"
})
if (declarationResult.status !== 0) process.exit(declarationResult.status ?? 1)

copyInputDeclarations(sourceRoot, esmRoot)

for (
  const source of files(sourceRoot).filter((file) =>
    file.endsWith(".js") && !existsSync(file.replace(/\.js$/, ".ts"))
  )
) {
  const target = resolve(esmRoot, relative(sourceRoot, source))
  mkdirSync(dirname(target), { recursive: true })
  cpSync(source, target)
}

await compileCommonJs(sourceRoot, resolve(packageRoot, "dist/cjs"), esmRoot)
