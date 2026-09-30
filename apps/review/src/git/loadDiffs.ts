import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "./runCommand.ts";
import { runGit } from "./runGit.ts";
import { parseGitDiff } from "./parseGitDiff.ts";
import { effectivePath } from "./effectivePath.ts";
import { mergeBase } from "./mergeBase.ts";
import { reviewMode } from "../review/reviewMode.ts";
import type { OpenCodeReviewInput } from "../workflow/openCodeReviewInputSchema.ts";

const DIFF_CONTEXT_LINES = 3;

/**
 * Reads one untracked path the way Git records it, never following a symlink.
 *
 * A symlink contributes its target text, so a link that points outside the
 * repository can never copy the linked file's bytes into a review diff.
 * Anything that is not a regular file (directory, fifo, socket, device)
 * contributes nothing.
 */
type UntrackedBody =
  | { kind: "symlink"; text: string }
  | { kind: "text"; text: string }
  | { kind: "binary"; executable: boolean };

/** Git's own test: a NUL byte in the first 8000 bytes makes a file binary. */
const BINARY_SNIFF_BYTES = 8000;

function readUntrackedBody(fullPath: string): UntrackedBody | null {
  const entry = lstatSync(fullPath, { throwIfNoEntry: false });
  if (entry === undefined) return null;
  if (entry.isSymbolicLink()) return { kind: "symlink", text: readlinkSync(fullPath) };
  if (!entry.isFile()) return null;
  // O_NOFOLLOW closes the window between lstat and open: a path swapped for a
  // symlink after the check fails to open instead of reading the link target.
  let fd: number;
  try {
    fd = openSync(fullPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const bytes = readFileSync(fd);
    if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
      return { kind: "binary", executable: (stat.mode & 0o111) !== 0 };
    }
    return { kind: "text", text: bytes.toString("utf8") };
  } finally {
    closeSync(fd);
  }
}

const QUOTED_ESCAPES: Record<string, string> = {
  "\u0007": "\\a",
  "\b": "\\b",
  "\t": "\\t",
  "\n": "\\n",
  "\u000b": "\\v",
  "\f": "\\f",
  "\r": "\\r",
  '"': '\\"',
  "\\": "\\\\",
};

/**
 * Spells a path the way `git diff` does under `core.quotePath=false`: bare,
 * unless it holds a quote, backslash or control character, which Git
 * C-quotes (other control bytes as octal escapes).
 */
function quoteGitPath(path: string) {
  if (!/["\\\u0000-\u001f\u007f]/.test(path)) return path;
  const body = path.replace(
    /["\\\u0000-\u001f\u007f]/g,
    (char) => QUOTED_ESCAPES[char] ?? `\\${char.charCodeAt(0).toString(8).padStart(3, "0")}`,
  );
  return `"${body}"`;
}

async function workspaceDiffText(repoDir: string) {
  let tracked = "";
  const trackedResult = await runCommand(
    "git",
    ["-c", "core.quotepath=false", "diff", "HEAD", "--no-color", `-U${DIFF_CONTEXT_LINES}`, "--"],
    repoDir,
  );
  if (trackedResult.exitCode === 0 && trackedResult.stdout !== "") {
    tracked = trackedResult.stdout;
  } else {
    tracked = await runGit(repoDir, ["diff", "--staged", "--no-color", `-U${DIFF_CONTEXT_LINES}`, "--"]);
  }

  // NUL-delimited: a name may start or end with spaces or hold a newline.
  const untracked = await runGit(repoDir, ["ls-files", "-z", "--others", "--exclude-standard"]);
  const pieces = [tracked];
  for (const relPath of untracked.split("\0").filter((path) => path !== "")) {
    const body = readUntrackedBody(join(repoDir, relPath));
    if (body === null) continue;
    const newName = quoteGitPath(`b/${relPath}`);
    const diffLines = [`diff --git ${quoteGitPath(`a/${relPath}`)} ${newName}`];
    if (body.kind === "binary") {
      // Same record git diff writes for a binary: no bytes ever reach a prompt.
      diffLines.push(
        `new file mode ${body.executable ? "100755" : "100644"}`,
        `Binary files /dev/null and ${newName} differ`,
      );
      pieces.push(diffLines.join("\n"));
      continue;
    }
    const text = body.text;
    const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
    const lineCount = text.length === 0 ? 0 : lines.length;
    const addedLines = text.length > 0 ? lines.map((line) => `+${line}`) : [];
    if (body.kind === "symlink") diffLines.push("new file mode 120000");
    diffLines.push(
      "--- /dev/null",
      `+++ ${newName}${newName.includes(" ") && !newName.startsWith('"') ? "\t" : ""}`,
      `@@ -0,0 +1,${lineCount} @@`,
      ...addedLines,
    );
    pieces.push(diffLines.join("\n"));
  }
  return pieces.filter(Boolean).join("\n\n");
}

/** The app's own state dir: never part of the change set it reviews. */
const STATE_DIR = ".smithers-review";

function isOwnPath(path: string, own: ReadonlyArray<string>) {
  return [STATE_DIR, ...own].some((ownPath) => path === ownPath || path.startsWith(`${ownPath}/`));
}

/**
 * Reads the change set from git and parses it into one record per file.
 *
 * `own` names the repo-relative paths this run writes (see `reviewOwnPaths`);
 * they and the `.smithers-review` state dir are left out, so a repository
 * that does not ignore them never has the tool's output reviewed.
 *
 * Nothing else is dropped. A tracked change is part of the change set whatever
 * `.gitignore` says, and in range and commit mode that file belongs to the
 * change under review. Untracked files follow git's own ignore rules.
 * Scope filters (`whyExcluded`) mark files unreviewed; they never hide them.
 *
 * @since 1.0.0
 * @category constructors
 */
export async function loadDiffs(repoDir: string, input: OpenCodeReviewInput, own: ReadonlyArray<string> = []) {
  const mode = reviewMode(input);
  let diffText = "";
  if (mode === "range") {
    const base = await mergeBase(repoDir, input.from, input.to);
    diffText = await runGit(repoDir, [
      "diff",
      "--no-color",
      `-U${DIFF_CONTEXT_LINES}`,
      "--end-of-options",
      base,
      input.to.trim(),
      "--",
    ]);
  } else if (mode === "commit") {
    diffText = await runGit(repoDir, [
      "show",
      "--no-color",
      `-U${DIFF_CONTEXT_LINES}`,
      "--end-of-options",
      input.commit.trim(),
    ]);
  } else {
    diffText = await workspaceDiffText(repoDir);
  }

  return parseGitDiff(diffText).filter((diff) => !isOwnPath(effectivePath(diff), own));
}
