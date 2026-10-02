import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const source = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")

const importsAgentFromBridge = /import type \{[^}]*\bNativeAgent\b[^}]*\} from "[^"]*NativeBridge"/

describe("agent port placement", () => {

  test("every implementation binds the contract from the runtime module", () => {
    for (const file of ["./Runtime.ts", "../native/WebAgent.ts"]) {
      const implementation = source(file)
      expect(implementation).toContain("AgentPort")
      expect(implementation).not.toMatch(importsAgentFromBridge)
    }
  })
})
