import { publicOrigin } from './host.mjs'

// Literal inherited root inventory. Neither an environment flag nor a host
// profile proves execution of these paths on the installed bundle.
export const qualificationChecks = {
  TestGuestHelperInstallPinsInterpreterAndEnv: ['fresh', 'retained'],
  TestRootSetupNeverFollowsMemberSymlinks: ['fresh', 'retained'],
  TestRootPreflightParsesOnlyEnvelope: ['exec', 'file', 'terminal', 'relay'],
  TestRootLayerInputsValidatedBeforeUse: ['layer'],
  TestSSHRootInputsValidatedBeforeUse: ['ssh', 'retained'],
  TestTerminalRootInputsValidatedBeforeUse: ['terminal'],
  TestBranchMachineRootInputsValidated: ['fresh', 'retained'],
  TestMemberImageRootInputs: ['member-image'],
  TestLiveDocumentBrokerInputs: ['document', 'retained']
}

export function validateMachineQualification(value, { origin, commit, installVersion }) {
  const unavailable = 'authenticated lifecycle qualification unavailable: T-INS-02, T-MCH-11, T-SEC-01, T-MCH-10'
  if (value?.version !== 1 || value.status !== 'qualified') throw new Error(unavailable)
  const digest = /^[a-f0-9]{64}$/
  if (!/^[a-f0-9]{40}$/.test(commit ?? '') || !installVersion || value.commit !== commit || value.install_version !== installVersion ||
      value.origin !== publicOrigin(origin) || value.runtime !== 'microvm' || value.non_root !== true ||
      !digest.test(value.bundle_digest ?? '') || !digest.test(value.inventory_digest ?? '') || value.reviewed_by !== 'smithers-3f') throw new Error('lifecycle qualification identity or root review mismatched')
  if (!Array.isArray(value.receipts) || value.receipts.length !== Object.keys(qualificationChecks).length) throw new Error('lifecycle qualification receipts missing or duplicated')
  for (const [name, paths] of Object.entries(qualificationChecks)) {
    const receipts = value.receipts.filter(r => r?.name === name)
    if (receipts.length !== 1) throw new Error(`lifecycle qualification missing ${name}`)
    const receipt = receipts[0]
    if (receipt.status !== 'passed' || receipt.commit !== commit || receipt.bundle_digest !== value.bundle_digest ||
        receipt.inventory_digest !== value.inventory_digest || receipt.provenance !== 'authenticated-reference-host' ||
        !digest.test(receipt.receipt_digest ?? '') || !Array.isArray(receipt.paths) || paths.some(path => !receipt.paths.includes(path))) throw new Error(`lifecycle qualification invalid ${name}`)
  }
  return value
}

/** Read the owner-session install contract before any browser/SSH/mutation.
 * No caller-supplied receipt or qualification flag is an activation authority.
 */
export async function requireMachineQualification(env = process.env, request = fetch) {
  if (process.platform !== 'darwin') throw new Error('reference-network Mac required')
  if (!env.SMITHERS_PERF_ORIGIN || !env.SMITHERS_PERF_OWNER_COOKIE) throw new Error('authenticated lifecycle qualification unavailable: owner session and public origin required')
  const origin = publicOrigin(env.SMITHERS_PERF_ORIGIN)
  const response = await request(`${origin}/api/install/metrics`, {
    headers: { Cookie: env.SMITHERS_PERF_OWNER_COOKIE }, redirect: 'error', signal: AbortSignal.timeout(10000)
  })
  if (response.status !== 200) throw new Error(`authenticated lifecycle qualification unavailable: GET /api/install/metrics returned ${response.status}`)
  return validateMachineQualification((await response.json()).machine_qualification, {
    origin, commit: env.SMITHERS_PERF_COMMIT, installVersion: env.SMITHERS_PERF_INSTALL_VERSION
  })
}
