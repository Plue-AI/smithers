/**
 * The narrated story a walkthrough renders.
 *
 * @since 1.0.0
 */
import * as Schema from "effect/Schema";
import { arrayOf, withDefault } from "../schema/withDefault.ts";

/**
 * One block of a chapter.
 *
 * A single permissive shape covers all three kinds, because the narrator's
 * structured output decodes loosely here and `normalizeStory` enforces the real
 * invariants. Kind `prose` uses `text`; `diff` uses `path` plus `intro`;
 * `diagram` uses `title` plus `mermaid`.
 *
 * @since 1.0.0
 * @category schemas
 */
export const StoryBlock = Schema.Struct({
  kind: withDefault(Schema.String, "prose"),
  text: withDefault(Schema.String, ""),
  path: withDefault(Schema.String, ""),
  intro: withDefault(Schema.String, ""),
  title: withDefault(Schema.String, ""),
  mermaid: withDefault(Schema.String, ""),
});

/**
 * A decoded block.
 *
 * @since 1.0.0
 * @category models
 */
export type StoryBlock = typeof StoryBlock.Type;

/**
 * One chapter of the story.
 *
 * @since 1.0.0
 * @category schemas
 */
export const StoryChapter = Schema.Struct({
  title: withDefault(Schema.String, ""),
  blocks: arrayOf(StoryBlock),
});

/**
 * A decoded chapter.
 *
 * @since 1.0.0
 * @category models
 */
export type StoryChapter = typeof StoryChapter.Type;

/**
 * The whole story.
 *
 * @since 1.0.0
 * @category schemas
 */
export const Story = Schema.Struct({
  headline: withDefault(Schema.String, ""),
  synopsis: withDefault(Schema.String, ""),
  chapters: arrayOf(StoryChapter),
});

/**
 * A decoded story.
 *
 * @since 1.0.0
 * @category models
 */
export type Story = typeof Story.Type;
