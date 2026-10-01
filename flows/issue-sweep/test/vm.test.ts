import type { MicrosandboxSandbox } from "@smthrs/sandbox"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { hostname } from "node:os"
import test from "node:test"
import { agentHosts, guestCheckout, holderAlive, make, niceWrapper, refreshLine, sh } from "../vm.ts"

type Event =
  | { readonly kind: "started"; readonly pid: number }
  | { readonly kind: "stdout" | "stderr"; readonly data: Uint8Array }
  | { readonly kind: "exited"; readonly code: number }

/** What a guest command answers: its output and exit, or `"hang"` to never exit. */
type Answer = { readonly stdout?: string; readonly stderr?: string; readonly code: number } | "hang"

/**
 * A Microsandbox SDK whose machines answer commands from `answer` and record
 * every create and destroy, so a test reads what the provider did to them.
 */
const fakeSdk = (
  answer: (line: string) => Answer,
  snapshots = [{ name: "issue-sweep.aaa", createdAt: new Date(1) }],
  bootMs = 0
) => {
  const boots = { now: 0, peak: 0 }
  const live = new Set<string>()
  const created: Array<Record<string, unknown>> = []
  const destroyed: Array<string> = []
  const lines: Array<string> = []
  const envs: Array<Record<string, string>> = []
  const killed: Array<string> = []
  // A guest kill script (`p=<pid>; ...`) ends every hanging command, as the guest's signal would.
  const hanging = new Set<() => void>()
  const builder = (name: string) => {
    const config: Record<string, unknown> = { name }
    const chain = new Proxy({}, {
      get: (_, key: string) =>
        key === "create"
          ? async () => {
            boots.peak = Math.max(boots.peak, ++boots.now)
            await new Promise((resolve) => setTimeout(resolve, bootMs))
            boots.now--
            created.push(config)
            live.add(name)
            return machine(name)
          }
          : (value: unknown) => {
            config[key] = typeof value === "function"
              ? (value as (b: unknown) => unknown)({ policy: (p: unknown) => (config.policy = p) })
              : value
            return chain
          }
    })
    return chain
  }
  const machine = (name: string) => ({
    name,
    backendKind: "local" as const,
    fs: () => ({
      mkdir: async () => undefined,
      write: async () => undefined,
      read: async () => new Uint8Array(),
      readToString: async () => name
    }),
    execStreamWith: async (program: string, configure: (b: unknown) => unknown) => {
      const call = { args: [] as Array<string>, envs: {} as Record<string, string> }
      const b = {
        args: (a: Array<string>) => (call.args = a, b),
        cwd: () => b,
        envs: (vars: Record<string, string>) => (call.envs = vars, b),
        stdinBytes: () => b
      }
      configure(b)
      const line = [program, ...call.args].join(" ")
      lines.push(line)
      envs.push(call.envs)
      if (line.includes("p=7;")) {
        killed.push(line)
        for (const end of hanging) end()
      }
      const reply = answer(line)
      const events: Array<Event | null> = [{ kind: "started", pid: 7 }]
      if (reply !== "hang") {
        if (reply.stdout) events.push({ kind: "stdout", data: new TextEncoder().encode(reply.stdout) })
        if (reply.stderr) events.push({ kind: "stderr", data: new TextEncoder().encode(reply.stderr) })
        events.push({ kind: "exited", code: reply.code }, null)
      }
      let wake: (() => void) | undefined
      let ended = false
      if (reply === "hang") {
        const end = () => {
          hanging.delete(end)
          events.push({ kind: "exited", code: 143 }, null)
          wake?.()
        }
        hanging.add(end)
      }
      return {
        recv: async () => {
          while (events.length === 0 && !ended) await new Promise<void>((resolve) => (wake = resolve))
          return events.shift() ?? null
        },
        signal: async () => undefined,
        kill: async () => {
          ended = true
          wake?.()
        }
      }
    },
    destroy: async () => {
      destroyed.push(name)
      live.delete(name)
    }
  })
  const sdk = {
    Sandbox: {
      builder,
      get: async (name: string) => {
        throw Object.assign(new Error(`sandbox not found: ${name}`), { code: "sandboxNotFound" })
      },
      listWith: async () => ({ sandboxes: [] })
    },
    Snapshot: { get: async () => snapshots[0], list: async () => snapshots, remove: async () => undefined },
    defaultBackendKind: () => "local" as const,
    setDefaultBackend: () => undefined
  } as unknown as MicrosandboxSandbox.Sdk
  return { sdk, live, created, destroyed, lines, envs, killed, boots }
}

