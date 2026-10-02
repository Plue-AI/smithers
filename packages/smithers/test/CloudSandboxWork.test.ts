import { NodeServices } from "@effect/platform-node"
import * as CloudSandbox from "@smthrs/cli/CloudSandbox"
import { Sandbox, SandboxConformance, SandboxMerge } from "@smthrs/sandbox"
import { Effect } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner, make as makeSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

// The control API is fake because provisioning a VM is outside this contract.
// Everything the work contract touches is real: the guest is a local git clone
// reached through a local SSH stand-in and the real CommandSandbox transport,
// and the host is a real colocated jj repository. The fake models the one
// Cloud behavior that matters here: DELETE destroys the workspace's checkout.
const roots: Array<string> = []
const savedJjConfig = process.env.JJ_CONFIG
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (savedJjConfig === undefined) delete process.env.JJ_CONFIG
  else process.env.JJ_CONFIG = savedJjConfig
})

const identity = {
  GIT_AUTHOR_NAME: "Cloud Work",
  GIT_AUTHOR_EMAIL: "cloud-work@sandbox.invalid",
  GIT_COMMITTER_NAME: "Cloud Work",
  GIT_COMMITTER_EMAIL: "cloud-work@sandbox.invalid"
}

const run = (cwd: string, program: string, ...args: Array<string>): string =>
  execFileSync(program, args, { cwd, env: { ...process.env, ...identity }, encoding: "utf8" }).trim()

/** A colocated jj repository whose one commit holds the conformance seed files. */
const fixture = (deleteFailures = 0) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cloud-work-")))
  roots.push(root)
  const jjConfig = join(root, "jj.toml")
  writeFileSync(jjConfig, `[user]\nname = "Cloud Work"\nemail = "cloud-work@sandbox.invalid"\n`)
  process.env.JJ_CONFIG = jjConfig
  const host = join(root, "host")
  mkdirSync(host)
  run(host, "git", "init", "-q", "-b", "main")
  for (const [path, bytes] of Object.entries(SandboxConformance.workSeedFiles)) {
    mkdirSync(dirname(join(host, path)), { recursive: true })
    writeFileSync(join(host, path), bytes, { mode: 0o644 })
  }
  run(host, "git", "add", "-A")
  run(host, "git", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "base")
  const base = run(host, "git", "rev-parse", "HEAD")
  run(host, "jj", "git", "init", "--colocate", "--quiet")
  run(host, "git", "bundle", "create", "-q", join(root, "seed.bundle"), "--all")
  const bundle = new Uint8Array(readFileSync(join(root, "seed.bundle")))

  const ssh = join(root, "ssh")
  writeFileSync(ssh, "#!/bin/sh\nexec /bin/sh -c \"$*\"\n", { mode: 0o755 })
  const guest = join(root, "guest")
  const events: Array<string> = []
  const api: CloudSandbox.WorkspaceApi = {
    request: async (method) => {
      events.push(method)
      if (method === "POST") {
        // A new workspace is a fresh clone of the repository at its default bookmark.
        if (!existsSync(guest)) run(root, "git", "clone", "-q", host, guest)
        return { id: "ws-work", status: "pending" }
      }
      if (method === "DELETE") {
        if (deleteFailures-- > 0) throw new Error("secret-do-not-print")
        rmSync(guest, { recursive: true, force: true })
        return null
      }
      return { id: "ws-work", status: "running" }
    },
    sshPrefix: async () => [ssh]
  }
  const provider = Effect.map(ChildProcessSpawner, (local) =>
    CloudSandbox.make({
      // Every command the machine runs is recorded beside the API's calls.
      spawner: makeSpawner((command) => {
        events.push("ssh")
        return local.spawn(command)
      }),
      repository: "acme/repo",
      api,
      workdir: guest,
      pollInterval: "10 millis"
    }))
  return { root, host, guest, base, bundle, events, provider }
}

const shell = (script: string) =>
  Effect.flatMap(ChildProcessSpawner, (guest) =>
    guest.string(ChildProcess.make("/bin/sh", ["-c", script], {
      env: identity,
      extendEnv: true
    })))

