import { existsSync } from "node:fs"
import { join } from "node:path"

// Repository generators and gates must not inherit database or publication credentials.
export function engineeringGateEnvironment(environment) {
  const gateEnvironment = { ...environment }
  for (const key of Object.keys(gateEnvironment)) {
    if (/TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY/.test(key) ||
        ["DATABASE_URL", "SMITHERS_TEST_DATABASE_URL", "PGPASSWORD", "PGPASSFILE", "PGSERVICE", "PGSERVICEFILE", "SMITHERS_GITHUB_PROXY", "BASH_ENV", "ENV", "NODE_OPTIONS", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES"].includes(key) ||
        key.startsWith("BASH_FUNC_") || key.startsWith("GIT_CONFIG_")) delete gateEnvironment[key]
  }
  return gateEnvironment
}

export function requireEngineeringGateHome(environment) {
  if (!environment.HOME || existsSync(join(environment.HOME, ".config/issue-claim"))) {
    throw new Error("Engineering gates require an isolated home without ~/.config/issue-claim.")
  }
}
