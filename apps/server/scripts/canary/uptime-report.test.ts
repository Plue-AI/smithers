/*
 * The two process shells, run for real.
 *
 * uptime-checks.test.ts covers every decision. This file covers the parts a
 * pure test cannot reach: argument parsing, the real `fetch`, the JSON report
 * on disk, the exit codes, and the GITHUB_OUTPUT lines the scheduled workflow
 * reads. The deployment is replaced by a local Bun.serve that answers the same
 * shapes canary.smithers.sh answers — including the signed-out 401 from the
 * turn seam and the NDJSON stream a signed-in turn produces — so the network
 * path is exercised without a credential and without spending model credit.
 */
import type { Server } from "bun"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ALERT_TITLE, type ProbeReport } from "./uptime-checks.ts"

const scriptsDir = import.meta.dir
const serverDir = join(scriptsDir, "..", "..")
const workDir = mkdtempSync(join(tmpdir(), "canary-uptime-"))

/** How the fake deployment behaves for the run in progress. */
let mode: "healthy" | "spa-down" | "turn-open" | "admin-session" = "healthy"

/*
 * The scoped-down account the metered half must be (RULINGS 35). The probe
 * reads its own session back before it spends anything, so the fake answers
 * /api/user the way the deployment does — and `admin-session` answers
 * as an admin, which is the cookie the probe must refuse.
 */
const SCOPED_LOGIN = "smithers-canary"

let server: Server<undefined>

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/") {
        return mode === "spa-down"
          ? new Response("upstream failure", { status: 503 })
          : new Response("<html>smithers</html>", { status: 200 })
      }
      if (url.pathname === "/api/bootstrap") return Response.json({ apiVersion: 1, host: "cloud", version: "1", buildSha: "a".repeat(40), capabilities: ["agent", "identity"], authFlow: "redirect", sandbox: null })
      if (url.pathname === "/api/user") {
        if (request.headers.get("cookie") === null) return new Response("{\"status\":\"signed-out\"}", { status: 200 })
        return Response.json({ username: SCOPED_LOGIN, is_admin: mode === "admin-session" })
      }
      if (url.pathname === "/api/agent/turn") {
        if (mode === "turn-open") return new Response("streaming to anyone", { status: 200 })
        if (request.headers.get("cookie") === null) return new Response("Unauthorized", { status: 401 })
        const body = await request.json() as { runId: string }
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `${JSON.stringify({ runId: body.runId, type: "delta", kind: "text", text: "ok" })}\n`
                )
              )
              controller.close()
            }
          }),
          { status: 200, headers: { "content-type": "application/x-ndjson" } }
        )
      }
      return new Response("Not found", { status: 404 })
    }
  })
})

afterAll(() => {
  server.stop(true)
})

const origin = (): string => `http://localhost:${String(server.port)}`

const runProbe = async (
  extraArgs: ReadonlyArray<string>,
  env: Record<string, string> = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const child = Bun.spawn(
    ["bun", join(scriptsDir, "uptime-probe.ts"), origin(), "--gap-ms", "1", ...extraArgs],
    {
      cwd: serverDir,
      stdout: "pipe",
      stderr: "pipe",
      // A cookie leaking in from the developer's shell would spend real
      // money from a unit test, so the environment is stated, not inherited.
      env: {
        ...process.env,
        CANARY_URL: "",
        CANARY_SESSION_COOKIE: "",
        CANARY_SESSION_LOGIN: SCOPED_LOGIN,
        SMITHERS_E2E_USER: "",
        CANARY_ALLOWLIST_LOGINS: "",
        ...env
      }
    }
  )
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ])
  const exitCode = await child.exited
  return { exitCode, stdout, stderr }
}

const runReport = async (
  extraArgs: ReadonlyArray<string>,
  env: Record<string, string> = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const child = Bun.spawn(["bun", join(scriptsDir, "uptime-report.ts"), ...extraArgs], {
    cwd: serverDir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GITHUB_OUTPUT: "", GITHUB_STEP_SUMMARY: "", ...env }
  })
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ])
  const exitCode = await child.exited
  return { exitCode, stdout, stderr }
}

