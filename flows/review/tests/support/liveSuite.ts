import { spawnSync } from "node:child_process";
import { ghBin } from "../../src/github/runGh.ts";

/**
 * Decide whether a live suite runs, and say what it did not prove when it
 * does not.
 *
 * A suite that reaches a real backend has to skip when its credential is
 * absent, and a silent skip reads exactly like a pass in the runner's
 * summary. Every live suite in this app goes through here so the skip
 * always names its tag and the reason, on one line.
 *
 * @param args.tag Short suite name, printed in brackets.
 * @param args.enabled Whether the credential this suite needs is present.
 * @param args.reason What is missing, phrased so a reader can fix it.
 * @param args.log Sink for the line; defaults to `console.log`.
 * @returns `args.enabled`, for `describe.skipIf(!gate)`.
 */
export function liveSuiteGate(args: {
  tag: string;
  enabled: boolean;
  reason: string;
  log?: (line: string) => void;
}): boolean {
  if (!args.enabled) (args.log ?? console.log)(`[${args.tag}] skipped: ${args.reason}`);
  return args.enabled;
}

/** What to tell a reader whose environment cannot reach GitHub. */
export const GH_CREDENTIAL_REASON =
  "set SMITHERS_REVIEW_E2E=1 to opt in; live GitHub credentials required: install the gh CLI and set GITHUB_TOKEN (or run `gh auth login`)";

/**
 * Whether live tests are explicitly enabled and gh carries a credential.
 *
 * A token in the environment counts without a round trip; otherwise `gh auth
 * status` decides, which covers a keyring login.
 */
export function ghCredentialsAvailable(): boolean {
  if (process.env.SMITHERS_REVIEW_E2E !== "1") return false;
  const bin = ghBin();
  const which = spawnSync(process.platform === "win32" ? "where" : "which", [bin], { encoding: "utf8" });
  if (which.status !== 0) return false;
  if (process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim()) return true;
  return spawnSync(bin, ["auth", "status"], { encoding: "utf8" }).status === 0;
}
