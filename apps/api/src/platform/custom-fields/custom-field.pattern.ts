import RE2 from 're2';

/**
 * An administrator's `validation.pattern`, compiled and run by RE2 (the `re2`
 * package: Google's engine, prebuilt for the platforms the API runs on) and
 * never by V8's `RegExp`.
 *
 * Why not `RegExp`: the pattern is written by an administrator and run, in
 * the request, on every value every user writes. V8 backtracks, so a pattern
 * such as `(a|a)*b`, `(a|aa)+$` or `.*.*.*.*x` takes exponential or
 * polynomial time on a crafted value and blocks the event loop for everyone,
 * and no check of the pattern's text catches every such shape (CodeQL
 * js/regex-injection). RE2 matches in time linear in the value's length by
 * construction. What it leaves out is exactly what needs backtracking:
 * backreferences (`\1`, `\k<name>`) and lookaround (`(?=`, `(?!`, `(?<=`,
 * `(?<!`); it also caps a repetition count at 1,000. Those patterns are
 * refused when the administrator saves them, by the same compile that runs
 * them on values, so a pattern that saves always runs.
 *
 * Syntax: https://github.com/google/re2/wiki/Syntax. RE2 always works in
 * unicode mode (code points, `\p{L}`), as the `u` flag did before.
 */
export interface CompiledPattern {
  /** Whether the whole value matches. */
  test(value: string): boolean;
}

/** The pattern anchored: the whole value must match, not a part of it. */
const anchored = (pattern: string) => `^(?:${pattern})$`;

/**
 * Compiles a pattern for the values, or throws a `SyntaxError` with RE2's
 * reason (see `patternProblem` for the administrator's message).
 */
export function compilePattern(pattern: string): CompiledPattern {
  const compiled = new RE2(anchored(pattern), 'u');
  return {
    // RE2 without the `g` flag ignores lastIndex, like RegExp.
    test: (value) => compiled.test(value),
  };
}

/** `null` when the pattern compiles; otherwise why not, for the administrator. */
export function patternProblem(pattern: string): string | null {
  try {
    compilePattern(pattern);
    return null;
  } catch (error) {
    // RE2's messages: `<reason>: <the fragment it stopped at>`.
    const message = error instanceof Error ? error.message : String(error);
    const reason = message.split(':')[0]!.trim();
    const fragment = message.slice(reason.length + 1).trim();
    if (reason === 'invalid perl operator' && fragment.startsWith('(?')) {
      return 'Lookahead and lookbehind ((?=, (?!, (?<=, (?<!) are not supported: rewrite the pattern without them.';
    }
    if (reason === 'invalid escape sequence' && /^\\([1-9]|k)/.test(fragment)) {
      return 'Backreferences (\\1, \\k<name>) are not supported: rewrite the pattern without them.';
    }
    if (reason === 'invalid repetition size') {
      return 'A repetition count is at most 1,000.';
    }
    return `Not a valid regular expression (${reason}).`;
  }
}
