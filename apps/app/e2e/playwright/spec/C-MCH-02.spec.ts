import { expect, test } from "../browserTest"
import { runLiveInstall } from "./live-install"

// Linux conformance: real install HTTP and PostgreSQL, runtime observations are
// fixtures. Native microVM timing and root qualification still require the mini.
test("C-MCH-02: install demand retains working machines and failed captures", async () => {
  test.setTimeout(300_000)
  const output = await runLiveInstall("^(TestFrTMCH06BranchWaitPositionProductionHTTPPostgres|TestBranchSleepAuthenticatedCaptureInstallHTTP|TestBranchSleepCaptureFailureKeepsRunning|TestAdmissionIdleCaptureInstallHTTP)$")
  for (const name of ["TestFrTMCH06BranchWaitPositionProductionHTTPPostgres", "TestBranchSleepAuthenticatedCaptureInstallHTTP", "TestBranchSleepCaptureFailureKeepsRunning", "TestAdmissionIdleCaptureInstallHTTP"]) expect(output).toContain(`--- PASS: ${name}`)
})
