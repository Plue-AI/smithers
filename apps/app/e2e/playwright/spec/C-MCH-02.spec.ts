import { expect, test } from "../browserTest"
import { runLiveInstall } from "./live-install"

// Linux conformance: real install HTTP and PostgreSQL, runtime observations are
// fixtures. Native microVM timing and root qualification still require the mini.
test("C-MCH-02: install demand retains working machines and failed captures", async () => {
  test.setTimeout(300_000)
  const output = await runLiveInstall("^(TestFrTMCH06BranchWaitPositionProductionHTTPPostgres|TestBranchSleepAuthenticatedCaptureInstallHTTP|TestBranchSleepCaptureFailureKeepsRunning|TestAdmissionIdleCaptureInstallHTTP)$")
  for (const name of ["TestFrTMCH06BranchWaitPositionProductionHTTPPostgres", "TestBranchSleepAuthenticatedCaptureInstallHTTP", "TestBranchSleepCaptureFailureKeepsRunning", "TestAdmissionIdleCaptureInstallHTTP"]) expect(output).toContain(`--- PASS: ${name}`)
})

// Observe the production event/tick loop, retained checkout validation and live
// branch card. Guest observations and elapsed time are Linux conformance ports.
test("C-MCH-02: a working TODO survives two hours before confirmed safe-idle release", async () => {
  test.setTimeout(300_000)
  const output = await runLiveInstall("^TestParallelAdmissionInstallBoundary$")
  expect(output).toContain("--- PASS: TestParallelAdmissionInstallBoundary")
  expect(output).toContain("PASS C-MCH-02 two-hour working retention, final capture and confirmed safe-idle stop")
  expect(output).toContain("PASS C-MCH-11 production Branch/Home live mount, grant cursor and reload")
})
