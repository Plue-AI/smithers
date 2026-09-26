import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import {
  cleanLabel,
  cleanPlist,
  commands,
  hostPlist,
  install,
  label,
  type Launchctl,
  type Launchd,
  optionsOf,
  plist,
  type ServiceOptions,
  servicePath,
  uninstall
} from "./service.ts"
import type { Io } from "./settings.ts"

const scratch = mkdtempSync(join(tmpdir(), "org-service-"))
after(() => rmSync(scratch, { recursive: true, force: true }))

const options: ServiceOptions = {
  node: "/opt/node/bin/node",
  checkout: "/src/smithers",
  stateDir: join(scratch, "state & <dir>"),
  workingDirectory: "/Users/me/Ops",
  path: "/opt/node/bin:/opt/jj:/usr/bin:/bin",
  home: "/Users/me"
}

/** Parses a plist with the system's own parser when there is one. */
const parsed = (text: string): any => {
  const file = join(scratch, `parse-${Math.random().toString(36).slice(2)}.plist`)
  writeFileSync(file, text)
  const lint = spawnSync("plutil", ["-lint", file], { encoding: "utf8" })
  assert.equal(lint.status, 0, lint.stdout + lint.stderr)
  return JSON.parse(spawnSync("plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }).stdout)
}
const hasPlutil = process.platform === "darwin" && spawnSync("plutil", ["-help"]).error === undefined

test("plist escapes XML and renders every value type", () => {
  const text = plist({ A: "x<&>\"", B: 3, C: true, D: false, E: ["1", "2"], F: { G: "h" } })
  assert.match(text, /<string>x&lt;&amp;&gt;&quot;<\/string>/)
  assert.match(text, /<integer>3<\/integer>/)
  assert.match(text, /<true\/>/)
  assert.match(text, /<false\/>/)
  assert.match(text, /<array>\n\s+<string>1<\/string>/)
  assert.match(text, /<key>F<\/key>\n\s+<dict>/)
})

test("the host agent runs serve at login, restarts throttled, and logs under the state directory", {
  skip: !hasPlutil && "no plutil"
}, () => {
  const host = parsed(hostPlist(options))
  assert.deepEqual(host.ProgramArguments, [
    options.node,
    "/src/smithers/flows/organization/cli.ts",
    "serve",
    "--state-dir",
    options.stateDir
  ])
  assert.equal(host.Label, label)
  assert.equal(host.RunAtLoad, true)
  assert.equal(host.KeepAlive, true)
  assert.equal(host.ThrottleInterval, 30)
  assert.equal(host.WorkingDirectory, options.workingDirectory)
  assert.deepEqual(host.EnvironmentVariables, {
    PATH: options.path,
    HOME: options.home,
    SMITHERS_ORG_STATE_DIR: options.stateDir
  })
  assert.equal(host.StandardOutPath, join(options.stateDir, "logs", "host.log"))
  assert.equal(host.StandardErrorPath, host.StandardOutPath)
  const clean = parsed(cleanPlist(options))
  assert.equal(clean.Label, cleanLabel)
  assert.deepEqual(clean.ProgramArguments.slice(2), ["clean", "--state-dir", options.stateDir])
  assert.equal(clean.StartInterval, 3600)
  assert.equal(clean.RunAtLoad, false)
  assert.equal(clean.StandardOutPath, join(options.stateDir, "logs", "clean.log"))
})

test("servicePath puts Node, jj and git first and fails naming a missing tool", () => {
  const bin = join(scratch, "bin"), jj = join(scratch, "jjbin")
  mkdirSync(bin, { recursive: true })
  mkdirSync(jj, { recursive: true })
  writeFileSync(join(bin, "git"), "")
  writeFileSync(join(jj, "jj"), "")
  const path = servicePath("/n/bin/node", `${bin}::${jj}`).split(":")
  assert.deepEqual(path.slice(0, 3), ["/n/bin", jj, bin])
  assert.ok(path.includes("/usr/bin"))
  assert.equal(new Set(path).size, path.length)
  assert.throws(() => servicePath("/n/bin/node", bin), /jj is not on PATH/)
})

/** A launchd that records calls and loads what it is told to. */
const fakeLaunchd = (agentsDir: string, bootstrapFails = false) => {
  const calls: Array<string> = []
  const loaded = new Set<string>()
  const launchctl: Launchctl = (args) => {
    calls.push(args.join(" "))
    const [verb, target, file] = args
    if (verb === "print") return { status: loaded.has(target!.split("/").at(-1)!) ? 0 : 113, stdout: "", stderr: "" }
    if (verb === "bootout") {
      loaded.delete(target!.split("/").at(-1)!)
      return { status: 0, stdout: "", stderr: "" }
    }
    if (verb === "bootstrap") {
      if (bootstrapFails) return { status: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" }
      loaded.add(file!.split("/").at(-1)!.replace(/\.plist$/, ""))
      return { status: 0, stdout: "", stderr: "" }
    }
    return { status: 1, stdout: "", stderr: "unexpected" }
  }
  const system: Launchd = { agentsDir, domain: "gui/501", launchctl }
  return { system, calls, loaded }
}

test("install is idempotent, reloads a changed agent, and uninstall removes both", () => {
  const agents = join(scratch, "agents")
  const { system, calls, loaded } = fakeLaunchd(agents)
  assert.deepEqual(install(options, system), [[label, "installed"], [cleanLabel, "installed"]])
  assert.ok(existsSync(join(agents, `${label}.plist`)))
  assert.ok(existsSync(join(options.stateDir, "logs")))
  assert.deepEqual([...loaded].sort(), [label, cleanLabel].sort())
  calls.length = 0
  assert.deepEqual(install(options, system), [[label, "unchanged"], [cleanLabel, "unchanged"]])
  assert.ok(calls.every((call) => call.startsWith("print")), calls.join("\n"))
  assert.deepEqual(install({ ...options, path: "/other" }, system), [[label, "reloaded"], [cleanLabel, "reloaded"]])
  assert.match(readFileSync(join(agents, `${label}.plist`), "utf8"), /<string>\/other<\/string>/)
  // A file present but not loaded (after a logout, say) is loaded again.
  loaded.clear()
  assert.deepEqual(install({ ...options, path: "/other" }, system), [[label, "installed"], [cleanLabel, "installed"]])
  assert.deepEqual(uninstall(system), [[label, "removed"], [cleanLabel, "removed"]])
  assert.equal(loaded.size, 0)
  assert.ok(!existsSync(join(agents, `${label}.plist`)))
  assert.deepEqual(uninstall(system), [[label, "absent"], [cleanLabel, "absent"]])
})

test("a failed bootstrap is reported with launchctl's message", () => {
  const { system } = fakeLaunchd(join(scratch, "agents-fail"), true)
  assert.throws(() => install(options, system), /bootstrap gui\/501 .* failed: Bootstrap failed: 5/)
})

const capture = (env: Io["env"]) => {
  const out: Array<string> = [], err: Array<string> = []
  return {
    io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line), env, cwd: scratch },
    out,
    err
  }
}

test("the commands read the state directory's .env and refuse off macOS", async () => {
  const stateDir = join(scratch, "cmd-state")
  const bin = join(scratch, "cmd-bin")
  mkdirSync(bin, { recursive: true })
  for (const tool of ["jj", "git"]) {
    writeFileSync(join(bin, tool), "")
    chmodSync(join(bin, tool), 0o755)
  }
  const env = { SMITHERS_ORG_STATE_DIR: stateDir, PATH: bin, HOME: "/Users/me" }
  assert.throws(() => optionsOf({}, capture(env).io), /\.env is missing; run init first/)
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, ".env"), "SMITHERS_ORG_ROOT=wiki\n")
  // The Node where it is installed, not this process's.
  const installed = {
    exists: (path: string) => path === "/opt/node/bin/node",
    list: () => [],
    version: () => "99.0.0",
    real: (path: string) => path,
    homebrew: ["/opt/node/bin/node"]
  }
  assert.throws(
    () => optionsOf({}, capture(env).io, { ...installed, homebrew: [] }),
    /^Error: no Node >= \d+\.\d+\.\d+; /
  )
  const resolved = optionsOf({}, capture(env).io, installed)
  assert.equal(resolved.workingDirectory, join(scratch, "wiki"))
  assert.equal(resolved.node, "/opt/node/bin/node")
  assert.equal(resolved.path.split(":")[0], "/opt/node/bin")
  assert.equal(resolved.stateDir, stateDir)
  writeFileSync(join(stateDir, ".env"), "# no root\n")
  assert.equal(optionsOf({}, capture(env).io, installed).workingDirectory, stateDir)

  const agents = join(scratch, "cmd-agents")
  const { system } = fakeLaunchd(agents)
  const [installCommand, uninstallCommand] = commands(() => system, "darwin", installed)
  const run = capture(env)
  assert.equal(await installCommand.run([], run.io), 0)
  assert.deepEqual(run.out, [`installed ${label}`, `installed ${cleanLabel}`, `logs ${join(stateDir, "logs")}`])
  const removed = capture(env)
  assert.equal(await uninstallCommand.run([], removed.io), 0)
  assert.deepEqual(removed.out, [`removed ${label}`, `removed ${cleanLabel}`])

  const [linuxInstall, linuxUninstall] = commands(() => system, "linux")
  const refused = capture(env)
  assert.equal(await linuxInstall.run([], refused.io), 1)
  assert.equal(await linuxUninstall.run([], refused.io), 1)
  assert.match(refused.err[0]!, /macOS only/)
})
