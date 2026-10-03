// Shared test-path classification for review prompts and walkthrough ordering.
const testDirPattern = /(^|\/)(tests?|__tests__|e2e|spec)\//
const testNamePattern = /(\.(test|spec|e2e)\.[^/]+|_test\.[^/]+|_spec\.[^/]+)$/

/** Whether a repository path names a test file, by directory or by filename. */
export function isTestPath(path: string): boolean {
  const lower = path.toLowerCase()
  const name = lower.split("/").pop() ?? lower
  return testDirPattern.test(lower) || testNamePattern.test(name)
}