const ok: Answer = { code: 0 }

test("acquire boots the newest issue-sweep snapshot at the Cloud checkout path and refreshes main", async () => {
  const fake = fakeSdk((line) => line.includes("whoami") ? { stdout: "root\n", code: 0 } : ok, [
    { name: "issue-sweep.old", createdAt: new Date(1) },
    { name: "other.new", createdAt: new Date(3) },
    { name: "issue-sweep.new", createdAt: new Date(2) }
  ])
  const provider = make({ sdk: fake.sdk, holder: "test:1" })
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const session = yield* provider.acquire("issue-sweep:smithersai/smithers#1")
    assert.deepEqual([...fake.live], [session.remoteId])
    return { workdir: session.workdir, whoami: (yield* sh(session, "whoami")).stdout }
  })))
  assert.deepEqual(result, { workdir: guestCheckout, whoami: "root\n" })
  assert.equal(fake.created.length, 1)
  assert.equal(fake.created[0]!.fromSnapshot, "issue-sweep.new")
  assert.equal(fake.created[0]!.cpus, 2)
  assert.equal(fake.created[0]!.memory, 4096)
  const policy = fake.created[0]!.policy as {
    defaultEgress: string
    rules: Array<{ destination: { domain?: string } }>
  }
  assert.equal(policy.defaultEgress, "deny")
  assert.ok(policy.rules.some((rule) => rule.destination.domain === "github.com"))
  assert.ok(fake.lines.some((line) => line.includes(refreshLine)), "the checkout moves to current main")
  // #3321: agents ran Go and Cargo commands that were not on PATH.
  const env = fake.envs[fake.lines.findIndex((line) => line.includes(refreshLine))] ?? {}
  assert.match(env["PATH"] ?? "", /^\/usr\/local\/go\/bin:\/home\/developer\/workspace\/\.cache\/cargo\/bin:/)
  assert.equal(env["GOTOOLCHAIN"], "local", "go never downloads a toolchain")
  assert.equal(env["GOCACHE"], `${guestCheckout}/.cache/go-build`, "caches stay writable inside the checkout")
  assert.deepEqual([...fake.live], [], "the microVM is removed when the scope closes")
  assert.equal(fake.destroyed.length, 1)
  assert.equal(agentHosts.includes("example.com"), false)
})

test("a failed refresh fails the acquire with the guest's words, removes the microVM and frees its slot", async () => {
  const fake = fakeSdk((line) => line.includes("jj git fetch") ? { stderr: "fetch refused", code: 1 } : ok)
  const provider = make({ sdk: fake.sdk, maxVms: 1, holder: "test:1" })
  const exit = await Effect.runPromiseExit(Effect.scoped(provider.acquire("one")))
  assert.ok(Exit.isFailure(exit))
  assert.match(Cause.pretty(exit.cause), /refreshing the checkout exited 1: fetch refused/)
  assert.equal(fake.created.length, 1)
  assert.deepEqual([...fake.live], [])
  assert.equal(await Effect.runPromise(provider.slots.takeIfAvailable(1)), true, "the slot came back")
})

test("a failing body still removes its microVM", async () => {
  const fake = fakeSdk(() => ok)
  const provider = make({ sdk: fake.sdk, holder: "test:1" })
  const exit = await Effect.runPromiseExit(Effect.scoped(Effect.gen(function*() {
    yield* provider.acquire("body-fails")
    return yield* Effect.fail("agent failed")
  })))
  assert.ok(Exit.isFailure(exit))
  assert.equal(fake.destroyed.length, 1)
  assert.deepEqual([...fake.live], [])
})

