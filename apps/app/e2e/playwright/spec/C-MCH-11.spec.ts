import { expect, test } from "../browserTest"
import { runLiveInstall } from "./live-install"

// Chromium mounts production views against the authenticated install router.
// Runtime boot/stop observations are injected; no live frames are intercepted.
test("C-MCH-11: concurrent terminals share the real branch queue and grant cursor", async () => {
  test.setTimeout(300_000)
  const output = await runLiveInstall("^Test(ParallelAdmissionInstallBoundary|TenBranchTerminalAdmissionInstallBoundary|PerfWarmWakeObservationComposedInstall|InstallReviewHTTPAdmissionWithoutRuntime|TodoStopResumeComposedInstall|TodoHeldReviewStopResumeComposedInstall)$")
  expect(output).toContain("--- PASS: TestTenBranchTerminalAdmissionInstallBoundary")
  expect(output).toContain("--- PASS: TestPerfWarmWakeObservationComposedInstall")
  expect(output).toContain("--- PASS: TestInstallReviewHTTPAdmissionWithoutRuntime")
  expect(output).toContain("--- PASS: TestTodoStopResumeComposedInstall")
  expect(output).toContain("--- PASS: TestTodoHeldReviewStopResumeComposedInstall")
  expect(output).toContain("PASS C-MCH-11 production Branch/Home live mount, grant cursor and reload")
})
