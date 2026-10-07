import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import * as Presentation from "../src/cli/Presentation.ts"
import * as Doctor from "../src/Doctor.ts"
import * as Forensics from "../src/Forensics.ts"
import { errorCode } from "../src/internal/ErrorCode.ts"
import { hasTable } from "../src/internal/SqliteTable.ts"
import * as Ui from "../src/Ui.ts"

describe("shared helpers", () => {
  it("quotes follow-up arguments exactly as Forensics does", () => {
    const table = ["", "run-1", "a b", "it's", "$(x)", "a+b", "k=v", "50%", "a,b", "/tmp/x:1", "u@h", "*", "~"]
    for (const value of table) expect(Presentation.quote(value), value).toBe(Forensics.shellQuote(value))
  })

  it("reads a string error code and nothing else", () => {
    expect(errorCode(Object.assign(new Error("gone"), { code: "ENOENT" }))).toBe("ENOENT")
    expect(errorCode({ code: 1 })).toBeUndefined()
    expect(errorCode("ENOENT")).toBeUndefined()
    expect(errorCode(null)).toBeUndefined()
  })

  it("probes tables and not views", () => {
    const db = new DatabaseSync(":memory:")
    db.exec("CREATE TABLE present (id INTEGER); CREATE VIEW seen AS SELECT 1")
    expect(hasTable(db, "present")).toBe(true)
    expect(hasTable(db, "seen")).toBe(false)
    expect(hasTable(db, "absent")).toBe(false)
    db.close()
  })

  it("renders the doctor report through the one checklist renderer", () => {
    const checks: ReadonlyArray<Doctor.Check> = [
      { name: "node", level: "ok", detail: "v22" },
      { name: "seat", level: "warn", detail: "none" },
      { name: "db", level: "fail", detail: "locked" }
    ]
    expect(Doctor.render({ root: "/work", checks })).toBe(
      "Diagnostics: /work\nok   node: v22\nwarn seat: none\nfail db: locked"
    )
    expect(Doctor.render({ root: "/work", checks }))
      .toBe(Ui.renderChecklist("Diagnostics: /work", checks, { interactive: false }))
  })
})
