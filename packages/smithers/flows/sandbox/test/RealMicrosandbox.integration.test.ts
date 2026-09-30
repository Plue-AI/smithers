import { afterAll, describe, expect, it } from "@effect/vitest"
import { Edit, Write } from "@smthrs/std"
import { Cause, Effect, Fiber, FileSystem, Path, Stream } from "effect"
import * as Microsandbox from "microsandbox"
import { accessSync, constants } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { networkInterfaces } from "node:os"
import { fileURLToPath } from "node:url"
import { elapsed } from "../src/internal/deadline.ts"
import * as MicrosandboxSandbox from "../src/MicrosandboxSandbox/index.ts"
import type { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import { fileSystem } from "../src/Sandbox/fileSystem.ts"
import type { Session } from "../src/Sandbox/Session.ts"
import * as SandboxConformance from "../src/SandboxConformance/index.ts"
import { discover } from "./helpers/discover.ts"

const session = `real-microsandbox-${process.pid}-${Date.now()}`
const budget = 900_000

// Every machine this suite boots belongs to an owner no other run shares and
// carries a label naming the run, so the sweep after it removes this run's
// machines and nothing else on the host.
const owner = `smithers-test-${session}`
const labels = { "smithers.test": session }
const machine = (options: Partial<MicrosandboxSandbox.MicrosandboxSandboxOptions> = {}) =>
  MicrosandboxSandbox.make({
    sdk: Microsandbox,
    image: "oven/bun:1",
    pullPolicy: "if-missing",
    maxDurationSecs: 600,
    idleTimeoutSecs: 120,
    owner,
    labels,
    ...options
  })

/**
 * Why this host cannot boot a microVM, or `undefined` when it can.
 *
 * The CLI and SDK ship through the same platform package, so a machine without
 * a runnable platform binary names the real test as a skip rather than
 * pretending that a fake proved the microVM boundary.
 *
 * A runnable binary is not the capability. A microVM needs a hypervisor, and a
 * hosted runner installs the CLI while providing none; the boot then dies
 * inside libkrun and reads as a product failure rather than as the missing
 * capability it is. So the gate asks the host for the hypervisor itself. On
 * Linux that is `/dev/kvm`, readable and writable by this process. On macOS it
 * is Hypervisor.framework, which advertises itself through `kern.hv_support`,
 * and `kern.hv_vmm_present` says whether this machine is itself a guest —
 * GitHub's Apple-silicon runners are, and Apple's Virtualization Framework
 * gives its guests no nested virtualization. Microsandbox reaches no hypervisor
 * on any other platform.
 *
 * Every one of those answers is an advertisement rather than a boot, so a host
 * that passes them all boots one microVM through the provider under test.
 * `hv_vm_create` can still be refused, and libkrun reports that refusal as
 * `VmSetup(VmCreate)`; that exact refusal names the missing capability and
 * skips. Every other failure, and a probe that outlasts its budget, leave the
 * suite to run and report what it finds: a skip is only ever a positive reading
 * of a capability this host does not have.
 */
const probeBudget = 300_000

const unbootable = async (): Promise<string | undefined> => {
  if (discover("microsandbox", ["--version"]).status !== 0) {
    return "the microsandbox platform binary does not run here"
  }
  if (process.platform === "linux") {
    try {
      accessSync("/dev/kvm", constants.R_OK | constants.W_OK)
    } catch {
      return "this Linux host exposes no /dev/kvm this process may read and write"
    }
  } else if (process.platform === "darwin") {
    const sysctl = (name: string): string | undefined => {
      const read = discover("sysctl", ["-n", name])
      return read.status === 0 ? read.stdout.trim() : undefined
    }
    if (sysctl("kern.hv_support") !== "1") {
      return "this macOS host reports no Hypervisor.framework support (kern.hv_support)"
    }
    if (sysctl("kern.hv_vmm_present") === "1") {
      return "this macOS host is itself a guest (kern.hv_vmm_present), and Apple's Virtualization Framework"
        + " gives its guests no nested virtualization"
    }
  } else {
    return `microsandbox reaches no hypervisor on ${process.platform}`
  }
  const refusal = await Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(
        machine({ maxDurationSecs: 120, idleTimeoutSecs: 60 }).acquire(`${session}-probe`),
        () => Effect.void
      )
    ).pipe(
      Effect.timeoutOption(probeBudget),
      Effect.as(undefined),
      Effect.catchCause((cause) => Effect.succeed(Cause.pretty(cause)))
    )
  )
  return refusal !== undefined && refusal.includes("VmSetup(VmCreate)")
    ? "this host's hypervisor refused to create a VM (VmSetup(VmCreate)): it provides no nested virtualization"
    : undefined
}

