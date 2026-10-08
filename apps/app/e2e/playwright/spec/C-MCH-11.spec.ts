import { expect, test } from "../browserTest"
import { runLiveInstall } from "./live-install"

// Chromium mounts production views against the authenticated install router.
// Runtime boot/stop observations are injected; no live frames are intercepted.
test("C-MCH-11: concurrent terminals share the real branch queue and grant cursor", async () => {
  test.setTimeout(300_000)
  const output = await runLiveInstall("^Test(ParallelAdmissionInstallBoundary|TenBranchTerminalAdmissionInstallBoundary|SuccessfulTerminalAdmissionComposedInstall|SuccessfulTerminalFIFOInstallBoundary|SuccessfulFiftyTerminalInstallBoundary|PerfWarmWakeObservationComposedInstall|InstallReviewHTTPAdmissionWithoutRuntime|TodoStopResumeComposedInstall|TodoHeldReviewStopResumeComposedInstall|TodoOrderedRecovery)$")
  expect(output).toContain("--- PASS: TestTenBranchTerminalAdmissionInstallBoundary")
  expect(output).toContain("--- PASS: TestSuccessfulTerminalAdmissionComposedInstall")
  expect(output).toContain("--- PASS: TestSuccessfulTerminalFIFOInstallBoundary")
  expect(output).toContain("--- PASS: TestSuccessfulFiftyTerminalInstallBoundary")
  expect(output).toContain("--- PASS: TestPerfWarmWakeObservationComposedInstall")
  expect(output).toContain("--- PASS: TestInstallReviewHTTPAdmissionWithoutRuntime")
  expect(output).toContain("--- PASS: TestTodoStopResumeComposedInstall")
  expect(output).toContain("--- PASS: TestTodoHeldReviewStopResumeComposedInstall")
  expect(output).toContain("--- PASS: TestTodoOrderedRecovery")
  expect(output).toContain("PASS C-MCH-11 production Branch/Home live mount, grant cursor and reload")
})


test("C-MCH-11: released TODO controls and Learning use production machine admission", async () => {
  test.setTimeout(300_000)
  const output = await runLiveInstall("^Test(ReleasedTodoResumeAdmissionComposedInstall|ReleasedTodoSteerAnswerAdmissionComposedInstall|LearningMergeDispatchComposedInstall)$")
  expect(output).toContain("--- PASS: TestReleasedTodoResumeAdmissionComposedInstall")
  expect(output).toContain("--- PASS: TestReleasedTodoSteerAnswerAdmissionComposedInstall")
  expect(output).toContain("--- PASS: TestLearningMergeDispatchComposedInstall")
})


test("C-MCH-11: grant publication rollback fences a second free slot", async () => {
  test.setTimeout(300_000)
  const output = await runLiveInstall("^TestSuccessfulTerminalPublicationBarrierInstallBoundary$")
  expect(output).toContain("--- PASS: TestSuccessfulTerminalPublicationBarrierInstallBoundary")
})


test("C-MCH-11: successful terminals obey changing disk and owner capacity", async () => {
  test.setTimeout(300_000)
  const output = await runLiveInstall("^TestSuccessfulTerminal(DiskRecheck|OwnerCapacity)InstallBoundary$")
  expect(output).toContain("--- PASS: TestSuccessfulTerminalDiskRecheckInstallBoundary")
  expect(output).toContain("--- PASS: TestSuccessfulTerminalOwnerCapacityInstallBoundary")
})


test("C-MCH-11: cancelled boot and forced stop retain capacity until observation", async () => {
  test.setTimeout(300_000)
  const output = await runLiveInstall("^TestTerminal(CancelledBootConfirmedStop|ForceStopConfirmedObservation)InstallBoundary$")
  expect(output).toContain("--- PASS: TestTerminalCancelledBootConfirmedStopInstallBoundary")
  expect(output).toContain("--- PASS: TestTerminalForceStopConfirmedObservationInstallBoundary")
})
