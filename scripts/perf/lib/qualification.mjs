/** Shared activation precondition for every machine workload entry point.
 * The install has no authenticated lifecycle/root qualification contract yet.
 * A Mac profile, storage state or environment flag cannot substitute for it.
 * Keep this refusal before browser, SSH, terminal or scratch mutations.
 */
export function requireMachineQualification() {
  if (process.platform !== 'darwin') throw new Error('reference-network Mac required')
  throw new Error('authenticated lifecycle qualification unavailable: T-INS-02, T-MCH-11, T-SEC-01, T-MCH-10')
}
