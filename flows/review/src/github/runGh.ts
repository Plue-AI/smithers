import { runCommand } from "../git/runCommand.ts"

/**
 * The gh executable this process spawns.
 *
 * `SMITHERS_GH_BIN` overrides it, for non-standard installs and for hermetic
 * tests that inject a fake gh by absolute path. Every caller resolves the
 * binary here, so a preflight check and the call it guards can never disagree
 * about which gh they mean.
 */
export function ghBin(): string {
  return process.env.SMITHERS_GH_BIN || "gh"
}

/**
 * Run the gh CLI in a repo directory; resolves stdout, throws with stderr.
 */
export async function runGh(repoDir: string, args: Array<string>, stdin?: string): Promise<string> {
  const result = await runCommand(ghBin(), args, repoDir, 120_000, stdin)
  if (result.exitCode !== 0) {
    throw new Error(
      `gh ${args.slice(0, 2).join(" ")} failed: ${result.stderr || `exited with code ${result.exitCode}`}`
    )
  }
  return result.stdout
}

/**
 * Run gh with a per-item `... | @json` --jq program and parse each stdout
 * line as one JSON record. One compact object per line survives gh's
 * per-page --jq application under --paginate where raw concatenated page
 * arrays would not parse. gh prints jq string results raw, but
 * double-encoded output (a JSON string containing JSON) has been observed
 * across jq builds, so string results are unwrapped once; blank and
 * unparseable lines are skipped.
 */
export async function runGhJsonLines(
  repoDir: string,
  args: Array<string>,
  gh: typeof runGh = runGh
): Promise<Array<object>> {
  const raw = await gh(repoDir, args)
  const records: Array<object> = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
      if (typeof parsed === "string") parsed = JSON.parse(parsed)
    } catch {
      continue
    }
    if (parsed && typeof parsed === "object") records.push(parsed)
  }
  return records
}
