import { expect, test } from "bun:test"
import { egressFlows } from "./egress"
import type { CommandActions } from "./Declare"
import { confirmLabel } from "../registry"
import { payloadFor } from "../SlashPayload"

test("egress.allow asks the person, and its confirmation binds the repository selected when the agent asked", () => {
  let selected: string | null = "will/smithers"
  const allowed: Array<[string, string | undefined]> = []
  const actions = {
    activeRepository: () => selected,
    allowEgressHost: (host: string, repo?: string) => {
      allowed.push([host, repo])
      return Promise.resolve({ value: "Requested" })
    }
  } as unknown as CommandActions
  const entry = egressFlows(actions).find((row) => row.declaredName === "egress.allow")!
  const payload = { host: "api.example.com" }
  expect(confirmLabel(entry.metadata, payload)).toBe("let will/smithers's sandboxes reach api.example.com")
  const bound = entry.metadata.confirmArgs?.(payload)
  expect(bound).toBe("api.example.com will/smithers")
  // Switching repositories after the ask leaves the bound line on the first one.
  selected = "other/repo"
  expect(payloadFor("egress.allow", bound, entry.metadata.grammar)).toEqual({ payload: { host: "api.example.com", repo: "will/smithers" } })
  // A named repository wins over the selection; with neither, nothing is bound.
  expect(entry.metadata.confirmArgs?.({ host: "a.example.com", repo: "named/repo" })).toBe("a.example.com named/repo")
  selected = null
  expect(entry.metadata.confirmArgs?.(payload)).toBeUndefined()
  expect(confirmLabel(entry.metadata, payload)).toBe("let the selected repository's sandboxes reach api.example.com")
})