describe("uptime-probe.ts against a live HTTP origin", () => {
  /*
   * `--json --samples 3` used to write the report to a file called
   * "--samples". Exit 2, never 1: an empty flag is a mistake in the
   * invocation, not a verdict about the deployment, and nothing is fetched.
   */
  test("a flag whose value is the next flag is refused before anything is probed", async () => {
    const report = join(workDir, "never-written.json")
    const result = await runProbe(["--json", "--samples", "3"])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("--json needs a value")
    expect(result.stderr).toContain("--samples")
    expect(existsSync(report)).toBe(false)
    expect(existsSync("--samples")).toBe(false)
  })

  test("a healthy origin exits 0 and writes a report naming every check", async () => {
    mode = "healthy"
    const jsonPath = join(workDir, "healthy.json")
    const { exitCode, stdout } = await runProbe(["--samples", "5", "--json", jsonPath])

    expect(stdout).toContain("ok: every probed endpoint answered")
    expect(stdout).toContain("ok: probe-request error rate — 0/15 probe request(s) failed")
    expect(stdout).toContain("CANARY UPTIME PROBE PASS")
    expect(exitCode).toBe(0)

    const report = JSON.parse(readFileSync(jsonPath, "utf8")) as ProbeReport
    expect(report.origin).toBe(origin())
    expect(report.failed).toBe(false)
    expect(report.samples).toHaveLength(15)
    expect(report.meteredTurns).toBe(0)
  })

  test("without $CANARY_SESSION_COOKIE it says the turn seam was not measured, and spends nothing", async () => {
    mode = "healthy"
    const { stdout } = await runProbe(["--samples", "1"])
    expect(stdout).toContain("skip: turn-seam first-frame latency")
    expect(stdout).toContain("$CANARY_SESSION_COOKIE is unset")
    expect(stdout).toContain("0 metered turn(s) spent")
  })

  test("with a session cookie it takes exactly one metered turn and times the first frame", async () => {
    mode = "healthy"
    const jsonPath = join(workDir, "metered.json")
    const { exitCode, stdout } = await runProbe(["--samples", "1", "--json", jsonPath], {
      CANARY_SESSION_COOKIE: "smithers_session=probe"
    })

    expect(stdout).toContain("ok: the metered turn runs as a scoped-down user")
    expect(stdout).toContain("ok: turn-seam first-frame latency")
    expect(stdout).toContain("1 metered turn(s) spent")
    expect(exitCode).toBe(0)

    const report = JSON.parse(readFileSync(jsonPath, "utf8")) as ProbeReport
    expect(report.meteredTurns).toBe(1)
    expect(report.samples.filter((s) => s.label === "turn-first-frame")).toHaveLength(1)
  })

  test("--no-turn suppresses the metered turn even when the cookie is set", async () => {
    mode = "healthy"
    const { stdout } = await runProbe(["--samples", "1", "--no-turn"], {
      CANARY_SESSION_COOKIE: "smithers_session=probe"
    })
    expect(stdout).toContain("0 metered turn(s) spent")
    expect(stdout).toContain("skip: turn-seam first-frame latency")
  })

  test("an admin cookie fails the run and spends nothing (RULINGS 35)", async () => {
    mode = "admin-session"
    const { exitCode, stdout } = await runProbe(["--samples", "1"], {
      CANARY_SESSION_COOKIE: "smithers_session=probe"
    })
    mode = "healthy"

    expect(stdout).toContain("FAIL: the metered turn runs as a scoped-down user")
    expect(stdout).toContain("0 metered turn(s) spent")
    expect(stdout).toContain("CANARY UPTIME PROBE FAILED")
    expect(exitCode).toBe(1)
  })

  test("a 5xx from the SPA fails uptime and the error rate, and exits 1", async () => {
    mode = "spa-down"
    const jsonPath = join(workDir, "down.json")
    const { exitCode, stdout } = await runProbe(["--samples", "5", "--json", jsonPath])

    expect(stdout).toContain("FAIL: every probed endpoint answered")
    expect(stdout).toContain("fully down: spa")
    expect(stdout).toContain("FAIL: probe-request error rate")
    expect(stdout).toContain("CANARY UPTIME PROBE FAILED")
    expect(exitCode).toBe(1)

    const report = JSON.parse(readFileSync(jsonPath, "utf8")) as ProbeReport
    expect(report.failed).toBe(true)
    expect(report.errorRate).toBeCloseTo(5 / 15, 10)
  })

  test("a turn seam that answers 200 to an anonymous caller fails the probe", async () => {
    mode = "turn-open"
    const { exitCode, stdout } = await runProbe(["--samples", "5"])
    expect(stdout).toContain("turn-gate (HTTP 200, expected 401)")
    expect(exitCode).toBe(1)
  })

  test("a nonsense --samples value is refused rather than silently defaulted", async () => {
    mode = "healthy"
    const { exitCode } = await runProbe(["--samples", "zero"])
    expect(exitCode).toBe(2)
  })
})

