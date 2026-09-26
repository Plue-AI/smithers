/** Review a curated view; retain and hash the complete source in the artifact. */
import { type Evidence, WikiError } from "./schema.ts"

export const visibleLine = (evidence: Evidence, path: string, line: number) => {
  const ranges = evidence.spec.excerpts?.[path]
  return !ranges || ranges.some(({ start, end }) => line >= start && line <= end)
}

export const reviewEvidence = (evidence: Evidence) => {
  for (const [path, ranges] of Object.entries(evidence.spec.excerpts ?? {})) {
    const source = evidence.sources.find((source) => source.path === path)
    if (
      !source || !ranges.length ||
      ranges.some(({ start, end }) => start < 1 || end < start || end > source.text.split("\n").length)
    ) {
      throw new WikiError({ code: "invalid-input", message: `Invalid review excerpt: ${evidence.spec.id}/${path}` })
    }
  }
  const sources = evidence.sources.map((source) => ({
    path: source.path,
    complete: !evidence.spec.excerpts?.[source.path],
    lines: source.text.split("\n").flatMap((text, index) =>
      visibleLine(evidence, source.path, index + 1) ? [`${index + 1} | ${text}`] : []
    ).join("\n")
  }))
  const { id, title, purpose, kind, document } = evidence.spec
  const view = { spec: { id, title, purpose, kind, document }, sections: evidence.sections, sources }
  if (new TextEncoder().encode(JSON.stringify(view)).length > 90_000) {
    throw new WikiError({
      code: "invalid-input",
      message: `Review evidence exceeds 90000 bytes: ${evidence.spec.id}; select smaller excerpts or split the page`
    })
  }
  return view
}
