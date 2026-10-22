// Reading and merging env files, as plain text: the merge keeps the
// template's comments, order and unknown keys, and touches only the lines of
// the keys it is given. Pure (no I/O); tools/setup/setup.mjs reads and writes,
// tools/setup/envcheck.mjs (pnpm env:check) compares.
//
// A "KEY=value" line is active; "# KEY=value" (a value with no spaces) is the
// template's commented example, which setting the key uncomments.

const KEY = '[A-Z][A-Z0-9_]*';

/** Where each target's template is and its file goes, relative to the repository root. */
export const TARGETS = {
  development: {
    template: 'apps/api/env.development.example',
    file: 'apps/api/.env.development',
  },
  production: { template: 'env.example', file: '.env' },
};

/**
 * A commented example: `# KEY=value`, the value with no spaces and not
 * ending like a sentence (`# APP_ENV=loadtest.` is prose that mentions one).
 */
const EXAMPLE = new RegExp(`^#\\s?(${KEY})=(?:|\\S*[^\\s.,;:)])$`);
const ACTIVE = new RegExp(`^(${KEY})=`);

/** The variable a line names, as an active line or a commented example (prose that merely mentions `KEY=` names nothing). */
const nameOf = (line) => (line.match(ACTIVE) ?? line.match(EXAMPLE))?.[1];

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
  return withoutComment(text);
}

const isSpace = (char) => /\s/.test(char);

/**
 * `text` up to its inline comment: from the whitespace before the first `#`
 * that follows whitespace, past the text's last line break (where
 * `/\s+#.*$/` would cut). A loop, not that regex: it scans a long run of
 * spaces again from each of its positions, quadratic (SonarCloud S8786).
 */
function withoutComment(text) {
  const lineBreak = Math.max(
    ...['\n', '\r', '\u2028', '\u2029'].map((end) => text.lastIndexOf(end)),
  );
  for (
    let hash = text.indexOf('#', lineBreak + 1);
    hash !== -1;
    hash = text.indexOf('#', hash + 1)
  ) {
    if (hash > 0 && isSpace(text[hash - 1])) {
      let start = hash - 1;
      while (start > 0 && isSpace(text[start - 1])) start--;
      return text.slice(0, start);
    }
  }
  return text;
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
    const name = nameOf(line);
    if (name) keys.add(name);
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
    const commented = new RegExp(`^#\\s?${key}=(?:|\\S*[^\\s.,;:)])$`);
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

/** The active `KEY=value` lines' names, in order, one per line (a repeated name repeats). */
function activeNames(text) {
  const names = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(new RegExp(`^(${KEY})=`));
    if (m) names.push(m[1]);
  }
  return names;
}

/** The names that have more than one active line (parseEnv reads the first; the readers of a real file may not agree). */
export function duplicateKeys(text) {
  const seen = new Set();
  const repeated = new Set();
  for (const name of activeNames(text)) {
    if (seen.has(name)) repeated.add(name);
    seen.add(name);
  }
  return [...repeated];
}

