import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Inspect pending bindings without approving them or executing their commands. */
export function bindingErrors(inventory, root) {
  const errors = []
  const isFile = (path) => existsSync(resolve(root, path)) && statSync(resolve(root, path)).isFile()
  const inspect = (value, location) => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      value.forEach((entry, index) => inspect(entry, `${location}[${index}]`))
      return
    }
    for (const path of value.files ?? []) {
      if (!isFile(path)) errors.push(`${location}: missing file ${path}`)
    }
    if (value.argv) {
      const cwd = value.cwd ?? '.'
      if (!existsSync(resolve(root, cwd))) errors.push(`${location}: missing cwd ${cwd}`)
      // File arguments, including runner configs, must resolve from the command's cwd.
      for (const arg of value.argv.slice(1)) {
        if (/\.(?:mjs|cjs|js|jsx|ts|tsx|json|toml|sh|go|rs)$/.test(arg) && !isFile(resolve(cwd, arg))) {
          errors.push(`${location}: missing argv file ${arg}`)
        }
      }
      const source = (value.files ?? []).filter(isFile).map((path) => readFileSync(resolve(root, path), 'utf8')).join('\n')
      if (value.reporter === 'go') {
        const names = [...source.matchAll(/^func (Test\w+)\(t \*testing\.T\)/gm)].map((match) => match[1])
        for (const name of value.expectedCaseIds ?? []) {
          if (!names.includes(name.split('/')[0])) errors.push(`${location}: missing test ${name}`)
        }
        const runIndex = value.argv.indexOf('-run')
        if (runIndex >= 0) {
          try {
            const pattern = new RegExp(value.argv[runIndex + 1])
            if (!names.some((name) => pattern.test(name))) errors.push(`${location}: -run matches no declared test`)
            for (const name of value.expectedCaseIds ?? []) {
              if (!pattern.test(name.split('/')[0])) errors.push(`${location}: -run excludes expected test ${name}`)
            }
          } catch { errors.push(`${location}: invalid -run pattern`) }
        }
      } else {
        const names = [...source.matchAll(/\b(?:test|it)(?:\.(?:skip|only|todo))?\(\s*(['"`])((?:\\.|(?!\1)[^\\])*?)\1/g)].map((match) => match[2].replace(/\\(['"\\])/g, "$1"))
        for (const name of value.expectedCaseIds ?? []) {
          if (!names.includes(name)) errors.push(`${location}: missing test ${name}`)
        }
      }
    }
    for (const [key, child] of Object.entries(value)) inspect(child, `${location}.${key}`)
  }
  for (const [check, entry] of Object.entries(inventory.checks)) {
    for (const absent of (entry.reason ?? '').matchAll(/Absent: ([^;]+)/g)) {
      for (const path of absent[1].matchAll(/(?:packages|apps|crates|scripts)\/[^,\s]+/g)) {
        if (isFile(path[0])) errors.push(`${check}: Absent reason names existing file ${path[0]}`)
      }
    }
    inspect(entry, check)
  }
  return errors
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const errors = bindingErrors(JSON.parse(readFileSync(resolve(root, 'scripts/check-commands.json'), 'utf8')), root)
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1 }
  else console.log('Check bindings: no missing files/tests or stale Absent reasons')
}
