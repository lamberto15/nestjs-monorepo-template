// Reading and merging env files, as plain text: the merge keeps the
// template's comments, order and unknown keys, and touches only the lines of
// the keys it is given. Pure (no I/O); tools/setup/setup.mjs reads and writes.
//
// A "KEY=value" line is active; "# KEY=value" (a value with no spaces) is the
// template's commented example, which setting the key uncomments.

const KEY = '[A-Z][A-Z0-9_]*';

/** A value that needs quotes to read back the same in Docker Compose and dotenv. */
const NEEDS_QUOTES = /[\s#"'`$\\]/;

/** `value` as the right-hand side of a KEY=value line. */
export function formatValue(value) {
  if (value === '') return '';
  if (/[\r\n]/.test(value)) {
    throw new Error('A value cannot contain a newline.');
  }
  if (!NEEDS_QUOTES.test(value)) return value;
  // Single quotes are literal in both formats; only a value holding one
  // needs double quotes (and `$` escaped, since Compose interpolates it).
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replace(/[\\"$]/g, '\\$&')}"`;
}

/** The value of one line's right-hand side, unquoted. */
export function parseValue(raw) {
  const text = raw.trim();
  if (text.startsWith("'")) {
    const end = text.indexOf("'", 1);
    if (end > 0) return text.slice(1, end);
  }
  if (text.startsWith('"')) {
    const m = text.match(/^"((?:[^"\\]|\\.)*)"/);
    if (m) return m[1].replace(/\\(.)/g, '$1');
  }
  // Unquoted: an inline comment starts at " #".
  return text.replace(/\s+#.*$/, '');
}

/** The active `KEY=value` lines of an env file, as a Map. The first one wins. */
export function parseEnv(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(new RegExp(`^(${KEY})=(.*)$`));
    if (m && !values.has(m[1])) values.set(m[1], parseValue(m[2]));
  }
  return values;
}

/** Every key a template names: active lines and commented examples. */
export function templateKeys(text) {
  const keys = new Set();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(new RegExp(`^(?:#\\s?)?(${KEY})=(\\S*)$`));
    if (m) keys.add(m[1]);
    else {
      const active = line.match(new RegExp(`^(${KEY})=`));
      if (active) keys.add(active[1]);
    }
  }
  return keys;
}

/**
 * `text` with each key of `values` set: its active line replaced; else its
 * commented example uncommented; else (unknown to the template) appended.
 * A null value empties an active line and leaves a commented one alone.
 */
export function applyValues(text, values) {
  const lines = text.split('\n');
  const appended = [];
  for (const [key, value] of values) {
    const active = new RegExp(`^${key}=`);
    const commented = new RegExp(`^#\\s?${key}=\\S*$`);
    const right = value === null ? '' : formatValue(value);
    let at = lines.findIndex((line) => active.test(line));
    if (at >= 0) {
      // Already that value: leave the line as the template wrote it.
      const same =
        value !== null && parseValue(lines[at].slice(key.length + 1)) === value;
      if (!same) lines[at] = `${key}=${right}`;
      continue;
    }
    if (value === null) continue;
    at = lines.findIndex((line) => commented.test(line));
    if (at >= 0) lines[at] = `${key}=${right}`;
    else appended.push(`${key}=${right}`);
  }
  if (appended.length) {
    if (lines.at(-1) === '') lines.pop();
    lines.push('', '# Added by pnpm setup', ...appended, '');
  }
  return lines.join('\n');
}

/** `text` without the `# feature:<name> begin … end` blocks (as feature:remove does). */
export function stripFeatureBlocks(text, name) {
  const block = new RegExp(
    `^# feature:${name} begin\\n[\\s\\S]*?^# feature:${name} end\\n`,
    'gm',
  );
  return text.replace(block, '').replace(/\n\n\n+/g, '\n\n');
}
