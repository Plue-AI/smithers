import type { Diff, DiffFile, DiffFileStatus, DiffLine, Hunk } from "./diff";

/**
 * Pure, DOM-free diff domain for the {@link file://./diff-hunks.tsx DiffHunks}
 * renderer. Everything here is deterministic so the domain tests can exercise it
 * directly and callers can lean on it without a runtime:
 *
 * - `parseUnifiedFile` / `parseHunks` → turn a raw unified patch into a
 *   `DiffFile` (add/del totals, per-line numbering, status, rename + mode edges).
 * - `detectBinary`  → the git binary-marker check, read off patch metadata
 *   rows rather than off hunk-body text.
 * - `groupHunks`    → split a file's flat lines into `@@`-headed hunks.
 * - `paginateHunks` → trim whole hunks then partials to a line budget.
 * - `initialExpanded` → the large-diff expand seed (≤3 all, else first 3).
 * - `byteCountString` → the binary placeholder's human size formatter.
 */

export type { Hunk } from "./diff";

/** A file's normalized status, defaulting to "modified" when unset. */
export function fileStatus(file: DiffFile): DiffFileStatus {
  return file.status ?? "modified";
}

/** The single-letter status badge a rail renders (A/M/D/R/?). */
const STATUS_LETTER: Record<DiffFileStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  unknown: "?",
};

export function statusLetter(file: DiffFile): string {
  return STATUS_LETTER[fileStatus(file)];
}

/**
 * Detect a binary file. An explicit `isBinary` flag wins; otherwise a marker is
 * only a marker where git would have written one: on a CONTEXT line that is not
 * a hunk header.
 *
 * Reading structure rather than text is what keeps this in agreement with
 * `parseUnifiedFile`, which classifies from the raw patch with an anchored
 * regex. Scanning every line's text, as this used to, reported a markdown file
 * that ADDS the line `GIT binary patch` as binary while `parseUnifiedFile`
 * correctly called it a two-line text diff, and a consumer gating on this
 * function then hid a real diff behind a placeholder. Same class of bug as the
 * `@@`/`+++` sniffing that commit d7222dda1f fixed by tagging headers at parse
 * time; this is the same fix one function over.
 *
 * A NUMBERED context row is the last piece of that structure. `parseHunks`
 * numbers every context line it renders and strips the leading space that made
 * it context, so a text patch whose body reads ` GIT binary patch` produced a
 * row whose text is byte-identical to git's metadata marker. Git writes that
 * marker outside any hunk, where it has no line number, so the number is what
 * tells the two apart. Without this check a real addition rendered as a binary
 * placeholder.
 */
export function detectBinary(file: DiffFile): boolean {
  if (file.isBinary) return true;
  for (const line of file.lines) {
    if (line.header === true || line.kind !== "context") continue;
    if (line.lnOld !== undefined || line.ln !== undefined) continue;
    if (line.text === "GIT binary patch") return true;
    if (line.text.startsWith("Binary files ")) return true;
  }
  return false;
}

/**
 * Group a file's flat line list into hunks. Parsed header tags open hunks;
 * lines before the first header land in a synthetic hunk with an empty header
 * so nothing is dropped.
 */
export function groupHunks(file: DiffFile): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  for (const line of file.lines) {
    if (line.header === true) {
      current = { header: line.text, lines: [] };
      hunks.push(current);
      continue;
    }
    if (current === null) {
      current = { header: "", lines: [] };
      hunks.push(current);
    }
    current.lines.push(line);
  }
  return hunks;
}

/** Total rendered line count for a file (the lines inside its hunks). */
export function fileLineCount(file: DiffFile): number {
  return groupHunks(file).reduce((sum, hunk) => sum + hunk.lines.length, 0);
}

/** A generous render budget per file; pagination kicks in above it. */
export const PAGINATE_THRESHOLD = 2000;
/** …and renders the first this-many lines before the "Expand remaining" affordance. */
export const PAGINATE_VISIBLE = 1000;

/**
 * Trim a file's hunks to at most `visibleCount` lines, dropping whole trailing
 * hunks and then partially trimming the boundary hunk. Returns the kept hunks
 * plus how many lines were hidden, so the view can label the "Expand remaining
 * N lines" button.
 */