test("interrupting a running guest command kills it, removes the microVM and frees the slot", async () => {
  const fake = fakeSdk((line) => line.includes("sleep") ? "hang" : ok)
  const provider = make({ sdk: fake.sdk, maxVms: 1, holder: "test:1" })
  const running = await Effect.runPromise(Deferred.make<void>())
  const fiber = Effect.runFork(Effect.scoped(Effect.gen(function*() {
    const session = yield* provider.acquire("interrupted")
    yield* Deferred.succeed(running, undefined)
    return yield* sh(session, "sleep 1000")
  })))
  await Effect.runPromise(Deferred.await(running))
  await new Promise((resolve) => setTimeout(resolve, 20))
  await Effect.runPromise(Fiber.interrupt(fiber))
  assert.ok(fake.killed.some((line) => line.includes("TERM")), "the command's process tree got SIGTERM")
  assert.deepEqual([...fake.live], [])
  assert.equal(await Effect.runPromise(provider.slots.takeIfAvailable(1)), true, "the slot came back")
})

test("maxVms queues an acquire until a slot frees", async () => {
  const fake = fakeSdk(() => ok)
  const provider = make({ sdk: fake.sdk, maxVms: 1, refresh: false, holder: "test:1" })
  const release = await Effect.runPromise(Deferred.make<void>())
  const first = Effect.runFork(Effect.scoped(Effect.andThen(provider.acquire("a"), Deferred.await(release))))
  await new Promise((resolve) => setTimeout(resolve, 20))
  const second = Effect.runFork(Effect.scoped(Effect.asVoid(provider.acquire("b"))))
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(fake.created.length, 1, "the second acquire waits for the first scope")
  await Effect.runPromise(Deferred.succeed(release, undefined))
  await Effect.runPromise(Fiber.join(first))
  await Effect.runPromise(Fiber.join(second))
  assert.equal(fake.created.length, 2)
  assert.deepEqual([...fake.live], [])
})

test("without a snapshot the acquire names the build command and boots nothing", async () => {
  const fake = fakeSdk(() => ok, [])
  const exit = await Effect.runPromiseExit(Effect.scoped(make({ sdk: fake.sdk, holder: "test:1" }).acquire("x")))
  assert.ok(Exit.isFailure(exit))
  assert.match(Cause.pretty(exit.cause), /vm-image\.ts/)
  assert.equal(fake.created.length, 0)
})

test("holderAlive: this process lives, a dead pid does not, another host's holder is left alone", () => {
  assert.equal(holderAlive(`${hostname()}:${process.pid}`), true)
  const dead = Number(execFileSync("sh", ["-c", "sh -c 'echo $$' "], { encoding: "utf8" }).trim())
  assert.equal(holderAlive(`${hostname()}:${dead}`), false)
  assert.equal(holderAlive(`another-host:${dead}`), true)
})

test("bootConcurrency boots at most that many microVMs at once while maxVms admits more", async () => {
  const fake = fakeSdk(() => ok, undefined, 10)
  const provider = make({ sdk: fake.sdk, maxVms: 6, bootConcurrency: 2, refresh: false, holder: "test:1" })
  await Effect.runPromise(Effect.forEach(
    [1, 2, 3, 4, 5, 6],
    (index) => Effect.scoped(Effect.asVoid(provider.acquire(`boot-${index}`))),
    { concurrency: "unbounded" }
  ))
  assert.equal(fake.boots.peak, 2)
  assert.equal(fake.created.length, 6)
  assert.deepEqual([...fake.live], [])
})

// #3328: busy guests starved the flow host's run-lease heartbeat and parked the sweep.
test("microVMs run through the nice wrapper at nice 10, below the flow host", () => {
  assert.equal(process.env.MSB_PATH, niceWrapper)
  const real = process.env.ISSUE_SWEEP_MSB ?? ""
  assert.match(real, /microsandbox-.*\/bin\/msb$/)
  const nice = execFileSync(niceWrapper, ["-c", "ps -o nice= -p $$"], {
    encoding: "utf8",
    env: { ...process.env, ISSUE_SWEEP_MSB: "/bin/sh" }
  }).trim()
  assert.equal(Number(nice), 10)
})
