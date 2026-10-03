import { describe, expect, it } from "vitest"
import { makeCli } from "../src/Cli.ts"

// T-INS-04 step 0 / T-INS-08 contract: registered flags with no launcher.
// No substitute supervisor or fabricated launchd success is allowed.
describe("host start serving contract", () => {
  it("parses bind, repeated origins and bundle, then refuses before any network effect", async () => {
    let output = "", status = 0
    const cli = makeCli({ exit: code => { status = code } })
    await cli.serve(["host", "start", "--bind", "0.0.0.0", "--origin", "http://lan-a:4000", "--origin", "https://box.example", "--bundle", "/fixture-bundle", "--json"], {
      stdout: text => { output += text }, exit: code => { status = code }
    })
    expect(status).not.toBe(0)
    expect(output).toContain("host_launcher_unavailable")
    expect(output).not.toContain("Unknown command")
    expect(output).not.toContain("Unknown option")
  })
  it("bind without origin names the LAN origin requirement while launch stays dark", async () => {
    let output = ""
    const cli = makeCli({ exit: () => {} })
    await cli.serve(["host", "start", "--bind", "0.0.0.0", "--bundle", "/fixture-bundle", "--json"], {
      stdout: text => { output += text }, exit: () => {}
    })
    expect(output).toContain("host_launcher_unavailable")
    expect(output).toContain("LAN browsers need --origin")
  })

})