export function paginateHunks(file: DiffFile, visibleCount: number): { hunks: Hunk[]; hidden: number } {
  const all = groupHunks(file);
  const total = all.reduce((sum, hunk) => sum + hunk.lines.length, 0);
  if (visibleCount >= total) return { hunks: all, hidden: 0 };

  const kept: Hunk[] = [];
  let used = 0;
  for (const hunk of all) {
    if (used >= visibleCount) break;
    const remaining = visibleCount - used;
    if (hunk.lines.length <= remaining) {
      kept.push(hunk);
      used += hunk.lines.length;
    } else {
      kept.push({ header: hunk.header, lines: hunk.lines.slice(0, remaining) });
      used += remaining;
      break;
    }
  }
  return { hunks: kept, hidden: total - used };
}

/** A diff is "large" when it has many files or its bytes blow past ~1MB. */
export const LARGE_FILE_COUNT = 50;
export const LARGE_BYTE_LIMIT = 1_000_000;

export function totalBytes(diff: Diff): number {
  return diff.files.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0);
}

export function isLargeDiff(diff: Diff): boolean {
  return diff.files.length > LARGE_FILE_COUNT || totalBytes(diff) > LARGE_BYTE_LIMIT;
}

/**
 * The deterministic initial expanded set: large diffs start fully collapsed; ≤3
 * files expand every file; otherwise the first 3 expand and the rest stay
 * collapsed. Returns the file paths to mark expanded.
 */
export function initialExpanded(diff: Diff): string[] {
  if (isLargeDiff(diff)) return [];
  const paths = diff.files.map((file) => file.path);
  if (paths.length <= 3) return paths;
  return paths.slice(0, 3);
}

/** Aggregate add/del/file counts, summed from the files (never hardcoded). */
export function diffTotals(diff: Diff): { files: number; add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const file of diff.files) {
    add += file.add;
    del += file.del;
  }
  return { files: diff.files.length, add, del };
}

/**
 * Human byte-count string for the binary placeholder: bytes under 1024, KB
 * under 1MB, else MB; one decimal for the scaled units. An unknown size yields
 * a plain "Binary file" upstream.
 */
