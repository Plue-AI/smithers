import { describe, expect, test } from "bun:test"
import { terminalExecutionProof, terminalExecutionProved } from "./terminal-proof"

describe("terminal execution proof", () => {
  test("echo-only PTY output does not satisfy the execution proof", () => {
    const proof = terminalExecutionProof("123456")
    const echoOnly = `${proof.setValue}\r\n${proof.readValue}\r\n`
    expect(proof.setValue).not.toContain(proof.marker)
    expect(proof.readValue).not.toContain(proof.marker)
    expect(terminalExecutionProved(echoOnly, proof.marker)).toBe(false)
    expect(terminalExecutionProved(`${echoOnly}${proof.marker}\r\n`, proof.marker)).toBe(true)
  })
})
