/**
 * Exclusive ownership of one Alchemy state directory.
 *
 * Alchemy writes deployment state while it runs, and redaction replaces the
 * files it wrote afterwards. Identity checks alone cannot fence the two: a
 * state file can be replaced between redaction's last check and the rename
 * that publishes its snapshot, and the newer state is lost. Every writer of
 * this state therefore takes ownership first. The deploy wrapper holds it from
 * before Alchemy starts until redaction has published its last file, and a
 * standalone redaction holds it across its own read, replacement, and
 * directory sync.
 *
 * Ownership holds an exclusive SQLite transaction for the entire operation.
 * Its stable database file must never be unlinked: the OS releases the lock
 * when a process exits. A PID file preserves diagnostics and fences older
 * deployment wrappers; stale PID reclamation runs under the SQLite lock.
 * Alchemy reads only `.json` entries there, so
 * the file is invisible to it. A lock whose owner is gone is reclaimed; one
 * whose owner is alive, or cannot be read, refuses the caller.
 *
 * @since 0.1.0
 */

import { errorCode } from "@smthrs/targets/SafeFs"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import { DatabaseSync } from "node:sqlite"

/**
 * Ownership of one Alchemy state directory, released once by its taker.
 *
 * @category models
 * @since 0.1.0
 */
export interface StateOwnership {
  /** The state directory the lock file lives in. */
  readonly directory: string
  /** Releases this ownership once; repeated calls share its completion. */
  readonly release: () => Promise<void>
}

const lockName = ".smithers-state-owner.lock"
const reclaimAttempts = 2

const holderOf = (contents: string): number | undefined => {
  const trimmed = contents.trim()
  return /^[1-9]\d*$/.test(trimmed) ? Number(trimmed) : undefined
}

const holderAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // Only ESRCH establishes that the owner is gone. A refused probe is a
    // live process the caller must not race.
    return errorCode(error) !== "ESRCH"
  }
}

/**
 * Takes exclusive state ownership using an OS-released SQLite process lock.
 *
 * @category constructors
 * @since 0.1.0
 */
export const acquireStateOwnership = async (directory: string): Promise<StateOwnership> => {
  await Fs.stat(directory)
  const database = new DatabaseSync(NodePath.join(directory, ".smithers-state-owner.sqlite"))
  try {
    database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE")
  } catch (cause) {
    database.close()
    const file = NodePath.join(directory, lockName)
    const holder = holderOf(await Fs.readFile(file, "utf8").catch(() => ""))
    throw new Error(
      `Alchemy state is owned by another deployment${holder === undefined ? "" : ` (pid ${holder})`}; ` +
        `remove ${file} only once that process is gone`,
      { cause }
    )
  }
  try {
    const ownership = await acquirePidFile(directory)
    let releasing: Promise<void> | undefined
    return {
      directory,
      release: () => releasing ??= ownership.release().finally(() => database.close())
    }
  } catch (cause) {
    database.close()
    throw cause
  }
}

/**
 * Takes exclusive ownership of an existing Alchemy state directory.
 *
 * A lock left by a process that no longer exists is reclaimed; one held by a
 * live process refuses with that process id.
 *
 * @category constructors
 * @since 0.1.0
 */
const acquirePidFile = async (directory: string): Promise<StateOwnership> => {
  const file = NodePath.join(directory, lockName)
  for (let attempt = 0; attempt < reclaimAttempts; attempt += 1) {
    try {
      await Fs.writeFile(file, `${process.pid}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 })
      return { directory, release: () => Fs.rm(file, { force: true }) }
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error
    }
    let contents: string
    try {
      contents = await Fs.readFile(file, "utf8")
    } catch (error) {
      // The owner released between the collision and the read.
      if (errorCode(error) === "ENOENT") continue
      throw error
    }
    const holder = holderOf(contents)
    if (holder !== undefined && !holderAlive(holder)) {
      await Fs.rm(file, { force: true })
      continue
    }
    throw new Error(
      `Alchemy state is owned by another deployment${holder === undefined ? "" : ` (pid ${holder})`}; ` +
        `remove ${file} only once that process is gone`
    )
  }
  throw new Error(`Alchemy state ownership was taken by another deployment while a stale lock was reclaimed: ${file}`)
}
