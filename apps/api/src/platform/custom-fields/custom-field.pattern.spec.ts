import { compilePattern, patternProblem } from './custom-field.pattern.js';
import { definitionIssues, valueSchema } from './custom-field.values.js';
import { createCustomFieldSchema } from './custom-field.schemas.js';

/**
 * Patterns that make a backtracking engine (V8's RegExp) take exponential or
 * polynomial time on a value of this shape: on RE2 each runs in linear time.
 */
const CATASTROPHIC: [pattern: string, value: string][] = [
  ['(a|a)*b', 'a'.repeat(10_000)],
  ['(a|aa)+$', `${'a'.repeat(10_000)}!`],
  ['.*.*.*.*x', 'a'.repeat(10_000)],
  ['(a+)+$', `${'a'.repeat(10_000)}!`],
  ['(\\w*)*', `${'a'.repeat(10_000)}!`],
  ['(a|b+){2,}', `${'ab'.repeat(5_000)}!`],
  ['(\\d+)*\\.', `${'1'.repeat(10_000)}x`],
];

/** A text field holding this pattern, checked as the service checks values. */
const textField = (pattern: string) =>
  valueSchema({ type: 'longText', options: null, validation: { pattern } });

describe('custom-field patterns (RE2)', () => {
  it('finishes catastrophic backtracking patterns in linear time', () => {
    for (const [pattern, value] of CATASTROPHIC) {
      const started = performance.now();
      const result = textField(pattern).safeParse(value);
      const elapsed = performance.now() - started;
      // A backtracking engine would take longer than the universe's age on
      // these; a generous bound keeps a slow CI runner green.
      expect(elapsed, pattern).toBeLessThan(1_000);
      expect(result.success, pattern).toBe(false);
    }
  });

  it('matches the whole value, in unicode mode', () => {
    const code = compilePattern('[A-Z]{3}-\\d{4}');
    expect(code.test('ABC-1234')).toBe(true);
    expect(code.test('xABC-1234')).toBe(false);
    expect(code.test('ABC-1234\n')).toBe(false);
    expect(code.test('abc-1234')).toBe(false);
    // Repeated tests: no `g` flag, so no lastIndex to carry over.
    expect(code.test('ABC-1234')).toBe(true);
    expect(compilePattern('\\p{L}+').test('héllo')).toBe(true);
    expect(compilePattern('.').test('😀')).toBe(true);
    expect(compilePattern('\\u00e9').test('é')).toBe(true);
  });

  it('accepts what RE2 runs, nested quantifiers included', () => {
    for (const pattern of [
      '(a+)+$',
      '(\\w*)*',
      '(a|b+){2,}',
      '[A-Z]{3}-\\d{4}',
      '\\w+@\\w+\\.\\w+',
      '(?i)abc',
      '(?P<area>\\d{3})-\\d{4}',
      'a{1000}',
    ]) {
      expect(patternProblem(pattern), pattern).toBeNull();
    }
  });

  it('refuses lookaround and backreferences with a message that says so', () => {
    for (const pattern of ['(?=a)b', '(?!a)b', '(?<=a)b', '(?<!a)b']) {
      expect(patternProblem(pattern), pattern).toMatch(
        /^Lookahead and lookbehind/,
      );
    }
    for (const pattern of ['(a)\\1', '(?<n>a)\\k<n>', '(cat|dog)\\1']) {
      expect(patternProblem(pattern), pattern).toMatch(/^Backreferences/);
    }
  });

  it('refuses repetition counts above 1,000 and syntax errors', () => {
    expect(patternProblem('a{1001}')).toBe(
      'A repetition count is at most 1,000.',
    );
    expect(patternProblem('((a{100}){100}){100}')).toBe(
      'A repetition count is at most 1,000.',
    );
    expect(patternProblem('(')).toBe(
      'Not a valid regular expression (missing )).',
    );
    expect(patternProblem('[')).toBe(
      'Not a valid regular expression (missing ]).',
    );
    expect(patternProblem('a++')).toBe(
      'Not a valid regular expression (bad repetition operator).',
    );
  });

  it('refuses every value of a field whose stored pattern RE2 cannot run, without throwing', () => {
    // Saved before RE2 (RegExp accepted lookahead): a 500 on every write of
    // the subject would follow if building the schema threw.
    const schema = textField('(?=a)a');
    const result = schema.safeParse('a');
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/no longer supported/);
  });

  it('refuses the same patterns at save time, on the body and on the definition', () => {
    for (const pattern of ['(?=a)b', '(a)\\1', 'a{1001}', '(']) {
      const body = createCustomFieldSchema.safeParse({
        subject: 'Note',
        key: 'code',
        label: 'Code',
        type: 'text',
        validation: { pattern },
      });
      expect(body.success, pattern).toBe(false);
      expect(
        body.error?.issues.map((issue) => issue.path.join('.')),
        pattern,
      ).toEqual(['validation.pattern']);
      expect(body.error?.issues[0]?.message).toBe(patternProblem(pattern));
      expect(
        definitionIssues({
          type: 'text',
          options: null,
          validation: { pattern },
          defaultValue: null,
        }),
      ).toEqual([
        { path: 'validation.pattern', message: patternProblem(pattern) },
      ]);
    }
    // What saves, runs: the same compile on both sides.
    const saved = createCustomFieldSchema.safeParse({
      subject: 'Note',
      key: 'code',
      label: 'Code',
      type: 'text',
      validation: { pattern: '(a|aa)+$' },
    });
    expect(saved.success).toBe(true);
    expect(textField('(a|aa)+$').safeParse('aaa').success).toBe(true);
    expect(textField('(a|aa)+$').safeParse('aab').success).toBe(false);
  });
});
