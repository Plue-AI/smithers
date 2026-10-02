import { describe, expect, test } from "bun:test";
import { diffStatus } from "../../src/git/diffStatus.ts";
import { effectivePath } from "../../src/git/effectivePath.ts";
import { diffRecordFixture as diffRecord } from "../support/diffRecordFixture.ts";

describe("diff record paths", () => {
  test("effectivePath prefers the new path unless it is /dev/null", () => {
    expect(effectivePath(diffRecord({ newPath: "src/new.ts", oldPath: "src/old.ts" }))).toBe("src/new.ts");
    expect(effectivePath(diffRecord({ newPath: "/dev/null", oldPath: "src/gone.ts" }))).toBe("src/gone.ts");
  });

  test("diffStatus classifies binary, added, deleted, renamed, and modified", () => {
    expect(diffStatus(diffRecord({ isBinary: true }))).toBe("binary");
    expect(diffStatus(diffRecord({ isNew: true, oldPath: "/dev/null" }))).toBe("added");
    expect(diffStatus(diffRecord({ isDeleted: true, newPath: "/dev/null" }))).toBe("deleted");
    expect(diffStatus(diffRecord({ oldPath: "src/old.ts", newPath: "src/new.ts" }))).toBe("renamed");
    expect(diffStatus(diffRecord({}))).toBe("modified");
  });
});
