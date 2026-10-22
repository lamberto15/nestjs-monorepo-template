import { trim, trimEnd } from './trim.js';

/** How long `run` takes, in milliseconds. */
const timed = (run: () => unknown) => {
  const started = performance.now();
  run();
  return performance.now() - started;
};

// The regexes these replace take about a second on these 50,000 characters
// (quadratic); the loops take well under a millisecond. The bound leaves a
// slow CI runner room.
const QUICK_MS = 250;

describe('trimEnd', () => {
  it('drops the run of the characters at the end', () => {
    expect(trimEnd('https://app.example.com', '/')).toBe(
      'https://app.example.com',
    );
    expect(trimEnd('https://app.example.com///', '/')).toBe(
      'https://app.example.com',
    );
    expect(trimEnd('a//b//', '/')).toBe('a//b');
    expect(trimEnd('/a', '/')).toBe('/a');
    expect(trimEnd('///', '/')).toBe('');
    expect(trimEnd('', '/')).toBe('');
    expect(trimEnd('12.3400', '0')).toBe('12.34');
    expect(trimEnd('stream: OK\0\0', '\0')).toBe('stream: OK');
    // Any of several characters.
    expect(trimEnd('abc=-=', '=-')).toBe('abc');
  });

  it('stays linear on a long run that does not reach the end', () => {
    const text = `${'/'.repeat(50_000)}x`;
    expect(timed(() => trimEnd(text, '/'))).toBeLessThan(QUICK_MS);
    expect(trimEnd(text, '/')).toBe(text);
    expect(trimEnd('/'.repeat(50_000), '/')).toBe('');
  });
});

describe('trim', () => {
  it('drops the runs at both ends', () => {
    expect(trim('-acme-corp-', '-')).toBe('acme-corp');
    expect(trim('--a--b--', '-')).toBe('a--b');
    expect(trim('acme', '-')).toBe('acme');
    expect(trim('-a', '-')).toBe('a');
    expect(trim('a-', '-')).toBe('a');
    expect(trim('---', '-')).toBe('');
    expect(trim('', '-')).toBe('');
  });

  it('stays linear on a long run that does not reach the end', () => {
    const text = `x${'-'.repeat(50_000)}x`;
    expect(timed(() => trim(text, '-'))).toBeLessThan(QUICK_MS);
    expect(trim(text, '-')).toBe(text);
  });
});
