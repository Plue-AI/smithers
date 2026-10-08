import { expect, test } from "../browserTest"
import { runLiveInstall } from "./live-install"

// The owned harness serves the production composition and real app, with
// PostgreSQL, authenticated secret flows and Live. Native broker evidence is
// separate; this UI check never substitutes a seeded card or API response.
test("C-MCH-12: declared file metadata survives reload through the composed install", async () => {
  test.setTimeout(300_000)
  const stdout = await runLiveInstall("^TestLiveSecretsBrowserPostgres$")
  expect(stdout).toContain("PASS C-MCH-12: path persisted, value write-only, replacement and deletion committed")
  expect(stdout).toContain("--- PASS: TestLiveSecretsBrowserPostgres")
})
