import childProcess from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import { randomUUID } from "node:crypto"
import { basename } from "node:path"
import { receipt } from "./receipts.mjs"

const prefix = "SMITHERS_BUN_COVERAGE_"
export function preloadArguments(args, preload) {
  const flags = ["--preload", preload]
  return args[0] === "test" || args[0] === "run"
    ? [args[0], ...flags, ...args.slice(1)]
    : [...flags, ...args]
}

// Only direct Bun spawn/spawnSync calls are registered. Shell interpretation,
// exec/fork, browser workers and non-Bun executables are not emulated here.
export function observeChildren(context) {
  const { run, runId, manifest, id, configuration, preload, recordError } = context
  const seen = new Set()
  const saveExit = (childId, code, signal = null, notLaunched = false) => {
    if (seen.has(childId)) return
    seen.add(childId)
    try { receipt(run, "exits", childId, { id: childId, runId, manifest, code, signal, notLaunched }) }
    catch (error) { recordError(error) }
  }
  const prepare = (command, args, options = {}) => {
    if (command !== process.execPath && !/^bun(?:\.exe)?$/.test(basename(String(command)))) return null
    if (options.shell) throw new Error("Bun coverage requires a direct spawn boundary, not shell:true")
    const original = options.env ?? process.env
    // Node's implementation may delegate to Bun.spawn. Preserve the already
    // registered invocation rather than create a second child identity.
    if (original[`${prefix}NEXT_ID`]) return { args, options, id: original[`${prefix}NEXT_ID`], nested: true }
    const childId = randomUUID()
    const mode = args[0] === "test" ? "test" : "run"
    receipt(run, "expected", childId, { id: childId, runId, manifest, parent: id, mode })
    return { id: childId, args: preloadArguments(args, preload), options: { ...options, env: { ...original,
      [`${prefix}CONFIG`]: configuration, [`${prefix}NEXT_ID`]: childId,
      [`${prefix}PARENT`]: id, [`${prefix}MODE`]: mode } } }
  }
  const nodeSpawn = childProcess.spawn, nodeSpawnSync = childProcess.spawnSync
  childProcess.spawn = function(command, args, options) {
    const argv = Array.isArray(args) ? args : []
    const originalOptions = Array.isArray(args) ? options : args
    const child = prepare(command, argv, originalOptions)
    if (!child) return Reflect.apply(nodeSpawn, this, arguments)
    let result
    try { result = Reflect.apply(nodeSpawn, this, [command, child.args, child.options]) }
    catch (error) { saveExit(child.id, null, null, true); throw error }
    if (!child.nested) result.once("exit", (code, signal) => saveExit(child.id, code, signal))
    return result
  }
  childProcess.spawnSync = function(command, args, options) {
    const argv = Array.isArray(args) ? args : []
    const originalOptions = Array.isArray(args) ? options : args
    const child = prepare(command, argv, originalOptions)
    if (!child) return Reflect.apply(nodeSpawnSync, this, arguments)
    let result
    try { result = Reflect.apply(nodeSpawnSync, this, [command, child.args, child.options]) }
    catch (error) { saveExit(child.id, null, null, true); throw error }
    if (!child.nested) saveExit(child.id, result.status, result.signal, result.error !== undefined)
    return result
  }
  syncBuiltinESMExports()
  const bunSpawn = Bun.spawn, bunSpawnSync = Bun.spawnSync
  const bunArguments = (input, options) => Array.isArray(input)
    ? { argv: input, options: options ?? {}, object: false }
    : { argv: input.cmd, options: input, object: true }
  for (const [name, original, sync] of [["spawn", bunSpawn, false], ["spawnSync", bunSpawnSync, true]]) {
    Bun[name] = function(input, options) {
      const parsed = bunArguments(input, options)
      const child = prepare(parsed.argv[0], parsed.argv.slice(1), parsed.options)
      if (!child) return Reflect.apply(original, this, arguments)
      let result
      try {
        result = Reflect.apply(original, this, parsed.object
          ? [{ ...child.options, cmd: [parsed.argv[0], ...child.args] }]
          : [[parsed.argv[0], ...child.args], child.options])
      } catch (error) { saveExit(child.id, null, null, true); throw error }
      if (!child.nested) {
        if (sync) saveExit(child.id, result.exitCode, result.signalCode)
        else result.exited.then((code) => saveExit(child.id, code, result.signalCode), recordError)
      }
      return result
    }
  }
}
