import type { DiffRecord } from "../../src/git/diffRecord.ts";

/** A modified `src/a.ts` with no content, overridden field by field. */
export function diffRecordFixture(overrides: Partial<DiffRecord>): DiffRecord {
  return {
    oldPath: "src/a.ts",
    newPath: "src/a.ts",
    diff: "",
    insertions: 0,
    deletions: 0,
    isNew: false,
    isDeleted: false,
    isBinary: false,
    ...overrides,
  };
}