/** The active variables of `templateText`, in order: { key, index (its line), block (the `# feature:<name>` it is in, or null) }. */
function templateVariables(templateText) {
  const variables = [];
  let block = null;
  templateText.split('\n').forEach((line, index) => {
    const feature = line.match(/^# feature:(\S+) (begin|end)$/);
    if (feature) block = feature[2] === 'begin' ? feature[1] : null;
    const m = line.match(new RegExp(`^(${KEY})=`));
    if (m) variables.push({ key: m[1], index, block });
  });
  return variables;
}

/**
 * The template's active variables a file does not name at all (neither an
 * active line nor a commented example: a commented one is the file's choice,
 * and in view), in the template's order. A variable inside a
 * `# feature:<name>` block is left out when the file has no such block
 * (feature:remove took it out).
 */
export function missingKeys(templateText, fileText) {
  const named = templateKeys(fileText);
  return templateVariables(templateText).filter(
    ({ key, block }) =>
      !named.has(key) &&
      (block === null || fileText.includes(`# feature:${block} begin`)),
  );
}

/** The active variables of `fileText` that `templateText` does not name (active or commented). */
export function unknownKeys(templateText, fileText) {
  const known = templateKeys(templateText);
  return [...new Set(activeNames(fileText))].filter((key) => !known.has(key));
}

const MARKER = /^# feature:\S+ (begin|end)$/;

/** Whether a template line is explanatory prose: a comment that is neither a commented example nor a feature marker. */
const isProse = (line) =>
  line.startsWith('#') && !EXAMPLE.test(line) && !MARKER.test(line);

/**
 * Where the template's text for the variable on line `index` starts: its own
 * comment (the prose right above it), and the blank line before that when
 * the template starts a paragraph there.
 */
function chunkStart(tpl, index) {
  let start = index;
  while (start > 0 && isProse(tpl[start - 1])) start--;
  return start > 0 && tpl[start - 1] === '' ? start - 1 : start;
}

/**
 * `text` with every template variable it lacks added, with the template's
 * default and comment: right after the nearest variable before it in the
 * template that the file has (so it sits where the template puts it), else
 * at the end under a heading. Nothing else changes: the file's values,
 * comments, order and unknown lines stay. Returns { text, added: [{ key,
 * value }] } (the value is the template's default).
 */
export function mergeTemplate(text, templateText) {
  const missing = missingKeys(templateText, text);
  if (!missing.length) return { text, added: [] };

  const tpl = templateText.split('\n');
  const lines = text.split('\n');
  // Where each name the file has sits (an active line before a commented one).
  const at = new Map();
  lines.forEach((line, i) => {
    const name = nameOf(line);
    if (!name) return;
    const active = !line.startsWith('#');
    if (!at.has(name) || (active && !at.get(name).active)) {
      at.set(name, { i, active });
    }
  });
  // The variable before `index` in the template that the file has: its line
  // in the file and in the template (-1: none).
  const anchorOf = (index) => {
    for (let j = index - 1; j >= 0; j--) {
      const name = nameOf(tpl[j]);
      if (name && at.has(name)) return { file: at.get(name).i, own: j };
    }
    return { file: -1, own: -1 };
  };

  // Group by anchor: variables with no file variable between them in the
  // template arrive together, in order.
  const groups = new Map();
  const added = [];
  for (const { key, index } of missing) {
    const start = chunkStart(tpl, index);
    const { file, own } = anchorOf(index);
    const group = groups.get(file) ?? { own, start, chunk: [] };
    group.chunk.push(...tpl.slice(start, index + 1));
    groups.set(file, group);
    added.push({
      key,
      value: parseValue(tpl[index].slice(key.length + 1)),
    });
  }
  // From the end, so the earlier positions stay valid.
  for (const anchor of [...groups.keys()].sort((x, y) => y - x)) {
    const { own, start, chunk } = groups.get(anchor);
    if (anchor < 0) {
      if (lines.at(-1) === '') lines.pop();
      lines.push('', '# New in the template (added by pnpm setup)');
      lines.push(...(chunk[0] === '' ? chunk.slice(1) : chunk), '');
      continue;
    }
    // After the anchor, and past the lines the file shares with the template
    // up to where the new text starts (the anchor's own trailing comment).
    let place = anchor;
    for (let j = own; j + 1 < start && lines[place + 1] === tpl[j + 1]; j++) {
      place++;
    }
    lines.splice(place + 1, 0, ...chunk);
  }
  return { text: lines.join('\n'), added };
}

/** `text` without the `# feature:<name> begin … end` blocks (as feature:remove does). */
export function stripFeatureBlocks(text, name) {
  const block = new RegExp(
    `^# feature:${name} begin\\n[\\s\\S]*?^# feature:${name} end\\n`,
    'gm',
  );
  return text.replace(block, '').replace(/\n\n\n+/g, '\n\n');
}
