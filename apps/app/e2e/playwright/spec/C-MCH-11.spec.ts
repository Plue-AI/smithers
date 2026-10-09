import { expect, test } from "../browserTest"
import { runLiveInstall } from "./live-install"

test("C-MCH-11: missing machine authorities refuse terminal grants through install HTTP", { tag: "@install" }, async () => {
  test.setTimeout(300_000)
  const output = await runLiveInstall("^TestTerminalAdmissionMissingProvidersInstallBoundary$")
  expect(output).toContain("--- PASS: TestTerminalAdmissionMissingProvidersInstallBoundary")
  for (const provider of ["disk", "owner", "profile", "binding", "microvm", "identity", "membership", "authorization"]) {
    expect(output).toContain(`--- PASS: TestTerminalAdmissionMissingProvidersInstallBoundary/missing_${provider}`)
  }
})

// Chromium mounts production views against the authenticated install router.
// Runtime boot/stop observations are injected; no live frames are intercepted.
test("C-MCH-11: concurrent terminals share the real branch queue and grant cursor", { tag: "@install" }, async () => {
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


test("C-MCH-11: released TODO controls and Learning use production machine admission", { tag: "@install" }, async () => {
  test.setTimeout(300_000)
  const output = await runLiveInstall("^Test(ReleasedTodoResumeAdmissionComposedInstall|ReleasedTodoSteerAnswerAdmissionComposedInstall|LearningMergeDispatchComposedInstall)$")
  expect(output).toContain("--- PASS: TestReleasedTodoResumeAdmissionComposedInstall")
  expect(output).toContain("--- PASS: TestReleasedTodoSteerAnswerAdmissionComposedInstall")
  expect(output).toContain("--- PASS: TestLearningMergeDispatchComposedInstall")
})


test("C-MCH-11: grant publication rollback fences a second free slot", { tag: "@install" }, async () => {
  test.setTimeout(300_000)
  const output = await runLiveInstall("^TestSuccessfulTerminalPublicationBarrierInstallBoundary$")
  expect(output).toContain("--- PASS: TestSuccessfulTerminalPublicationBarrierInstallBoundary")
})


test("C-MCH-11: successful terminals obey changing disk and owner capacity", { tag: "@install" }, async () => {
  test.setTimeout(300_000)
  const output = await runLiveInstall("^TestSuccessfulTerminal(DiskRecheck|OwnerCapacity)InstallBoundary$")
  expect(output).toContain("--- PASS: TestSuccessfulTerminalDiskRecheckInstallBoundary")
  expect(output).toContain("--- PASS: TestSuccessfulTerminalOwnerCapacityInstallBoundary")
})


test("C-MCH-11: cancelled boot and forced stop retain capacity until observation", { tag: "@install" }, async () => {
  test.setTimeout(300_000)
  const output = await runLiveInstall("^TestTerminal(CancelledBootConfirmedStop|ForceStopConfirmedObservation)InstallBoundary$")
  expect(output).toContain("--- PASS: TestTerminalCancelledBootConfirmedStopInstallBoundary")
  expect(output).toContain("--- PASS: TestTerminalForceStopConfirmedObservationInstallBoundary")
})


test("C-MCH-11: restart settles lost terminal requests and confirmed orphan stop", { tag: "@install" }, async () => {
  test.setTimeout(300_000)
  const output = await runLiveInstall("^TestTerminalRestartOrphanInstallBoundary$")
  expect(output).toContain("--- PASS: TestTerminalRestartOrphanInstallBoundary")
})


test("C-MCH-11: successful scratch wakes replay from a disconnected cursor through a fresh hub", { tag: "@install" }, async () => {
  test.setTimeout(300_000)
  const output = await runLiveInstall("^TestSuccessfulScratchReplayInstallBoundary$")
  expect(output).toContain("--- PASS: TestSuccessfulScratchReplayInstallBoundary")
})


test("C-MCH-11: a successful person terminal holds background review until confirmed stop", { tag: "@install" }, async () => {
  test.setTimeout(300_000)
  const output = await runLiveInstall("^TestSuccessfulTerminalBeforeReviewInstallBoundary$")
  expect(output).toContain("--- PASS: TestSuccessfulTerminalBeforeReviewInstallBoundary")
})


test("C-MCH-11: cold preparation and TODO promotion keep one successful slot", { tag: "@install" }, async () => {
  test.setTimeout(300_000)
  const output = await runLiveInstall("^Test(ColdTerminalPrepareHandoff|TodoPersonPromotion|TodoPersonConcurrentPromotion)InstallBoundary$")
  expect(output).toContain("--- PASS: TestColdTerminalPrepareHandoffInstallBoundary")
  expect(output).toContain("--- PASS: TestTodoPersonPromotionInstallBoundary")
  expect(output).toContain("--- PASS: TestTodoPersonConcurrentPromotionInstallBoundary")
  expect(output).toContain("PASS C-MCH-11 production Branch/Home live mount, grant cursor and reload")
})

// A compiled host is killed; the independent VM transport preserves inventory.
// This is a Linux process fault, not physical microVM/root qualification.
test("C-MCH-11: host death retains boot capacity until confirmed orphan stop", { tag: "@install" }, async () => {
  test.setTimeout(300_000)
  const output = await runLiveInstall("^TestAdmissionKilledHostInstallBoundary$")
  expect(output).toContain("--- PASS: TestAdmissionKilledHostInstallBoundary")
  expect(output).toContain("PASS C-MCH-11 compiled host SIGKILL, retained boot inventory, confirmed-stop recovery and idempotent HTTP replay")
})
