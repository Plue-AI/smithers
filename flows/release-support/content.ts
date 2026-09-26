import { createHash } from "node:crypto"
import type { Analysis, ContentInput, Draft, Evidence, Review } from "./schema.ts"

export const digest = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex")

/** Replace only this release's narrative; preserve its mechanical commit block. */
export const changelogNarrative = (text: string, version: string, date: string, narrative: string): string => {
  const lines = text.split("\n")
  const start = lines.findIndex((line) => line.startsWith(`## ${version} (`))
  const releaseHeading = /^## \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)? \(/
  const first = lines.findIndex((line) => releaseHeading.test(line))
  const heading = `## ${version} (${date})`
  if (start < 0) {
    const at = first < 0 ? lines.length : first
    return [...lines.slice(0, at), heading, "", narrative.trim(), "", ...lines.slice(at)].join("\n")
  }
  let end = lines.findIndex((line, index) => index > start && releaseHeading.test(line))
  if (end < 0) end = lines.length
  const marker = lines.findIndex((line, index) => index > start && index < end && line === `<!-- commits:${version} -->`)
  return [...lines.slice(0, start + 1), "", narrative.trim(), "", ...lines.slice(marker < 0 ? end : marker)].join("\n")
}

/** Validate the ledger, enabled channels and limits independently of the model. */
export const checkContent = (
  input: ContentInput, evidence: Evidence, analysis: Analysis, draft: Draft, review: Review
): Review => {
  const failures: Array<string> = []
  const sources = new Set(evidence.sources)
  const claims = new Map<string, Analysis["claims"][number]>()
  for (const claim of analysis.claims) {
    if (!claim.id || claims.has(claim.id)) failures.push(`Duplicate or empty claim ID: ${claim.id}`)
    claims.set(claim.id, claim)
    if (!claim.text.trim() || !claim.sources.length || claim.sources.some((source) => !sources.has(source))) {
      failures.push(`Claim ${claim.id} has no verifiable evidence source`)
    }
  }
  const checkCopy = (name: string, enabled: boolean, copy: Draft["changelog"]) => {
    if (!enabled) {
      if (copy.text || copy.claimIds.length) failures.push(`${name} is disabled but contains content`)
      return
    }
    if (!copy.text.trim()) failures.push(`${name} is empty`)
    if (!copy.claimIds.length) failures.push(`${name} has no claim references`)
    for (const id of copy.claimIds) if (!claims.has(id)) failures.push(`${name} cites unknown claim ${id}`)
    for (const phrase of ["game-changing", "revolutionary", "seamless", "unlock the future", "10x", "guaranteed"]) {
      if (copy.text.toLowerCase().includes(phrase)) failures.push(`${name} contains unsupported promotional language: ${phrase}`)
    }
  }
  checkCopy("changelog", input.channels.changelog, draft.changelog)
  checkCopy("blog", input.channels.blog, draft.blog)
  if (input.channels.thread) {
    if (!draft.thread.tweets.length || draft.thread.tweets.length > input.maxTweets) failures.push("Thread length is outside the configured limit")
    draft.thread.tweets.forEach((tweet, index) => {
      checkCopy(`tweet ${index + 1}`, true, tweet)
      // Conservative weighted length: non-ASCII code points cost two, URLs
      // cost at least 23. This can reject a borderline valid tweet, but cannot
      // silently treat an emoji-heavy draft as fitting the configured limit.
      const withoutUrls = tweet.text.replace(/https?:\/\/\S+/g, (url) => "x".repeat(Math.max(23, url.length)))
      const length = [...withoutUrls].reduce((count, point) => count + (point.codePointAt(0)! > 0x7f ? 2 : 1), 0)
      if (length > input.maxTweetChars) failures.push(`Tweet ${index + 1} exceeds ${input.maxTweetChars} characters`)
    })
  } else if (draft.thread.tweets.length) failures.push("Thread is disabled but contains tweets")
  if (!Number.isFinite(review.score) || review.score < 0 || review.score > 1) failures.push("Reviewer score must be between 0 and 1")
  if (!review.passed || review.score < input.minScore) failures.push(`Reviewer score ${review.score} did not pass ${input.minScore}`)
  return { passed: failures.length === 0, score: review.score, feedback: [...failures, ...review.feedback] }
}

const xml = (text: string) => text.replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"
})[char]!)

/** Native SVG cards, as in the old release-content workflow. No image service. */
export const renderCard = (version: string, analysis: Analysis): string => {
  const lines = [analysis.title, ...analysis.highlights.slice(0, 4)].flatMap((line) => {
    const words = line.split(/\s+/)
    const wrapped: Array<string> = []
    for (const word of words) {
      if (!wrapped.length || wrapped.at(-1)!.length + word.length > 66) wrapped.push(word)
      else wrapped[wrapped.length - 1] += ` ${word}`
    }
    return wrapped.slice(0, 2)
  }).slice(0, 8)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">
<rect width="1600" height="900" fill="#111827"/>
<text x="96" y="130" fill="#5eead4" font-family="sans-serif" font-size="36">SMITHERS ${xml(version)}</text>
${lines.map((line, index) => `<text x="96" y="${250 + index * 66}" fill="#f9fafb" font-family="sans-serif" font-size="34">${xml(line)}</text>`).join("\n")}
<text x="96" y="830" fill="#9ca3af" font-family="sans-serif" font-size="28">smithers.sh</text>
</svg>\n`
}
