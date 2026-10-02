/** Reference-counted local machines. Each lease owns a separate checkout and process cgroup. */
import type { RemoteChildProcessSpawner, Sandbox } from "@smthrs/sandbox"
import { Deferred, Effect, Exit, Scope, Semaphore } from "effect"
import { randomUUID } from "node:crypto"
import { posix } from "node:path"

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
type Error = RemoteChildProcessSpawner.ProviderError
interface Machine {
  readonly scope: Scope.Closeable
  readonly ready: Deferred.Deferred<Sandbox.Session, Error>
  references: number
}

export interface PoolOptions {
  readonly agentsPerVm: number
  readonly memoryPerAgentMib: number
  readonly acquire: Sandbox.Provider["acquire"]
  readonly prepare: (session: Sandbox.Session, what: string, script: string) => Effect.Effect<unknown, Error>
  readonly checkout: string
}

/** Separate repositories prevent a jj abandon/rebase in one working copy moving a neighbor's changes. */
export const prepareWorkspace = (checkout: string, root: string, cgroup: string, memoryMib: number) =>
  `set -eu
# Fail closed when the image cannot enforce a per-agent OOM boundary.
test -f /sys/fs/cgroup/cgroup.controllers
grep -qw memory /sys/fs/cgroup/cgroup.controllers
echo +memory > /sys/fs/cgroup/cgroup.subtree_control
mkdir -p ${quote(cgroup)}
echo ${memoryMib * 1024 * 1024} > ${quote(cgroup + "/memory.max")}
echo 1 > ${quote(cgroup + "/memory.oom.group")}
# Install and its children share the same per-agent OOM boundary as later commands.
echo $$ > ${quote(cgroup + "/cgroup.procs")}
mkdir -p ${quote(root)}
chmod 700 ${quote(root)}
base=$(jj --ignore-working-copy -R ${quote(checkout)} log -r @- --no-graph -T commit_id)
# Alternates share immutable git objects; each workspace owns its index, refs and jj metadata.
git clone --shared --no-checkout --quiet ${quote(checkout)} ${quote(root + "/workspace")}
cd ${quote(root + "/workspace")}
git checkout --detach --quiet "$base"
jj git init --colocate
mkdir -p ${quote(root + "/.config/jj")}
cp ${quote("/home/developer/.config/jj/config.toml")} ${quote(root + "/.config/jj/config.toml")}
# pnpm links each workspace independently. Reflink when possible, copy otherwise;
# writable package files must never be hardlinked to a neighbor's dependencies.
store=$(cd ${quote(checkout)} && pnpm store path)
CI=1 pnpm install --frozen-lockfile --prefer-offline --reporter=silent --store-dir "$store" --package-import-method=clone-or-copy
`

export const pooled = (options: PoolOptions): Sandbox.Provider => {
  const lock = Semaphore.makeUnsafe(1)
  const machines = new Set<Machine>()
  const release = (machine: Machine) =>
    Effect.gen(function*() {
      const last = yield* lock.withPermit(Effect.sync(() => {
        if (--machine.references !== 0) return false
        machines.delete(machine)
        return true
      }))
      if (last) yield* Scope.close(machine.scope, Exit.void)
    })
  return {
    acquire: (id) =>
      Effect.gen(function*() {
        // The outer provider bounds total leases, so either an existing machine
        // has room or there is a free VM slot. Reservation and final release are atomic.
        let first = false
        const machine = yield* Effect.acquireRelease(
          lock.withPermit(Effect.gen(function*() {
            const existing = [...machines].find((machine) => machine.references < options.agentsPerVm)
            if (existing) {
              existing.references++
              return existing
            }
            const created: Machine = {
              scope: yield* Scope.make(),
              ready: yield* Deferred.make<Sandbox.Session, Error>(),
              references: 1
            }
            first = true
            machines.add(created)
            return created
          })),
          release
        )
        if (first) {
          // Always publish acquisition failure (including interruption), otherwise
          // neighbors waiting for the same boot would wait forever.
          yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function*() {
              const result = yield* Effect.exit(restore(
                Effect.provideService(options.acquire(`pool-${randomUUID()}`), Scope.Scope, machine.scope)
              ))
              yield* Deferred.done(machine.ready, result)
              return yield* result
            })
          )
        }
        const parent = yield* Deferred.await(machine.ready)
        const token = randomUUID()
        const root = `/home/developer/sessions/${token}`
        const workdir = `${root}/workspace`
        const cgroup = `/sys/fs/cgroup/smithers-${token}`
        // This finalizer is installed before setup so partial install/cancellation
        // removes only this lease. It runs before the last-reference VM teardown.
        yield* Effect.addFinalizer(() =>
          options.prepare(
            parent,
            "releasing workspace",
            `set -eu
if [ -d ${quote(cgroup)} ]; then
  echo 1 > ${quote(cgroup + "/cgroup.kill")}
  # cgroup.kill signals asynchronously; wait for the kernel to remove members.
  attempts=0
  until rmdir ${quote(cgroup)}; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 50 ] || exit 1
    sleep 0.1
  done
fi
rm -rf ${quote(root)}
`
          ).pipe(Effect.orDie)
        )
        yield* options.prepare(
          parent,
          "preparing workspace",
          prepareWorkspace(options.checkout, root, cgroup, options.memoryPerAgentMib)
        )
        const session: Sandbox.Session = {
          id,
          remoteId: parent.remoteId,
          workdir,
          readFile: parent.readFile,
          writeFile: parent.writeFile,
          kill: parent.kill,
          ping: parent.ping,
          // Do not retain parent's filesystem overrides: their command cwd is
          // rooted at the template. Sandbox derives these from this session.
          spawn: (command, spawnOptions) =>
            parent.spawn(
              `echo $$ > ${quote(cgroup + "/cgroup.procs")} || exit 125\n${command}`,
              {
                ...spawnOptions,
                cwd: posix.resolve(workdir, spawnOptions.cwd ?? "."),
                env: {
                  HOME: root,
                  XDG_CONFIG_HOME: `${root}/.config`,
                  XDG_CACHE_HOME: `${root}/.cache`,
                  ...spawnOptions.env
                }
              }
            )
        }
        return session
      })
  }
}
