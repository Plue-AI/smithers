import { Data } from "effect"
/** Invalid metadata is not an unversioned store and must never be guessed. */
export class InvalidSchemaStampError extends Data.TaggedError("InvalidSchemaStampError")<{
  readonly source: string
  readonly message: string
}> {
  constructor(source: string) {
    super({
      source,
      message: `${source} has an invalid schema version. Its stored state was not upgraded; use a compatible build or recover the original data.`
    })
  }
}

/** Missing stamps are legacy/unversioned; present stamps must be safe nonnegative integers. */
export const parseSchemaStamp = (value: unknown, source: string): number | undefined => {
  if (value === undefined) return undefined
  if ((typeof value !== "string" && typeof value !== "number") || !/^\d+$/.test(String(value))) {
    throw new InvalidSchemaStampError(source)
  }
  const version = Number(value)
  if (!Number.isSafeInteger(version) || version < 0) throw new InvalidSchemaStampError(source)
  return version
}
