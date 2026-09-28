import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeFixture, unsafeEntries } from "./fixtureRepo.ts";

const corpusDir = join(import.meta.dirname, "corpus");

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "review-seeded-fixture-test-"));
}

function fixture(root: string): string {
  const dir = join(root, "fixture");
  for (const side of ["base", "head"]) {
    mkdirSync(join(dir, side, "src"), { recursive: true });
    writeFileSync(join(dir, side, "src", "a.ts"), `export const side = "${side}";\n`);
  }
  return dir;
}

describe("corpus integrity", () => {
  test("no fixture carries a symbolic link or a git control file", () => {
    expect(unsafeEntries(corpusDir)).toEqual([]);
  });
});

describe("materializeFixture", () => {
  test("commits base and leaves head in the worktree", () => {
    const root = scratch();
    try {
      const repo = materializeFixture(fixture(root), join(root, "work"));
      const diff = execFileSync("git", ["diff"], { cwd: repo, encoding: "utf8" });
      expect(diff).toContain('+export const side = "head";');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses a head/.git/config that would reconfigure the repository", () => {
    const root = scratch();
    try {
      const dir = fixture(root);
      const marker = join(root, "pwned");
      mkdirSync(join(dir, "head", ".git"), { recursive: true });
      writeFileSync(join(dir, "head", ".git", "config"), `[core]\n\tfsmonitor = touch ${marker}\n`);
      expect(() => materializeFixture(dir, join(root, "work"))).toThrow(/git control file/);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([".gitattributes", ".gitmodules"])("refuses a nested %s", (name) => {
    const root = scratch();
    try {
      const dir = fixture(root);
      writeFileSync(join(dir, "base", "src", name), "* filter=evil\n");
      expect(() => materializeFixture(dir, join(root, "work"))).toThrow(/git control file/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses a symbolic link to a host file", () => {
    const root = scratch();
    try {
      const dir = fixture(root);
      const secret = join(root, "secret.env");
      writeFileSync(secret, "API_KEY=host-secret\n");
      symlinkSync(secret, join(dir, "head", "src", "leak.ts"));
      expect(unsafeEntries(dir)).toEqual([join(dir, "head", "src", "leak.ts")]);
      expect(() => materializeFixture(dir, join(root, "work"))).toThrow(/symbolic link/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([".GITATTRIBUTES", ".Gitmodules"])("refuses %s in another letter case", (name) => {
    const root = scratch();
    try {
      const dir = fixture(root);
      writeFileSync(join(dir, "head", name), "* filter=evil\n");
      expect(unsafeEntries(dir)).toEqual([join(dir, "head", name)]);
      expect(() => materializeFixture(dir, join(root, "work"))).toThrow(/git control file/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses a head/ directory that is a symbolic link to a host directory", () => {
    const root = scratch();
    try {
      const dir = fixture(root);
      const host = join(root, "host");
      mkdirSync(host);
      writeFileSync(join(host, "secret.env"), "API_KEY=host-secret\n");
      rmSync(join(dir, "head"), { recursive: true, force: true });
      symlinkSync(host, join(dir, "head"));
      const work = join(root, "work");
      expect(() => materializeFixture(dir, work)).toThrow(/symbolic link/);
      expect(existsSync(join(work, "repo", "secret.env"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
