import { githubApi } from "./github-api.mjs"
import { cli, createStepLog, isMain } from "./lib.mjs"

export const CANARY_OWNER = "smithers-mvp-canary"
export const CANARY_TEMPLATE = `${CANARY_OWNER}/template`

export function canaryName(date = new Date()) {
  const value = new Date(date)
  if (!Number.isFinite(value.getTime())) throw new Error("Invalid canary date")
  return value.toISOString().slice(0, 10)
}

export function assertCanaryRepository(repository) {
  if (typeof repository !== "string") throw new Error("Missing canary repository")
  const [owner, name, extra] = repository.split("/")
  if (owner !== CANARY_OWNER) throw new Error(`Canary owner must be ${CANARY_OWNER}`)
  if (extra !== undefined || !/^\d{4}-\d{2}-\d{2}(?:-[a-z0-9-]+)?$/.test(name ?? "") || canaryName(name.slice(0, 10)) !== name.slice(0, 10)) {
    throw new Error("Canary repository must have a valid UTC date name")
  }
  return { owner, name }
}

function verifyRepository(value, repository) {
  if (value?.full_name !== repository || value?.owner?.login !== CANARY_OWNER || value?.template_repository?.full_name !== CANARY_TEMPLATE || value?.default_branch !== "main" || value?.allow_squash_merge !== true) {
    throw new Error("Canary repository identity, template provenance, main branch or squash setting does not match")
  }
  return value
}

export async function ensureCanaryRepository({ repository = `${CANARY_OWNER}/${canaryName()}`, token = process.env.JOURNEY_OWNER_TOKEN, fetchImpl = fetch, log = async () => {} } = {}) {
  const { owner, name } = assertCanaryRepository(repository)
  const api = githubApi({ token, fetchImpl, log })
  try { return verifyRepository(await api("GET", `/repos/${repository}`), repository) } catch (error) {
    if (error.status !== 404) throw error
  }
  try {
    await api("POST", `/repos/${CANARY_TEMPLATE}/generate`, { owner, name, private: true, include_all_branches: false })
  } catch (error) {
    // A concurrent invocation can win the create race. Re-read and verify;
    // never accept a pre-existing unrelated repository as our canary.
    if (error.status !== 422) throw error
  }
  return verifyRepository(await api("GET", `/repos/${repository}`), repository)
}

if (isMain(import.meta.url)) await cli(async () => {
  const repository = process.argv[2] ?? `${CANARY_OWNER}/${canaryName()}`
  const log = await createStepLog(new URL(`../../.artifacts/checks/C-J1-01/${new Date().toISOString()}/`, import.meta.url).pathname)
  const result = await ensureCanaryRepository({ repository, log })
  process.stdout.write(`${result.full_name}\n`)
})
