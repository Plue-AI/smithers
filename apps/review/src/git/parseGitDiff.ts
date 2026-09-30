import type { DiffRecord } from "./diffRecord.ts";

/**
 * Splits unified `git diff` text into one record per file, counting lines and
 * marking additions, deletions, and binaries.
 *
 * File headers (`---`, `+++`, mode lines) are read only before a file's first
 * hunk; inside a hunk every `+`/`-` line is content, so an added `++i;` (Git
 * prints `+++i;`) or a removed `-- comment` (`--- comment`) still counts.
 */
export function parseGitDiff(diffText: string): DiffRecord[] {
  const lines = diffText.split("\n");
  const records: DiffRecord[] = [];
  let current: DiffRecord | null = null;
  let buffer: string[] = [];
  let inHunk = false;
  const flush = () => {
    if (!current) return;
    current.diff = buffer.join("\n").replace(/\n$/, "");
    records.push(current);
    buffer = [];
  };

  for (const line of lines) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      flush();
      current = {
        oldPath: header[1],
        newPath: header[2],
        diff: "",
        insertions: 0,
        deletions: 0,
        isNew: false,
        isDeleted: false,
        isBinary: false,
      };
      inHunk = false;
    }
    if (!current) continue;
    if (line.startsWith("@@ ")) inHunk = true;
    if (inHunk) {
      if (line.startsWith("+")) current.insertions += 1;
      else if (line.startsWith("-")) current.deletions += 1;
      buffer.push(line);
      continue;
    }
    if (line.startsWith("Binary files ")) current.isBinary = true;
    if (line.startsWith("new file mode ")) {
      current.isNew = true;
      current.oldPath = "/dev/null";
    }
    if (line.startsWith("deleted file mode ")) {
      current.isDeleted = true;
      current.newPath = "/dev/null";
    }
    if (/^--- \/dev\/null$/.test(line) || /^--- a\/dev\/null$/.test(line)) current.isNew = true;
    if (/^\+\+\+ \/dev\/null$/.test(line) || /^\+\+\+ b\/dev\/null$/.test(line)) {
      current.isDeleted = true;
      current.newPath = "/dev/null";
    }
    buffer.push(line);
  }
  flush();
  return records;
}
