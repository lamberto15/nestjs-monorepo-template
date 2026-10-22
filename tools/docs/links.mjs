/** Yield inline Markdown link destinations without a backtracking-prone regex. */
export function* markdownLinks(line) {
  let offset = 0;
  while (offset < line.length) {
    const opening = line.indexOf('[', offset);
    if (opening === -1) return;
    const closing = line.indexOf(']', opening + 1);
    if (closing === -1) return;
    offset = closing + 1;
    if (line[offset] !== '(') continue;
    offset += 1;

    const hrefStart = offset;
    while (offset < line.length && line[offset] !== ')' && !/\s/.test(line[offset])) {
      offset += 1;
    }
    if (offset === hrefStart) continue;
    const href = line.slice(hrefStart, offset);
    if (line[offset] === ')') {
      offset += 1;
      yield href;
      continue;
    }

    // The only supported suffix is a whitespace-separated quoted title.
    while (offset < line.length && /\s/.test(line[offset])) offset += 1;
    const quote = line[offset];
    if (quote !== '"' && quote !== "'") continue;
    const titleEnd = line.indexOf(quote, offset + 1);
    if (titleEnd === -1) return;
    offset = titleEnd + 1;
    if (line[offset] !== ')') continue;
    offset += 1;
    yield href;
  }
}
