import * as Schema from "effect/Schema";
import { OpenCodeReviewInput } from "./openCodeReviewInputSchema.ts";

const decodeInput = Schema.decodeUnknownSync(OpenCodeReviewInput);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Decodes a review request, filling every field the caller omitted.
 *
 * @since 1.0.0
 * @category parsing
 */
export function normalizeOpenCodeReviewInput(value: unknown): OpenCodeReviewInput {
  const record = isPlainRecord(value) ? { ...value } : {};
  for (const key of Object.keys(record)) {
    if (record[key] === null) delete record[key];
  }
  return decodeInput(record);
}
