/**
 * A code fence long enough that untrusted content cannot break out of it: one
 * backtick more than the longest backtick run in the content, minimum three.
 *
 * Both threats depend on this: in agent prompts a short fence lets PR code close
 * the fence early and inject instructions; in GitHub PR bodies it lets the same
 * code escape a ```suggestion block and forge markdown. GFM treats longer
 * fences as valid, including for suggestion blocks, so widening is always safe.
 */
export function fenceFor(content: string): string {
  let longest = 0;
  for (const match of content.matchAll(/`+/g)) {
    longest = Math.max(longest, match[0].length);
  }
  return "`".repeat(Math.max(longest + 1, 3));
}