const missing = await unbootable()
const available = missing === undefined

// The skip has to be visible, and it has to name what is missing: a case that
// silently disappears is indistinguishable from one that never existed, and one
// that disappears without a reason is indistinguishable from a suite quietly
// switched off.
describe.skipIf(available)("MicrosandboxSandbox against a real microVM", () => {
  it(`is skipped because ${missing ?? "this machine can boot a microVM"}`, () => {
    expect(missing).toEqual(expect.any(String))
  })
})

/** Whether a guest file exists, as the session answers it. */
const present = (live: Session, path: string) =>
  live.readFile(path).pipe(
    Effect.as(true),
    Effect.catchIf((error: ProviderError) => error.code === "not_found", () => Effect.succeed(false))
  )

/** Waits, on the wall clock, until a guest file exists. */
const awaitFile = (live: Session, path: string) =>
  Effect.gen(function*() {
    for (let tries = 0; tries < 300; tries++) {
      if (yield* present(live, path)) return
      yield* elapsed(100)
    }
    return yield* Effect.die(new Error(`${path} never appeared in ${live.remoteId}`))
  })

describe.skipIf(!available)("MicrosandboxSandbox against a real microVM", () => {
  // Nothing this suite created may outlive it, whatever a case left behind.
  afterAll(() =>
    Effect.runPromise(
      MicrosandboxSandbox.reap({ sdk: Microsandbox, owner, isAlive: () => Effect.succeed(false) })
    ), 120_000)

  it.effect(
    "passes the sandbox conformance suite, kill, interrupt, and ephemeral release included",
    () =>
      Effect.gen(function*() {
        const violations = yield* SandboxConformance.check(machine(), {
          session,
          // Real VM provisioning keeps its previous allowance; ordinary checks default to 10 seconds.
          checkTimeout: "240 seconds",
          provides: { ping: true, kill: true, interrupt: true, ephemeral: true }
        })
        expect(violations).toEqual([])
      }),
    budget
  )

  it.effect(
    "hides host paths and the host's environment and refuses egress without a network",
    () =>
      Effect.gen(function*() {
        const variable = "SMITHERS_TEST_HOST_CREDENTIAL"
        const credential = `host-only-${session}`
        process.env[variable] = credential
        try {
          const provider = machine({ network: "none" })
          const violations = yield* SandboxConformance.check(provider, {
            session: `${session}-isolated`,
            checkTimeout: "240 seconds",
            isolation: {
              // This file exists on the host and nowhere in the image.
              hostSentinel: fileURLToPath(import.meta.url),
              egressProbe: `bun -e 'await fetch("https://example.com", { signal: AbortSignal.timeout(5000) })'`
            }
          })
          expect(violations).toEqual([])
          const seen = yield* Effect.scoped(Effect.flatMap(
            provider.acquire(`${session}-environment`),
            (live) =>
              Effect.scoped(Effect.flatMap(
                live.spawn(`env | grep -c '${credential}'; test -e /Users; echo users=$?`, {}),
                (running) => Stream.mkString(Stream.decodeText(running.stdout))
              ))
          ))
          expect(seen).toBe("0\nusers=1\n")
        } finally {
          delete process.env[variable]
        }
      }),
    budget
  )

  it.live(
    "reaches nothing by default, only allowlisted hosts, and never a service on the host or its network",
    () =>
      Effect.gen(function*() {
        const fetches = (url: string) =>
          `bun -e 'const r = await fetch("${url}", { signal: AbortSignal.timeout(5000) }); ` +
          `console.log(r.status, (await r.text()).slice(0, 20))' >/dev/null 2>&1; echo $?`
        const probe = (
          options: Partial<MicrosandboxSandbox.MicrosandboxSandboxOptions>,
          key: string,
          command: string
        ) =>
          Effect.scoped(Effect.flatMap(
            machine(options).acquire(`${session}-${key}`),
            (live) =>
              Effect.scoped(Effect.flatMap(
                live.spawn(command, {}),
                (running) => Stream.mkString(Stream.decodeText(running.stdout))
              ))
          ))

        // A machine that names no network reaches nothing: the provider
        // closes the vendor's open default itself.
        const closed = yield* probe({}, "default-network", fetches("https://example.com/"))
        expect(closed).toBe("1\n")

        // An allowlist admits the listed host and nothing else.
        const allowed = yield* probe(
          { network: { allow: ["registry.npmjs.org"] } },
          "allowlisted",
          `${fetches("https://registry.npmjs.org/")}; ${fetches("https://example.com/")}`
        )
        expect(allowed).toBe("0\n1\n")

        // Under an explicitly open network the public internet answers, but a
        // service listening on every host address does not, by loopback or by LAN.
        const server = createServer((_request, response) => response.end("host service"))
        yield* Effect.callback<void>((resume) => {
          server.listen(0, "0.0.0.0", () => resume(Effect.void))
        })
        try {
          const port = (server.address() as AddressInfo).port
          const lan = Object.values(networkInterfaces()).flat()
            .find((address) => address !== undefined && address.family === "IPv4" && !address.internal)?.address
          const targets = [`http://127.0.0.1:${port}/`, ...lan === undefined ? [] : [`http://${lan}:${port}/`]]
          const seen = yield* probe(
            { network: "open" },
            "open-network",
            [fetches("https://example.com/"), ...targets.map(fetches)].join("; ")
          )
          expect(seen).toBe(`0\n${targets.map(() => "1\n").join("")}`)
        } finally {
          server.close()
        }
      }),
    budget
  )

  it.live(
    "holds a machine to its CPU, memory, disk, and lifetime ceilings",
    () =>
      Effect.gen(function*() {
        const measured = yield* Effect.scoped(Effect.flatMap(
          machine({ limits: { cpus: 2, memoryMib: 1024 }, rootDiskMib: 1024 }).acquire(`${session}-limits`),
          (live) =>
            Effect.scoped(Effect.flatMap(
              live.spawn(
                "nproc; awk '/MemTotal/ { print $2 }' /proc/meminfo; df -m / | awk 'NR == 2 { print $2 }'; " +
                  "bun -e 'const kept = []; for (;;) kept.push(Buffer.alloc(32 << 20, 1))' 2>/dev/null; echo $?; " +
                  "dd if=/dev/zero of=fill bs=1M count=2048 2>/dev/null; echo $?; rm -f fill",
                {}
              ),
              (running) => Stream.mkString(Stream.decodeText(running.stdout))
            ))
        ))
        const [cpus, memoryKib, diskMib, allocation, fill] = measured.trim().split("\n").map(Number)
        expect(cpus).toBe(2)
        expect(memoryKib).toBeGreaterThan(768 * 1024)
        expect(memoryKib).toBeLessThanOrEqual(1024 * 1024)
        expect(diskMib).toBeLessThanOrEqual(1024)
        // The guest kernel kills the runaway allocation; the disk refuses the fill.
        expect(allocation).toBe(137)
        expect(fill).not.toBe(0)

        // The lifetime ceiling ends the machine under a command that outlives it.
        const began = Date.now()
        const ended = yield* Effect.scoped(Effect.flatMap(
          machine({ maxDurationSecs: undefined, limits: { timeoutSecs: 20 } }).acquire(`${session}-lifetime`),
          (live) =>
            Effect.scoped(Effect.flatMap(live.spawn("sleep 120", {}), (running) => Effect.flip(running.exitCode)))
        )).pipe(Effect.timeout("90 seconds"))
        expect(ended.code).toBe("unavailable")
        expect(Date.now() - began).toBeLessThan(90_000)
      }),
    budget
  )

  it.live(
    "interrupting a command kills a backgrounded descendant that left its process group",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const live = yield* machine().acquire(`${session}-interrupt`)
        // `setsid` puts the background writer in a session and process group
        // of its own, out of reach of a signal to the command's group alone.
        const fiber = yield* Effect.forkChild(Effect.scoped(Effect.flatMap(
          live.spawn(
            "printf go > started; setsid sh -c 'sleep 3; printf x > escaped' & sleep 3; printf x > direct",
            {}
          ),
          (running) => running.exitCode
        )))
        yield* awaitFile(live, `${live.workdir}/started`)
        yield* Fiber.interrupt(fiber)
        yield* elapsed(4_500)
        expect(yield* present(live, `${live.workdir}/direct`)).toBe(false)
        expect(yield* present(live, `${live.workdir}/escaped`)).toBe(false)
        // The machine itself is untouched and still runs commands.
        const after = yield* Effect.scoped(Effect.flatMap(live.spawn("true", {}), (running) => running.exitCode))
        expect(after).toBe(0)
      })),
    budget
  )

  it.live(
    "interrupting a command on a single vCPU never lets its shell run the next statement",
    () =>
      Effect.gen(function*() {
        // One vCPU is where a parent woken by its child's death could run
        // before its own signal landed. A freshly booted guest is busiest, so
        // every round boots its own machine; repeated because it is a race.
        for (let round = 0; round < 10; round++) {
          yield* Effect.scoped(Effect.gen(function*() {
            const live = yield* machine({ cpus: 1, memoryMib: 512 }).acquire(`${session}-one-cpu-${round}`)
            const fiber = yield* Effect.forkChild(Effect.scoped(Effect.flatMap(
              live.spawn(`printf go > started-${round}; sleep 2; printf x > survived-${round}`, {}),
              (running) => running.exitCode
            )))
            yield* awaitFile(live, `${live.workdir}/started-${round}`)
            yield* Fiber.interrupt(fiber)
            yield* elapsed(2_500)
            expect(yield* present(live, `${live.workdir}/survived-${round}`)).toBe(false)
          }))
        }
      }),
    budget
  )

  it.live(
    "keeps two concurrent machines apart",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const provider = machine()
        const [left, right] = yield* Effect.all(
          [provider.acquire(`${session}-left`), provider.acquire(`${session}-right`)],
          { concurrency: "unbounded" }
        )
        expect(left.remoteId).not.toBe(right.remoteId)
        yield* Effect.all([
          left.writeFile(`${left.workdir}/whose`, new TextEncoder().encode("left")),
          left.writeFile(`${left.workdir}/left-only`, new Uint8Array([1])),
          right.writeFile(`${right.workdir}/whose`, new TextEncoder().encode("right"))
        ], { concurrency: "unbounded" })
        // Both machines run a command at once, each seeing only its own files.
        const [leftSees, rightSees] = yield* Effect.all(
          [left, right].map((live) =>
            Effect.scoped(Effect.flatMap(
              live.spawn("cat whose; test -e left-only && printf ' +left-only'", {}),
              (running) => Stream.mkString(Stream.decodeText(running.stdout))
            ))
          ),
          { concurrency: "unbounded" }
        )
        expect(leftSees).toBe("left +left-only")
        expect(rightSees).toBe("right")
        expect(yield* present(right, `${right.workdir}/left-only`)).toBe(false)
      })),
    budget
  )

  it.live(
    "reaps a sticky machine whose holder died, and keeps one whose holder lives",
    () =>
      Effect.gen(function*() {
        const dead = `dead-holder-${session}`
        const alive = `live-holder-${session}`
        // A sticky machine outlives the scope that held it: that is the
        // orphan a holder leaves behind when it dies.
        const orphan = yield* Effect.scoped(Effect.map(
          machine({ persistence: "sticky", holder: dead }).acquire(`${session}-orphan`),
          (live) => live.remoteId
        ))
        const kept = yield* Effect.scoped(Effect.map(
          machine({ persistence: "sticky", holder: alive }).acquire(`${session}-kept`),
          (live) => live.remoteId
        ))
        expect((yield* Effect.promise(() => Microsandbox.Sandbox.get(orphan))).status).toBe("running")

        const reaped = yield* MicrosandboxSandbox.reap({
          sdk: Microsandbox,
          owner,
          isAlive: (holder) => Effect.succeed(holder === alive)
        })

        expect(reaped.map(({ holder, name }) => ({ holder, name }))).toEqual([{ holder: dead, name: orphan }])
        const gone = yield* Effect.promise(() =>
          Microsandbox.Sandbox.get(orphan).then(() => "present", (cause: unknown) => Reflect.get(Object(cause), "code"))
        )
        expect(gone).toBe("sandboxNotFound")
        expect((yield* Effect.promise(() => Microsandbox.Sandbox.get(kept))).status).toBe("running")
      }),
    budget
  )

  it.live(
    "fails a command the guest cannot start with spawn_error instead of hanging",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const live = yield* machine().acquire(`${session}-unstarted`)
        // The guest agent reports a missing working directory as a failed
        // start, an event the vendor SDK hands back as `undefined`.
        const failure = yield* Effect.scoped(Effect.flatMap(
          live.spawn("true", { cwd: "no-such-directory" }),
          (running) => Effect.flip(running.exitCode)
        )).pipe(Effect.timeout("30 seconds"))
        expect(failure.code).toBe("spawn_error")
      })),
    budget
  )

  it.live(
    "fails a running command with unavailable promptly when its machine is destroyed under it",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const live = yield* machine().acquire(`${session}-lost`)
        const running = yield* live.spawn("printf go > started; sleep 120", {})
        yield* awaitFile(live, `${live.workdir}/started`)
        // Another party removes the machine while the command runs.
        const began = Date.now()
        yield* Effect.promise(() =>
          Microsandbox.Sandbox.get(live.remoteId).then((handle) => handle.destroy({ timeoutMs: 1_000, force: true }))
        )
        const failure = yield* Effect.flip(running.exitCode).pipe(Effect.timeout("10 seconds"))
        expect(failure.code).toBe("unavailable")
        expect(Date.now() - began).toBeLessThan(10_000)
      })),
    budget
  )

  it.live(
    "serves exclusive creation, overwrite, modes, and the std write and edit tools through the session's files",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const live = yield* machine({ image: "node:26-bookworm" }).acquire(`${session}-files`)
        const fs = fileSystem(live)
        const tools = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
          effect.pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provide(Path.layer))
        const shell = (command: string) =>
          Effect.scoped(Effect.flatMap(
            live.spawn(command, {}),
            (running) => Stream.mkString(Stream.decodeText(running.stdout))
          ))
        const lib = `${live.workdir}/lib.txt`

        // The agent's write tool creates through an exclusive sibling.
        expect(yield* tools(Write.run({ path: lib, content: "alpha\nbeta\n" }))).toMatchObject({ created: true })

        // Exclusive creation takes the requested mode and refuses an
        // occupied name without touching its contents.
        const fresh = `${live.workdir}/fresh.txt`
        yield* fs.writeFileString(fresh, "first", { flag: "wx", mode: 0o640 })
        const refused = yield* Effect.flip(fs.writeFileString(fresh, "second", { flag: "wx" }))
        expect(refused.reason._tag).toBe("AlreadyExists")
        expect(yield* fs.readFileString(fresh)).toBe("first")
        expect(((yield* fs.stat(fresh)).mode) & 0o7777).toBe(0o640)

        // An overwrite through the tool keeps the file's mode.
        yield* fs.chmod(lib, 0o750)
        expect(yield* tools(Write.run({ path: lib, content: "alpha\nbeta\ngamma\n" }))).toMatchObject({
          created: false
        })
        expect(((yield* fs.stat(lib)).mode) & 0o7777).toBe(0o750)

        // So does an edit, and the guest's own tools see the result.
        expect(yield* tools(Edit.run({ path: lib, oldString: "beta", newString: "delta" }))).toMatchObject({
          replacements: 1
        })
        expect(yield* shell("cat lib.txt; stat -c %a lib.txt")).toBe("alpha\ndelta\ngamma\n750\n")
        // No sibling from any replacement is left in the workspace.
        expect(yield* shell("ls -A")).toBe("fresh.txt\nlib.txt\n")
      })),
    budget
  )

  it.live(
    "captures a prepared machine without its credentials and refuses one that still holds a secret",
    () =>
      Effect.gen(function*() {
        const token = `ghp_${session.replaceAll("-", "")}`
        const armor = "-----BEGIN OPENSSH PRIVATE KEY-----"
        const key = `${armor}\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n` +
          "-----END OPENSSH PRIVATE KEY-----\n"
        const setup = "echo installed > deps.txt && mkdir -p /root/.config/gh /etc/ssh .git && " +
          `printf '%s\\n' '${armor}' > /etc/ssh/armor && ` +
          `printf 'https://x:%s@github.com\\n' "$GITHUB_TOKEN" > /root/.git-credentials && ` +
          `printf 'github.com:\\n  oauth_token: %s\\n' "$GITHUB_TOKEN" > /root/.config/gh/hosts.yml`
        const prepare = (key: string, extra: string) =>
          Effect.scoped(Effect.gen(function*() {
            const live = yield* machine({ persistence: "sticky", env: { GITHUB_TOKEN: token } }).acquire(key)
            const code = yield* Effect.scoped(Effect.flatMap(live.spawn(`${setup}${extra}`, {}), (run) => run.exitCode))
            expect(code).toBe(0)
            return live.remoteId
          }))
        const capture = (machine: string, member: string) =>
          MicrosandboxSandbox.captureSnapshot({
            sdk: Microsandbox,
            machine,
            family: `smthrs-test-${process.pid}`,
            member,
            secrets: [token, key]
          })

        // A clone whose remote URL carries the token is refused, naming the file.
        const leaky = yield* prepare(
          `${session}-leaky`,
          ` && printf '[remote "origin"]\\n  url = https://x:%s@github.com/o/r\\n' "$GITHUB_TOKEN" > .git/config`
        )
        const refused = yield* Effect.flip(
          capture(leaky, "leaky").pipe(
            Effect.ensuring(Effect.ignore(MicrosandboxSandbox.removeSnapshot(
              Microsandbox,
              `smthrs-test-${process.pid}.leaky`
            )))
          )
        )
        expect(refused.message).toBe(
          `microsandbox: the microVM ${leaky} was not captured as smthrs-test-${process.pid}.leaky: ` +
            "a secret is still on its disk at /workspace/.git/config"
        )

        const rootLeaky = yield* prepare(
          `${session}-root-leaky`,
          ` && printf 'token=%s' "$GITHUB_TOKEN" > /..leak`
        )
        const rootRefused = yield* Effect.flip(
          capture(rootLeaky, "root-leaky").pipe(
            Effect.ensuring(Effect.ignore(MicrosandboxSandbox.removeSnapshot(
              Microsandbox,
              `smthrs-test-${process.pid}.root-leaky`
            )))
          )
        )
        expect(rootRefused.message).toBe(
          `microsandbox: the microVM ${rootLeaky} was not captured as smthrs-test-${process.pid}.root-leaky: ` +
            "a secret is still on its disk at /..leak"
        )

        const runLeaky = yield* prepare(
          `${session}-run-leaky`,
          ` && mkdir -p /run && printf 'token=%s' "$GITHUB_TOKEN" > /run/leak`
        )
        const runLeakyName = `smthrs-test-${process.pid}.run-leaky`
        const runRefused = yield* Effect.flip(
          capture(runLeaky, "run-leaky").pipe(
            Effect.ensuring(Effect.ignore(MicrosandboxSandbox.removeSnapshot(Microsandbox, runLeakyName)))
          )
        )
        expect(runRefused.message).toBe(
          `microsandbox: the microVM ${runLeaky} was not captured as ${runLeakyName}: ` +
            "a secret is still on its disk at /run/leak"
        )

        // Without the clone, the credential files are scrubbed and the capture succeeds.
        const clean = yield* prepare(`${session}-clean`, "")
        const name = yield* capture(clean, "clean")
        yield* Effect.scoped(Effect.gen(function*() {
          const restored = yield* machine({ image: undefined, snapshot: name }).acquire(`${session}-restored`)
          const seen = yield* Effect.scoped(Effect.flatMap(
            restored.spawn(
              `cat deps.txt /etc/ssh/armor; ls /root/.git-credentials /root/.config/gh/hosts.yml 2>&1; ` +
                `grep -rlF '${token}' /root /etc /workspace; echo "grep $?"`,
              {}
            ),
            (run) => Stream.mkString(Stream.decodeText(run.stdout))
          ))
          expect(seen).toBe(
            `installed\n${armor}\n` +
              "ls: cannot access '/root/.git-credentials': No such file or directory\n" +
              "ls: cannot access '/root/.config/gh/hosts.yml': No such file or directory\ngrep 1\n"
          )
        })).pipe(Effect.ensuring(Effect.ignore(MicrosandboxSandbox.removeSnapshot(Microsandbox, name))))
      }),
    budget
  )
})
