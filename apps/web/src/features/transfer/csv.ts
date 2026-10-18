/**
 * The rows of an import's error report (`errorsUrl`): a CSV with the header
 * `row,field,message`, UTF-8 with a byte-order mark, fields quoted when
 * needed. Custom code: three text columns do not justify a dependency.
 */
export interface RowError {
  row: string;
  field: string;
  message: string;
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const source = text.replace(/^﻿/, '');
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function parseRowErrors(text: string): RowError[] {
  return parseCsv(text)
    .slice(1)
    .filter((cells) => cells.some((cell) => cell !== ''))
    .map(([row = '', field = '', message = '']) => ({ row, field, message }));
}