describe("CloudSandbox work", () => {
  it.each([2, Infinity])("retains captured work after %s deletion failures", async (failures) => {
    const { guest, events, provider } = fixture(failures)
    const warning = vi.spyOn(console, "log").mockImplementation(() => {})
    try {
      const captured = await Effect.runPromise(
        Effect.flatMap(
          provider,
          (cloud) =>
            Sandbox.run(
              cloud,
              { session: "cleanup-retry" },
              shell("printf 'saved\\n' >> tracked.txt && printf completed")
            )
        )
          .pipe(Effect.provide(NodeServices.layer))
      )
      expect(captured.result).toBe("completed")
      expect(captured.work._tag).toBe("Changed")
      if (captured.work._tag === "Changed") expect(captured.work.patch).toContain("+saved")
      expect(events.filter((event) => event === "DELETE")).toHaveLength(failures === Infinity ? 4 : 3)
      expect(events.lastIndexOf("ssh")).toBeLessThan(events.indexOf("DELETE"))
      expect(existsSync(guest)).toBe(failures === Infinity)
      if (failures === Infinity) {
        const logs = warning.mock.calls.flat().join(" ")
        expect(logs).toContain("ws-work")
        expect(logs).toContain("client lease expiry")
        expect(logs).not.toContain("secret-do-not-print")
      }
    } finally {
      warning.mockRestore()
    }
  }, 120_000)

  it("captures the workspace's work before DELETE and merges it onto the host repository", async () => {
    const { host, guest, base, events, provider } = fixture()
    const { result, work } = await Effect.runPromise(
      Effect.gen(function*() {
        const cloud = yield* provider
        return yield* Sandbox.run(
          cloud,
          { session: "cloud-work" },
          shell(
            "printf 'committed\\n' > committed.txt && git add committed.txt && " +
              "git -c commit.gpgsign=false commit -q -m guest && " +
              "printf 'more\\n' >> tracked.txt && printf 'new\\n' > untracked.txt && " +
              "mv rename-me.txt renamed.txt && rm delete-me.txt && chmod 755 chmod-me.sh && " +
              "printf '\\000\\001\\377' > binary.bin && printf edited"
          )
        )
      }).pipe(Effect.provide(NodeServices.layer))
    )
    expect(result).toBe("edited")
    expect(work._tag).toBe("Changed")
    expect(work.base).toBe(base)
    expect(work.session).toBe("cloud-work")
    if (work._tag !== "Changed") return
    expect(work.patch).toContain("rename from rename-me.txt\nrename to renamed.txt\n")
    expect(work.patch).toContain("deleted file mode 100644")
    expect(work.patch).toContain("new mode 100755")
    expect(work.patch).toContain("GIT binary patch")
    // The capture's command ran, and only then did the API see DELETE; the
    // DELETE destroyed the checkout, so nothing after it could have captured.
    expect(events[0]).toBe("POST")
    expect(events.at(-1)).toBe("DELETE")
    expect(events.filter((event) => event === "DELETE")).toHaveLength(1)
    expect(events.lastIndexOf("ssh")).toBeLessThan(events.indexOf("DELETE"))
    expect(existsSync(guest)).toBe(false)

    const outcome = await Effect.runPromise(
      SandboxMerge.apply(work, { repository: host, onto: base, message: "cloud work", fetch: false }).pipe(
        Effect.provide(NodeServices.layer)
      )
    )
    expect(outcome._tag).toBe("Merged")
    if (outcome._tag !== "Merged") return
    const show = (path: string) => run(host, "jj", "--ignore-working-copy", "file", "show", "-r", outcome.commit, path)
    expect(show("committed.txt")).toBe("committed")
    expect(show("tracked.txt")).toBe("tracked\nmore")
    expect(show("untracked.txt")).toBe("new")
    expect(show("renamed.txt")).toBe(readFileSync(join(host, "rename-me.txt"), "utf8").trim())
    const files = run(host, "jj", "--ignore-working-copy", "file", "list", "-r", outcome.commit).split("\n")
    expect(files).not.toContain("delete-me.txt")
    expect(files).not.toContain("rename-me.txt")
    expect(run(host, "git", "ls-tree", outcome.commit, "chmod-me.sh")).toMatch(/^100755 /)
    expect(run(host, "jj", "--ignore-working-copy", "log", "--no-graph", "-r", `${outcome.commit}-`, "-T", "commit_id"))
      .toBe(base)
  }, 120_000)

  it("returns Unchanged for a workspace that edited nothing, still before DELETE", async () => {
    const { base, events, provider } = fixture()
    const { work } = await Effect.runPromise(
      Effect.flatMap(provider, (cloud) => Sandbox.run(cloud, { session: "cloud-idle" }, shell("git status --short")))
        .pipe(Effect.provide(NodeServices.layer))
    )
    expect(work).toMatchObject({ _tag: "Unchanged", base, session: "cloud-idle" })
    expect(events.lastIndexOf("ssh")).toBeLessThan(events.indexOf("DELETE"))
  }, 120_000)

  it("passes SandboxConformance, the work checks included", async () => {
    const { base, bundle, provider } = fixture()
    const violations = await Effect.runPromise(
      Effect.flatMap(provider, (cloud) =>
        SandboxConformance.check(cloud, {
          session: "cloud-conformance",
          // Each work check makes about a dozen framed SSH round trips and
          // streams a bundle through the shell, past the 10 s default.
          checkTimeout: "120 seconds",
          work: { bundle, base },
          commands: SandboxConformance.posixCommands
        })).pipe(Effect.provide(NodeServices.layer))
    )
    expect(violations).toEqual([])
  }, 600_000)
})
