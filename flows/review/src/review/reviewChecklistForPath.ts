import { isTestPath } from "../text/isTestPath.ts";

const defaultReviewChecklist = [
  "Correctness: check logic, missing boundary conditions, error handling, and concurrency safety.",
  "Security: check injection, XSS, permission checks, and sensitive data handling.",
  "Performance: check obvious inefficient loops, N+1 access patterns, and resource cleanup.",
  "Maintainability: check clarity, names, local architecture fit, and test coverage for critical paths.",
].join("\n");

const tsJsReviewChecklist = [
  "TypeScript/JavaScript: check strict null handling, async error handling, hook rules, render side effects, equality operators, and unsafe dynamic execution.",
  "React: check state ownership, effect cleanup/dependencies, memoization only where justified, and safe rendering of user input.",
].join("\n");

const jsonYamlReviewChecklist = [
  "Structured config: check required fields, schema compatibility, duplicate keys, invalid value types, and accidental secrets.",
].join("\n");

const testFileReviewChecklist = [
  "Test quality: check for assertions that can never fail (tautologies, asserting on the value just assigned, expect inside never-taken branches).",
  "Coverage honesty: check for missing negative cases and error-path coverage for the behavior the test claims to verify.",
  "Mock fidelity: flag mock-heavy tests that mock the very thing they claim to test; the subject under test must run for real.",
  "Flakiness: check for time, ordering, shared-state, or concurrency dependence that makes the test pass or fail nondeterministically.",
].join("\n");
/**
 * The review checklist for one path: test quality for tests, language extras
 * for TypeScript/JavaScript and structured config, the default otherwise.
 */
export function reviewChecklistForPath(path: string) {
  const lower = path.toLowerCase();
  if (isTestPath(path)) {
    return testFileReviewChecklist;
  }
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(lower)) {
    return `${defaultReviewChecklist}\n${tsJsReviewChecklist}`;
  }
  if (lower.endsWith("package.json") || /\.(json|json5|ya?ml|toml)$/.test(lower)) {
    return `${defaultReviewChecklist}\n${jsonYamlReviewChecklist}`;
  }
  return defaultReviewChecklist;
}