describe("uptime-report.ts", () => {
  const runUrl = "https://github.com/smithersai/smithers/actions/runs/7"

  /** A healthy uptime report on disk, as the quarter-hour and hourly probes write it. */
  const healthyReport = async (name: string): Promise<string> => {
    mode = "healthy"
    const report = join(workDir, `${name}-uptime.json`)
    await runProbe(["--samples", "5", "--json", report])
    return report
  }
  const browserResult = (name: string, result: unknown): string => {
    const path = join(workDir, `${name}-browser.json`)
    writeFileSync(path, JSON.stringify(result))
    return path
  }

  test("a healthy uptime report still alerts when the browser fails, and assigns the operator", async () => {
    const report = await healthyReport("browser-fail")
    const browser = browserResult("browser-fail", { status: "fail", error: "Error: Chat input is not editable" })
    const output = join(workDir, "browser-output.txt")
    const body = join(workDir, "browser-body.md")
    const result = await runReport([
      "--report", report, "--browser", browser, "--run-url", runUrl, "--body-out", body, "--github-output", output
    ])
    expect(result.exitCode).toBe(1)
    const lines = readFileSync(output, "utf8")
    expect(lines).toContain("action=create")
    expect(lines).toMatch(/^assignees=\S+$/m)
    expect(readFileSync(body, "utf8")).toContain("canary-browser artifact")
    expect(readFileSync(body, "utf8")).toContain("Chat input is not editable")
  })

  /*
   * The regression that kept the canary switched off: removing the enable gate
   * before the browser fixture existed would have filed "smithers.sh is
   * failing" on the first hourly run. An unconfigured browser canary skips.
   */
  test("an unconfigured browser canary is a skip row, never an outage issue", async () => {
    const report = await healthyReport("browser-skip")
    const browser = browserResult("browser-skip", { status: "skip", missing: ["CANARY_SESSION_COOKIE", "CANARY_BROWSER_FLOW", "CANARY_BROWSER_WORKSPACE"] })
    const output = join(workDir, "skip-output.txt")
    const body = join(workDir, "skip-body.md")
    const result = await runReport(["--report", report, "--browser", browser, "--body-out", body, "--github-output", output])
    expect(result.exitCode).toBe(0)
    expect(readFileSync(output, "utf8")).toContain("action=none")
    expect(readFileSync(body, "utf8")).toContain("| skip |")
    expect(readFileSync(body, "utf8")).toContain("CANARY_SESSION_COOKIE")
    expect(result.stdout).toContain("::warning title=Canary did not measure::")
    expect(result.stdout).toContain("CANARY_BROWSER_FLOW")
  })

  test("an unconfigured browser canary on a full run closes an open issue once uptime recovers", async () => {
    const report = await healthyReport("browser-skip-close")
    const browser = browserResult("browser-skip-close", { status: "skip", missing: ["CANARY_SESSION_COOKIE"] })
    const output = join(workDir, "skip-close-output.txt")
    const result = await runReport(["--report", report, "--browser", browser, "--open-issue", "42", "--github-output", output])
    expect(result.exitCode).toBe(0)
    expect(readFileSync(output, "utf8")).toContain("action=close\nissue=42\n")
  })

  test("a full run whose browser step wrote no verdict alerts", async () => {
    const report = await healthyReport("browser-missing")
    const output = join(workDir, "browser-missing-output.txt")
    const body = join(workDir, "browser-missing-body.md")
    const result = await runReport([
      "--report", report, "--browser", join(workDir, "no-browser-result.json"), "--body-out", body, "--github-output", output
    ])
    expect(result.exitCode).toBe(1)
    expect(readFileSync(output, "utf8")).toContain("action=create")
    expect(readFileSync(body, "utf8")).toContain("the browser probe produced no verdict")
  })

  test("a quarter-hour uptime pass leaves an open browser alert for the next full run", async () => {
    const report = await healthyReport("quarter")
    const output = join(workDir, "quarter-output.txt")
    const result = await runReport(["--report", report, "--open-issue", "42", "--github-output", output])
    expect(result.exitCode).toBe(0)
    expect(readFileSync(output, "utf8")).toContain("action=none")
    expect(result.stdout).toContain("browser recheck is pending")
  })

  test("--force-fail drills the alert path on a healthy deployment", async () => {
    const report = await healthyReport("drill")
    const output = join(workDir, "drill-output.txt")
    const body = join(workDir, "drill-body.md")
    const result = await runReport([
      "--report", report, "--force-fail", "workflow_dispatch drill", "--body-out", body, "--github-output", output
    ])
    expect(result.exitCode).toBe(1)
    expect(readFileSync(output, "utf8")).toContain("action=create")
    expect(readFileSync(output, "utf8")).toMatch(/^assignees=\S+$/m)
    expect(readFileSync(body, "utf8")).toContain("deliberate failure to verify alert delivery")
    expect(readFileSync(body, "utf8")).toContain("workflow_dispatch drill")
  })

  test("a --report flag with no value is refused before any file is written", async () => {
    const result = await runReport(["--report", "--body-out", join(workDir, "body.md")])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("--report needs a value")
    expect(existsSync(join(workDir, "body.md"))).toBe(false)
  })

  test("the workflow captures a failing verdict under bash -e before running the alert", async () => {
    const workflow = readFileSync(join(serverDir, "../../.github/workflows/canary.yml"), "utf8")
    const decision = workflow.split("      - name: Decide the alert\n")[1]!.split("      - name:")[0]!
    const script = decision.split("        run: |\n")[1]!.split("\n").map((line) => line.replace(/^          /, "")).join("\n")
    const temp = mkdtempSync(join(workDir, "workflow-"))
    const output = join(temp, "output.txt")
    // A missing probe report is the deploy/crash failure path. Run the actual
    // workflow body using Actions' errexit semantics, without contacting GitHub.
    const child = Bun.spawn(["bash", "-e", "-o", "pipefail", "-c", script], {
      cwd: serverDir, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, RUNNER_TEMP: temp, GITHUB_OUTPUT: output, RUN_URL: runUrl, OPEN_ISSUE: "", BROWSER_RESULT: "", FORCE_FAILURE: "" }
    })
    const diagnostics = await new Response(child.stderr).text()
    expect(await child.exited, diagnostics).toBe(0)
    expect(readFileSync(output, "utf8")).toContain("verdict=1\n")
    expect(readFileSync(output, "utf8")).toContain("action=create\n")
    expect(readFileSync(join(temp, "canary-alert.md"), "utf8")).toContain(runUrl)
    expect(workflow).toContain("      - name: Raise or clear the alert\n        if: always()")
  })

  test("the workflow's Decide step passes the browser result and the drill through to the report", async () => {
    const workflow = readFileSync(join(serverDir, "../../.github/workflows/canary.yml"), "utf8")
    const decision = workflow.split("      - name: Decide the alert\n")[1]!.split("      - name:")[0]!
    const script = decision.split("        run: |\n")[1]!.split("\n").map((line) => line.replace(/^          /, "")).join("\n")
    const temp = mkdtempSync(join(workDir, "workflow-drill-"))
    mode = "healthy"
    await runProbe(["--samples", "5", "--json", join(temp, "canary-uptime.json")])
    const browser = join(temp, "result.json")
    writeFileSync(browser, JSON.stringify({ status: "skip", missing: ["CANARY_SESSION_COOKIE"] }))
    const output = join(temp, "output.txt")
    const child = Bun.spawn(["bash", "-e", "-o", "pipefail", "-c", script], {
      cwd: serverDir, stdout: "pipe", stderr: "pipe",
      env: {
        ...process.env, RUNNER_TEMP: temp, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: "", RUN_URL: runUrl, OPEN_ISSUE: "",
        BROWSER_RESULT: browser, FORCE_FAILURE: "workflow_dispatch drill"
      }
    })
    const diagnostics = await new Response(child.stderr).text()
    expect(await child.exited, diagnostics).toBe(0)
    expect(readFileSync(output, "utf8")).toContain("verdict=1\n")
    expect(readFileSync(output, "utf8")).toContain("action=create\n")
    const body = readFileSync(join(temp, "canary-alert.md"), "utf8")
    expect(body).toContain("| skip | smithers.sh browser |")
    expect(body).toContain("| FAIL | alert delivery drill |")
  })

  test("a failing report with nothing open asks for the issue to be created", async () => {
    mode = "spa-down"
    const jsonPath = join(workDir, "alert-fail.json")
    await runProbe(["--samples", "5", "--json", jsonPath])

    const outputPath = join(workDir, "output-create.txt")
    const bodyPath = join(workDir, "body-create.md")
    const { exitCode, stdout } = await runReport([
      "--report",
      jsonPath,
      "--run-url",
      runUrl,
      "--body-out",
      bodyPath,
      "--github-output",
      outputPath
    ])

    expect(stdout).toContain("alert: create")
    expect(exitCode).toBe(1)
    const output = readFileSync(outputPath, "utf8")
    expect(output).toContain("action=create")
    expect(output).toContain("issue=\n")
    expect(output).toContain(`title=${ALERT_TITLE}`)
    const body = readFileSync(bodyPath, "utf8")
    expect(body).toContain(`Run: ${runUrl}`)
    expect(body).toContain("| FAIL | every probed endpoint answered |")
  })

  test("a failing report with an issue open comments on it instead of opening a second", async () => {
    mode = "spa-down"
    const jsonPath = join(workDir, "alert-fail-2.json")
    await runProbe(["--samples", "5", "--json", jsonPath])

    const outputPath = join(workDir, "output-comment.txt")
    const { exitCode, stdout } = await runReport([
      "--report",
      jsonPath,
      "--open-issue",
      "31",
      "--github-output",
      outputPath
    ])

    expect(stdout).toContain("alert: comment on issue #31")
    expect(exitCode).toBe(1)
    expect(readFileSync(outputPath, "utf8")).toContain("action=comment\nissue=31\n")
  })

  test("a passing full run closes the open issue and exits 0", async () => {
    mode = "healthy"
    const jsonPath = join(workDir, "alert-pass.json")
    await runProbe(["--samples", "5", "--json", jsonPath])

    const outputPath = join(workDir, "output-close.txt")
    const bodyPath = join(workDir, "body-close.md")
    const { exitCode, stdout } = await runReport([
      "--report",
      jsonPath,
      "--browser",
      browserResult("close", { status: "pass", checks: ["signed-in browser session"] }),
      "--open-issue",
      "31",
      "--body-out",
      bodyPath,
      "--github-output",
      outputPath
    ])

    expect(stdout).toContain("alert: close on issue #31")
    expect(exitCode).toBe(0)
    expect(readFileSync(outputPath, "utf8")).toContain("action=close\nissue=31\n")
    expect(readFileSync(bodyPath, "utf8")).toStartWith("The canary recovered.")
  })

  test("a passing report with nothing open does nothing and exits 0", async () => {
    mode = "healthy"
    const jsonPath = join(workDir, "alert-pass-2.json")
    await runProbe(["--samples", "5", "--json", jsonPath])

    const outputPath = join(workDir, "output-none.txt")
    const { exitCode, stdout } = await runReport(["--report", jsonPath, "--github-output", outputPath])

    expect(stdout).toContain("alert: none")
    expect(exitCode).toBe(0)
    expect(readFileSync(outputPath, "utf8")).toContain("action=none")
  })

  test("a probe that never wrote a report still alerts, and never reports success", async () => {
    const outputPath = join(workDir, "output-missing.txt")
    const bodyPath = join(workDir, "body-missing.md")
    const { exitCode, stdout } = await runReport([
      "--report",
      join(workDir, "does-not-exist.json"),
      "--body-out",
      bodyPath,
      "--github-output",
      outputPath
    ])

    expect(stdout).toContain("alert: create")
    expect(exitCode).toBe(1)
    expect(readFileSync(bodyPath, "utf8")).toContain("proved nothing about the deployment")
  })

  test("--report is required", async () => {
    const { exitCode } = await runReport([])
    expect(exitCode).toBe(2)
  })
})
