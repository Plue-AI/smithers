import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import * as NodeResolve from "./node.ts"

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "org-node-")))
after(() => rmSync(scratch, { recursive: true, force: true }))

/** A `node` that prints `version`, at `path`. */
const fake = (path: string, version: string) => {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, `#!/bin/sh\necho v${version}\n`)
  chmodSync(path, 0o755)
  return path
}

const local: NodeResolve.System = { ...NodeResolve.system, homebrew: [] }

test("prefers PATH, follows an fnm shell link to its installation, then fnm, Volta, nvm and Homebrew", () => {
  const home = join(scratch, "home")
  const fnmInstall = fake(join(home, ".local/share/fnm/node-versions/v26.6.0/installation/bin/node"), "26.6.0")
  fake(join(home, ".local/share/fnm/node-versions/v26.5.0/installation/bin/node"), "26.5.0")
  mkdirSync(join(home, ".local/share/fnm/node-versions/not-a-version"), { recursive: true })
  const volta = fake(join(home, ".volta/tools/image/node/26.5.1/bin/node"), "26.5.1")
  const nvmOld = fake(join(home, ".nvm/versions/node/v22.4.1/bin/node"), "22.4.1")
  const nvm = fake(join(home, ".nvm/versions/node/v26.5.0/bin/node"), "26.5.0")
  const brew = fake(join(scratch, "brew/bin/node"), "26.5.0")
  const shell = join(scratch, "state/fnm_multishells/1_2")
  mkdirSync(join(shell, ".."), { recursive: true })
  symlinkSync(join(home, ".local/share/fnm/node-versions/v26.6.0/installation"), shell)
  const old = fake(join(scratch, "old/node"), "24.4.1")
  const env = { PATH: [join(scratch, "old"), join(shell, "bin"), "", join(scratch, "empty")].join(":") }
  const on = { ...local, homebrew: [brew, join(scratch, "missing/node")] }
  const realInstall = NodeResolve.system.real(fnmInstall)
  assert.deepEqual(NodeResolve.candidates(env, home, on), [
    old,
    realInstall,
    join(home, ".local/share/fnm/node-versions/v26.5.0/installation/bin/node"),
    volta,
    nvm,
    nvmOld,
    brew
  ])
  assert.deepEqual(NodeResolve.resolve(env, home, "26.5.0", on), {
    _tag: "Found",
    node: { path: realInstall, version: "26.6.0" }
  })
  // An explicit Node comes first; managers named by their variables are read there.
  const pinned = fake(join(scratch, "pinned/node"), "26.7.0")
  assert.equal(NodeResolve.candidates({ SMITHERS_ORG_NODE: pinned }, home, on)[0], pinned)
  assert.deepEqual(
    NodeResolve.candidates(
      { NVM_DIR: join(home, ".nvm"), VOLTA_HOME: join(scratch, "none"), FNM_DIR: join(scratch, "none") },
      join(scratch, "nobody"),
      local
    ),
    [nvm, nvmOld]
  )
})

test("names the newest Node too old, and the one command that installs one", () => {
  const home = join(scratch, "old-home")
  fake(join(home, ".nvm/versions/node/v22.4.1/bin/node"), "22.4.1")
  fake(join(home, ".nvm/versions/node/v24.1.0/bin/node"), "24.1.0")
  writeFileSync(join(scratch, "broken"), "#!/bin/sh\nexit 1\n")
  chmodSync(join(scratch, "broken"), 0o755)
  const resolved = NodeResolve.resolve({ SMITHERS_ORG_NODE: join(scratch, "broken") }, home, "26.5.0", local)
  assert.deepEqual(resolved, {
    _tag: "Missing",
    newest: { path: join(home, ".nvm/versions/node/v24.1.0/bin/node"), version: "24.1.0" },
    fix: "nvm install 26.5.0"
  })
  const none = join(scratch, "none")
  const bare = { ...local, exists: (path: string) => path.startsWith(scratch) && local.exists(path) }
  assert.equal(NodeResolve.resolve({}, none, "26.5.0", bare)._tag, "Missing")
  assert.equal(NodeResolve.installFix({ FNM_DIR: home }, none, "26.5.0", bare), "fnm install 26.5.0")
  assert.equal(NodeResolve.installFix({ VOLTA_HOME: home }, none, "26.5.0", bare), "volta install node@26.5.0")
  assert.equal(
    NodeResolve.installFix({}, none, "26.5.0", bare),
    "curl -fsSL https://fnm.vercel.app/install | bash && fnm install 26.5.0"
  )
  assert.equal(
    NodeResolve.installFix({}, none, "26.5.0", { ...bare, exists: (path) => path === "/opt/homebrew/bin/brew" }),
    "brew install node"
  )
  assert.equal(NodeResolve.system.version(join(scratch, "missing")), undefined)
  assert.deepEqual(NodeResolve.system.list(join(scratch, "missing")), [])
})
