import { describe, expect, it } from 'vitest';
import { normalizedMarkdown } from './markdown-editor';

describe('normalizedMarkdown', () => {
  it('drops line ends, trailing spaces and trailing blank lines, nothing else', () => {
    expect(normalizedMarkdown('a  \nb\t\n')).toBe('a\nb');
    expect(normalizedMarkdown('a \r\nb \rc')).toBe('a\nb\nc');
    expect(normalizedMarkdown('  indented\n\n\n')).toBe('  indented');
    expect(normalizedMarkdown('a \t \u2028b \u2029c ')).toBe('a\u2028b\u2029c');
    expect(normalizedMarkdown('a  b\n \n')).toBe('a  b');
    expect(normalizedMarkdown('')).toBe('');
  });

  it('reads a pasted text of many spaces in linear time', () => {
    // The pattern it replaced (/[ \t]+$/gm) took about a second here.
    const text = `${' '.repeat(50_000)}x`;
    const started = performance.now();
    expect(normalizedMarkdown(text)).toBe(text);
    expect(performance.now() - started).toBeLessThan(250);
  });
});