export function byteCountString(bytes: number): string {
  // A negative or non-finite size is not a size. Rendering "NaN MB" or "-5 B"
  // states a fact the caller does not have.
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The binary placeholder label: sized when known, plain otherwise. */
export function binaryBodyLabel(file: DiffFile): string {
  if (typeof file.sizeBytes === "number") return `Binary file (${byteCountString(file.sizeBytes)})`;
  return "Binary file";
}

/* -------------------------------------------------------------------------- */
/* Unified-patch parsing                                                      */
/* -------------------------------------------------------------------------- */

const BINARY_PATCH_RE = /(^GIT binary patch$)|(^Binary files )/m;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Split a patch into its lines without the synthetic final token.
 *
 * `"…\n".split(/\r?\n/)` ends in `""`, which is the terminator, not a line. The
 * blank-context branch used to render it as a real row and advance both side
 * counters, so a one-line replacement produced a phantom trailing context line.
 * Only the terminal token is dropped: a blank context line in the middle of a
 * patch body is genuine.
 */
function patchRows(diffText: string): string[] {
  const rows = diffText.split(/\r?\n/);
  if (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
  return rows;
}

/** Single-character C escapes git emits inside a quoted path. */
const GIT_ESCAPES: Readonly<Record<string, number>> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
};

/**
 * Decode the inside of a git-quoted path.
 *
 * Git quotes any path with a special or non-ASCII byte and escapes those bytes
 * in octal, one escape per BYTE: `café name.ts` ships as
 * `"caf\303\251 name.ts"`. Decoding has to reassemble the byte sequence and
 * then read it as UTF-8, which is why this builds a byte array rather than
 * concatenating characters.
 */
export function decodeGitPath(quoted: string): string {
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  for (let index = 0; index < quoted.length; index += 1) {
    const character = quoted[index]!;
    if (character !== "\\") {
      for (const byte of encoder.encode(character)) bytes.push(byte);
      continue;
    }
    const next = quoted[index + 1];
    if (next === undefined) break;
    const escape = GIT_ESCAPES[next];
    if (escape !== undefined) {
      bytes.push(escape);
      index += 1;
      continue;
    }
    const octal = quoted.slice(index + 1, index + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(Number.parseInt(octal, 8));
      index += 3;
      continue;
    }
    // An escape git does not emit: keep the character it guarded.
    for (const byte of encoder.encode(next)) bytes.push(byte);
    index += 1;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** The quoted form of a header path, as one alternation group pair. */
const QUOTED = String.raw`"((?:[^"\\]|\\.)*)"`;

const GIT_HEADER_RE = new RegExp(String.raw`^diff --git (?:${QUOTED}|a/(.+?)) (?:${QUOTED}|b/(.+))$`, "m");
const PLUS_HEADER_RE = new RegExp(String.raw`^\+\+\+ (?:${QUOTED}|(.+))$`, "m");
const MINUS_HEADER_RE = new RegExp(String.raw`^--- (?:${QUOTED}|(.+))$`, "m");
const RENAME_TO_RE = new RegExp(String.raw`^rename to (?:${QUOTED}|(.+))$`, "m");
const RENAME_FROM_RE = new RegExp(String.raw`^rename from (?:${QUOTED}|(.+))$`, "m");

/** Decode whichever alternative matched, then drop a leading `a/` or `b/`. */
function headerPath(quoted: string | undefined, plain: string | undefined): string | undefined {
  const raw = quoted !== undefined ? decodeGitPath(quoted) : plain?.trim();
  if (raw === undefined || raw === "") return undefined;
  return raw.startsWith("a/") || raw.startsWith("b/") ? raw.slice(2) : raw;
}

/**
 * Parse the hunk body of a unified patch into flat `DiffLine`s, counting
 * additions and deletions and numbering each side. `@@ … @@` headers ride along
 * as tagged `context` lines so {@link groupHunks} can re-split later.
 *
 * `partial` is true when the patch was cut: either the text looks like it has
 * hunks but none parsed, or a hunk body ended before it spent both of the line
 * budgets its `@@` header declared. Tracking only the first case reported a
 * patch chopped in half as complete, so the view showed a truncated file with
 * no warning.
 */
export function parseHunks(diffText: string): {
  lines: DiffLine[];
  add: number;
  del: number;
  partial: boolean;
} {
  const lines: DiffLine[] = [];
  let add = 0;
  let del = 0;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let sawHunk = false;
  let truncated = false;
  // Budgets from the `@@` header. They stop a hunk body deterministically
  // instead of relying on a prefix that a file's own content might carry.
  let oldRemaining = 0;
  let newRemaining = 0;

  /**
   * End the open hunk. A hunk is complete only once both budgets are spent, so
   * closing one with either side outstanding means the body was cut short by
   * EOF, by the next header, or by a row that is not hunk content.
   */
  const closeHunk = (): void => {
    if (inHunk && (oldRemaining > 0 || newRemaining > 0)) truncated = true;
    inHunk = false;
  };

  for (const raw of patchRows(diffText)) {
    const hunk = HUNK_RE.exec(raw);
    if (hunk) {
      closeHunk();
      sawHunk = true;
      inHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      // A count-less header (`@@ -1 +1 @@`) means exactly one line per side.
      oldRemaining = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newRemaining = hunk[4] === undefined ? 1 : Number(hunk[4]);
      lines.push({ kind: "context", header: true, text: raw });
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith("\\ No newline")) continue;
    if (oldRemaining <= 0 && newRemaining <= 0) {
      // The header's own line counts say this hunk is over; anything after it
      // is patch metadata until the next `@@`.
      inHunk = false;
      continue;
    }
    if (raw === "") {
      lines.push({ kind: "context", lnOld: oldLine, ln: newLine, text: raw });
      oldLine += 1;
      newLine += 1;
      oldRemaining -= 1;
      newRemaining -= 1;
      continue;
    }
    if (raw.startsWith("+")) {
      lines.push({ kind: "add", ln: newLine, text: raw.slice(1) });
      newLine += 1;
      newRemaining -= 1;
      add += 1;
      continue;
    }
    if (raw.startsWith("-")) {
      lines.push({ kind: "del", lnOld: oldLine, text: raw.slice(1) });
      oldLine += 1;
      oldRemaining -= 1;
      del += 1;
      continue;
    }
    if (raw.startsWith(" ")) {
      lines.push({ kind: "context", lnOld: oldLine, ln: newLine, text: raw.slice(1) });
      oldLine += 1;
      newLine += 1;
      oldRemaining -= 1;
      newRemaining -= 1;
      continue;
    }
    // Anything else ends the body: git writes only " ", "+", "-" and "\" rows
    // inside a hunk, so the next file's header or any other row closes it.
    closeHunk();
  }
  closeHunk();

  return { lines, add, del, partial: truncated || (diffText.includes("@@ ") && !sawHunk) };
}

function statusFromDiffText(diffText: string): DiffFileStatus {
  if (/^rename from /m.test(diffText) || /^rename to /m.test(diffText)) return "renamed";
  if (/^new file mode /m.test(diffText) || /^--- \/dev\/null$/m.test(diffText)) return "added";
  if (/^deleted file mode /m.test(diffText) || /^\+\+\+ \/dev\/null$/m.test(diffText)) return "deleted";
  return "modified";
}

function pathFromDiffText(diffText: string): string {
  const git = GIT_HEADER_RE.exec(diffText);
  if (git) {
    const newPath = headerPath(git[3], git[4]);
    if (newPath) return newPath;
  }
  const rename = RENAME_TO_RE.exec(diffText);
  const renamed = rename ? headerPath(rename[1], rename[2]) : undefined;
  if (renamed) return renamed;
  const plus = PLUS_HEADER_RE.exec(diffText);
  const added = plus ? headerPath(plus[1], plus[2]) : undefined;
  if (added && added !== "/dev/null") return added;
  const minus = MINUS_HEADER_RE.exec(diffText);
  const removed = minus ? headerPath(minus[1], minus[2]) : undefined;
  if (removed && removed !== "/dev/null") return removed;
  return "";
}

function oldPathFrom(diffText: string): string | undefined {
  const rename = RENAME_FROM_RE.exec(diffText);
  const renamed = rename ? headerPath(rename[1], rename[2]) : undefined;
  if (renamed) return renamed;
  const minus = MINUS_HEADER_RE.exec(diffText);
  const header = minus ? headerPath(minus[1], minus[2]) : undefined;
  return header && header !== "/dev/null" ? header : undefined;
}

function modeChangesFrom(diffText: string): string[] {
  return patchRows(diffText)
    .filter((line) =>
      /^(old mode|new mode|deleted file mode|new file mode|similarity index|dissimilarity index) /.test(line),
    );
}

/** Overrides for {@link parseUnifiedFile} when metadata is known out of band. */
export type ParseUnifiedFileOverrides = {
  /** Force the file path instead of reading it from the patch headers. */
  path?: string;
  /** Force the status instead of inferring it from the patch headers. */
  status?: DiffFileStatus;
  /** Mark the file binary regardless of markers (skips hunk parsing). */
  isBinary?: boolean;
  /** Byte size for the binary placeholder. */
  sizeBytes?: number;
};

/**
 * Parse one file's unified patch into a `DiffFile`: path, add/del totals,
 * per-line numbering, status, rename `oldPath`, and any mode-change lines.
 * Binary patches (or an explicit `isBinary` override) skip hunk parsing and
 * render a placeholder instead of lines.
 */
export function parseUnifiedFile(diffText: string, overrides: ParseUnifiedFileOverrides = {}): DiffFile {
  const path = (overrides.path ?? pathFromDiffText(diffText)).trim();
  const binary = overrides.isBinary === true || BINARY_PATCH_RE.test(diffText);
  const parsed = binary ? { lines: [], add: 0, del: 0, partial: false } : parseHunks(diffText);
  const oldPath = oldPathFrom(diffText);
  const modeChanges = modeChangesFrom(diffText);
  return {
    path,
    add: parsed.add,
    del: parsed.del,
    lines: parsed.lines,
    status: overrides.status ?? statusFromDiffText(diffText),
    ...(binary ? { isBinary: true } : {}),
    ...(typeof overrides.sizeBytes === "number" ? { sizeBytes: overrides.sizeBytes } : {}),
    ...(oldPath && oldPath !== path ? { oldPath } : {}),
    ...(modeChanges.length > 0 ? { modeChanges } : {}),
    ...(parsed.partial ? { partial: true } : {}),
  };
}
