/** Install snapshot transport terminates in the unprivileged coding process. */
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

export const consumeInstallProject = (
  environment: NodeJS.ProcessEnv,
  uid = process.getuid?.() ?? -1
): string | undefined => {
  // Check identity before reading even a hostile payload accessor.
  if (uid === 0) throw new Error("Install coding configuration requires an unprivileged guest")
  const snapshot = environment.SMITHERS_CODING_PROJECT_JSON
  if (snapshot === undefined) return undefined
  delete environment.SMITHERS_CODING_PROJECT_JSON
  if (Buffer.byteLength(snapshot) > 256 * 1024) throw new Error("Install coding configuration exceeds 256 KiB")
  const filename = resolve(mkdtempSync(resolve(tmpdir(), "smithers-project-")), "project.json")
  writeFileSync(filename, snapshot, { mode: 0o600, flag: "wx" })
  environment.SMITHERS_CODING_PROJECT = filename
  return filename
}
