/**
 * Trimming given characters off a string's ends, in linear time.
 *
 * Custom code, not a regex: `text.replace(/\/+$/, '')` (or `/-+$/`, `/0+$/`)
 * is unanchored, so on a long run of the character that does not reach the
 * end (`'/'.repeat(50_000) + 'x'`) V8 retries the run from each of its
 * positions: quadratic time, SonarCloud S8786. Neither JavaScript nor a
 * dependency of the API offers a `trimEnd(text, chars)`.
 */

/** `text` without the characters of `chars` at its end: `trimEnd('a//', '/')` is `'a'`. */
export function trimEnd(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text.charAt(end - 1))) {
    end--;
  }
  return text.slice(0, end);
}

/** `text` without the characters of `chars` at either end: `trim('-a-b-', '-')` is `'a-b'`. */
export function trim(text: string, chars: string): string {
  const end = trimEnd(text, chars);
  let start = 0;
  while (start < end.length && chars.includes(end.charAt(start))) {
    start++;
  }
  return end.slice(start);
}
