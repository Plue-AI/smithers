import type { ChangedFile } from "./changedFileSchema.ts";

/** One-line description of a change, used when no narrator wrote a better one. */
export function describeChange(file: ChangedFile): string {
  return `${file.status} (+${file.insertions} −${file.deletions})`;
}
