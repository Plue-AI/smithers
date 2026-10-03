import { ReviewCommentSeverity } from "./reviewCommentSeveritySchema.ts"
import type { FindingVerdict } from "./verifyVerdictsSchema.ts"

const severitySteps = ReviewCommentSeverity.literals

export function applyFindingVerdicts<T extends { path: string; severity: ReviewCommentSeverity }>(
  findings: Array<T>,
  verdicts: ReadonlyArray<FindingVerdict>
): { findings: Array<T>; dropped: number; warnings: Array<{ file: string; message: string; type: string }> } {
  const droppedIndexes = new Set<number>()
  const demoted = new Map<number, T>()
  const warnings: Array<{ file: string; message: string; type: string }> = []

  for (const verdict of verdicts) {
    if (!Number.isInteger(verdict.index) || verdict.index < 0 || verdict.index >= findings.length) {
      warnings.push({
        file: "",
        type: "verifier_unknown_index",
        message: `Verifier returned a verdict for unknown finding index ${verdict.index}; ignored.`
      })
      continue
    }
    const finding = demoted.get(verdict.index) ?? findings[verdict.index]!
    if (verdict.verdict === "drop") {
      droppedIndexes.add(verdict.index)
      warnings.push({
        file: finding.path,
        type: "verifier_dropped",
        message: verdict.reason || "Finding refuted by the verification pass."
      })
    } else if (verdict.verdict === "demote") {
      const currentStep = severitySteps.indexOf(finding.severity)
      const requestedStep = verdict.severity ? severitySteps.indexOf(verdict.severity) : currentStep + 1
      // Demote never raises severity and floors at the lowest step.
      const nextStep = Math.min(Math.max(currentStep, requestedStep), severitySteps.length - 1)
      demoted.set(verdict.index, { ...finding, severity: severitySteps[nextStep]! })
      warnings.push({
        file: finding.path,
        type: "verifier_demoted",
        message: verdict.reason || `Finding demoted to ${severitySteps[nextStep]} by the verification pass.`
      })
    }
  }

  const kept = findings
    .map((finding, index) => demoted.get(index) ?? finding)
    .filter((_, index) => !droppedIndexes.has(index))
  return { findings: kept, dropped: droppedIndexes.size, warnings }
}
