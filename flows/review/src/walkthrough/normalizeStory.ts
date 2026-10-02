import type { ChangedFile } from "./changedFileSchema.ts";
import { describeChange } from "./describeChange.ts";
import { fallbackStory } from "./fallbackStory.ts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Story, type StoryBlock, type StoryChapter } from "./storySchema.ts";

const decodeStory = Schema.decodeUnknownOption(Story);

function cleanBlock(block: StoryBlock, known: Set<string>, seen: Set<string>): StoryBlock | null {
  if (block.kind === "diff") {
    const path = block.path.trim();
    if (!known.has(path) || seen.has(path)) return null;
    seen.add(path);
    return { ...block, path, intro: block.intro.trim() };
  }
  if (block.kind === "diagram") {
    if (!block.mermaid.trim()) return null;
    return { ...block, title: block.title.trim(), mermaid: block.mermaid.trim() };
  }
  // Anything unrecognized degrades to prose so narrator text is never lost.
  if (!block.text.trim()) return null;
  return { kind: "prose", text: block.text.trim(), path: "", intro: "", title: "", mermaid: "" };
}

/**
 * Repair a narrator story before rendering. Invariant afterwards: every
 * changed file appears in exactly one diff block, and every diff block points
 * at a real changed file. Unknown paths are dropped, duplicate diff blocks
 * keep their first position, empty prose/diagram blocks are dropped, files
 * the narrator missed land in a final "Everything else" chapter, and an
 * unusable story falls back to the deterministic one.
 */
export function normalizeStory(candidate: unknown, files: ChangedFile[]): Story {
  const fallback = fallbackStory(files);
  const parsed = decodeStory(candidate ?? {});
  if (Option.isNone(parsed)) return fallback;

  const known = new Set(files.map((file) => file.path));
  const seen = new Set<string>();
  const chapters: StoryChapter[] = [];
  for (const raw of parsed.value.chapters) {
    const blocks = raw.blocks
      .map((block) => cleanBlock(block, known, seen))
      .filter((block): block is StoryBlock => block !== null);
    if (blocks.length === 0) continue;
    chapters.push({ title: raw.title.trim() || `Chapter ${chapters.length + 1}`, blocks });
  }
  if (chapters.length === 0 || seen.size === 0) return fallback;

  const missing = files.filter((file) => !seen.has(file.path));
  if (missing.length > 0) {
    chapters.push({
      title: "Everything else",
      blocks: [
        { kind: "prose", text: "Changes the story above did not cover.", path: "", intro: "", title: "", mermaid: "" },
        ...missing.map((file) => ({
          kind: "diff",
          path: file.path,
          intro: describeChange(file),
          text: "",
          title: "",
          mermaid: "",
        })),
      ],
    });
  }

  return {
    headline: parsed.value.headline.trim() || fallback.headline,
    synopsis: parsed.value.synopsis.trim() || fallback.synopsis,
    chapters,
  };
}
