import { escapeHtml } from "../walkthrough/escapeHtml.ts";

const MAX_RENDERED_LINES = 1_500;

type FilePreamble = {
  renameFrom?: string;
  renameTo?: string;
  oldMode?: string;
  newMode?: string;
  binary: boolean;
  sawHunk: boolean;
};

// The +/− marker column duplicates the row color on purpose: color-blind
// readers get a non-color signal, and copied text keeps diff semantics.
const signOf = { add: "+", del: "−", ctx: "" } as const;

function row(kind: "add" | "del" | "ctx", oldNum: string, newNum: string, text: string): string {
  const oldAttr = oldNum ? ` data-old="${oldNum}"` : "";
  const newAttr = newNum ? ` data-new="${newNum}"` : "";
  return `<tr class="${kind}"${oldAttr}${newAttr}><td class="ln">${oldNum}</td><td class="ln">${newNum}</td><td class="sign">${signOf[kind]}</td><td class="code">${escapeHtml(text)}</td></tr>`;
}

function noteRow(text: string): string {
  return `<tr class="hunk note"><td class="ln"></td><td class="ln"></td><td class="sign"></td><td class="code">${escapeHtml(text)}</td></tr>`;
}

function preambleNote(file: FilePreamble): string | null {
  if (file.sawHunk) return null;
  if (file.binary) return "Binary files differ.";
  if (file.renameFrom && file.renameTo) return `Renamed ${file.renameFrom} to ${file.renameTo}.`;
  if (file.oldMode && file.newMode) return `Mode changed ${file.oldMode} to ${file.newMode}.`;
  return null;
}

/**
 * Display-only unified-diff renderer for the walkthrough. Rows carry
 * data-old/data-new line-number attributes so findings can anchor onto them.
 * File headers ("--- ", "+++ ", "index ", …) are only skipped OUTSIDE hunks;
 * inside a hunk a deleted line whose content starts with "-- " (rendered as
 * "--- …" in the patch) is real content and must not be dropped. A
 * "diff --git " line resets to preamble state so multi-file patches parse.
 */
export function renderFallbackDiffHtml(diffText: string): string {
  if (!diffText.trim()) return `<p class="diff-note">No textual diff (binary or empty change).</p>`;
  const rows: string[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let file: FilePreamble = { binary: false, sawHunk: false };
  let rendered = 0;
  let truncatedAt = -1;
  const lines = (diffText.endsWith("\n") ? diffText.slice(0, -1) : diffText).split("\n");
  const flushFileNote = () => {
    const note = preambleNote(file);
    if (note) rows.push(noteRow(note));
  };
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (rendered >= MAX_RENDERED_LINES) {
      truncatedAt = i;
      break;
    }
    if (line.startsWith("diff --git ")) {
      flushFileNote();
      file = { binary: false, sawHunk: false };
      inHunk = false;
      oldLine = 0;
      newLine = 0;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunk) {
      inHunk = true;
      file.sawHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push(
        `<tr class="hunk"><td class="ln"></td><td class="ln"></td><td class="sign"></td><td class="code">@@ −${hunk[1]} +${hunk[2]} @@${escapeHtml(hunk[3]!)}</td></tr>`,
      );
      rendered += 1;
      continue;
    }
    if (!inHunk) {
      if (line.startsWith("rename from ")) file.renameFrom = line.slice("rename from ".length);
      else if (line.startsWith("rename to ")) file.renameTo = line.slice("rename to ".length);
      else if (line.startsWith("old mode ")) file.oldMode = line.slice("old mode ".length);
      else if (line.startsWith("new mode ")) file.newMode = line.slice("new mode ".length);
      else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) file.binary = true;
      continue;
    }
    if (line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      rows.push(row("add", "", String(newLine), line.slice(1)));
      newLine += 1;
    } else if (line.startsWith("-")) {
      rows.push(row("del", String(oldLine), "", line.slice(1)));
      oldLine += 1;
    } else {
      rows.push(row("ctx", String(oldLine), String(newLine), line.startsWith(" ") ? line.slice(1) : line));
      oldLine += 1;
      newLine += 1;
    }
    rendered += 1;
  }
  if (truncatedAt >= 0) {
    const remaining = lines.length - truncatedAt;
    rows.push(
      `<tr class="hunk"><td class="ln"></td><td class="ln"></td><td class="sign"></td><td class="code">… diff truncated (${remaining} more line(s))</td></tr>`,
    );
  } else {
    flushFileNote();
  }
  if (rows.length === 0) return `<p class="diff-note">No renderable diff content.</p>`;
  return `<table class="diff"><tbody>${rows.join("")}</tbody></table>`;
}
