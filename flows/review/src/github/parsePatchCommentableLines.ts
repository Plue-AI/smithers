/**
 * New-side line numbers a PR review comment can anchor to, parsed from a
 * GitHub `files` API `patch`. GitHub accepts side=RIGHT comments on lines the
 * diff shows: additions and context lines. Deleted-only lines exist solely on
 * the old side and are not commentable on RIGHT.
 */
export function parsePatchCommentableLines(patch: string): Set<number> {
  const commentable = new Set<number>();
  if (!patch.trim()) return commentable;
  let newLine = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      commentable.add(newLine);
      newLine += 1;
    } else if (line.startsWith("-")) {
      // Old side only; the new-side counter does not advance.
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" marker; no line on either side.
    } else {
      // Context line: present on both sides, commentable on RIGHT.
      commentable.add(newLine);
      newLine += 1;
    }
  }
  return commentable;
}
