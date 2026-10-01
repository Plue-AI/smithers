import { describe, expect, it } from "@effect/vitest"
import { Fault } from "@smthrs/flow"
import { Unreachable } from "@smthrs/kernel"
import { Schema } from "effect"

const signatures = [
  "Could not resolve host: github.com",
  "Failed to connect to github.com",
  "Connection timed out",
  "Operation timed out",
  "Connection reset by peer",
  "Recv failure",
  "Network is unreachable",
  "Temporary failure in name resolution",
  "SSL_ERROR_SYSCALL",
  "The remote end hung up unexpectedly",
  "getaddrinfo EAI_AGAIN github.com",
  "getaddrinfo ENOTFOUND github.com",
  "HTTP 429 Too Many Requests",
  "HTTP/1.1 500 Internal Server Error",
  "HTTP/2 502 Bad Gateway",
  "HTTP 503 Service Unavailable",
  "HTTP 599 upstream failure"
]

describe("Unreachable host exit classification", () => {
  it.each(signatures)("classifies %s as infrastructure", (stderr) => {
    const failure = Unreachable.classifyExit(stderr)
    expect(failure).toBeInstanceOf(Unreachable.Unreachable)
    expect(failure?.message).toBe(stderr)
    expect(Fault.of(failure)).toEqual({ class: "infra", tag: "@smthrs/kernel/Unreachable" })
  })

  it.each([
    "",
    "fatal: not a repository",
    "HTTP 400 Bad Request",
    "HTTP 401 Unauthorized",
    "HTTP 403 Forbidden",
    "HTTP 404 Not Found",
    "HTTP 499 client closed request",
    "HTTP 600 invalid status",
    "compiled 500 files",
    "issue 429 is closed",
    "exit code 5"
  ])(
    "does not treat work failures as outages: %s",
    (stderr) => {
      expect(Unreachable.classifyExit(stderr)).toBeUndefined()
    }
  )

  it("preserves the typed cause and survives schema round trips", () => {
    const cause = { diagnostic: "resolver unavailable" }
    const failure = new Unreachable.Unreachable({ message: "DNS unavailable", cause })
    expect(failure.cause).toBe(cause)
    const decoded = Schema.decodeUnknownSync(Unreachable.Unreachable)(
      Schema.encodeSync(Unreachable.Unreachable)(failure)
    )
    expect(decoded).toBeInstanceOf(Unreachable.Unreachable)
    expect(decoded.message).toBe(failure.message)
    expect(decoded.cause).toEqual(cause)
    expect(Fault.of(decoded).class).toBe("infra")
  })
})
