import { rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join, posix } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { DatabaseSync } from 'node:sqlite';
import yauzl from 'yauzl';
import { SaxesParser } from 'saxes';
import { appPath } from '../../app-dir.js';
import { createImportScratchDirectory } from './import-scratch.js';
import { FormatError } from './format-error.js';

const MAX_UNZIPPED_BYTES = 300 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 2_000;
type ZipEntry = yauzl.Entry;

function localName(name: string) {
  return name.slice(name.lastIndexOf(':') + 1);
}

function entriesOf(zip: yauzl.ZipFile): Promise<ZipEntry[]> {
  return new Promise((resolve, reject) => {
    const entries: ZipEntry[] = [];
    let settled = false;
    zip.on('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    zip.on('entry', (entry: ZipEntry) => {
      entries.push(entry);
      if (entries.length > MAX_ZIP_ENTRIES) {
        settled = true;
        reject(new FormatError('The spreadsheet is too large to import.'));
        zip.close();
        return;
      }
      zip.readEntry();
    });
    zip.on('end', () => resolve(entries));
    zip.readEntry();
  });
}

function openEntry(zip: yauzl.ZipFile, entry: ZipEntry) {
  return new Promise<Readable>((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) =>
      error ? reject(error) : resolve(stream!),
    );
  });
}

async function* xmlEvents(stream: Readable, countBytes: (n: number) => void) {
  const parser = new SaxesParser({ xmlns: false });
  const events: Array<
    | { name: string; attributes: Record<string, string> }
    | { text: string }
    | { end: string }
  > = [];
  let wake: (() => void) | undefined;
  let done = false;
  let failure: unknown;
  const decoder = new StringDecoder('utf8');
  let room: (() => void) | undefined;
  const push = (event: (typeof events)[number]) => {
    events.push(event);
    wake?.();
  };
  parser.on('opentag', (tag) =>
    push({
      name: localName(tag.name),
      attributes: tag.attributes as Record<string, string>,
    }),
  );
  parser.on('text', (text) => push({ text }));
  parser.on('cdata', (text) => push({ text }));
  parser.on('closetag', (tag) =>
    push({ end: localName(typeof tag === 'string' ? tag : tag.name) }),
  );
  parser.on('error', (error) => {
    failure = error;
    done = true;
    wake?.();
  });
  const producing = (async () => {
    try {
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        countBytes(buffer.length);
        parser.write(decoder.write(buffer));
        if (events.length > 5_000)
          await new Promise<void>((resolve) => {
            room = resolve;
          });
      }
      parser.write(decoder.end());
      parser.close();
    } catch (error) {
      failure = error;
    }
    done = true;
    wake?.();
  })();
  try {
    while (events.length || !done) {
      if (events.length) {
        yield events.shift()!;
        if (events.length < 2_500) {
          room?.();
          room = undefined;
        }
      } else
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
    }
    await producing;
    if (failure) throw failure;
  } finally {
    stream.destroy();
    room?.();
    wake?.();
    await producing;
  }
}

export function columnIndex(address: string) {
  const match = /^([A-Z]{1,3})([1-9]\d*)$/.exec(address);
  if (!match || Number(match[2]) > 1_048_576) {
    throw new FormatError('The spreadsheet has an invalid cell reference.');
  }
  let value = 0;
  for (const letter of match[1]!)
    value = value * 26 + letter.charCodeAt(0) - 64;
  if (value < 1 || value > 16_384) {
    throw new FormatError('The spreadsheet has an invalid cell reference.');
  }
  return value - 1;
}

export function cellColumnIndex(
  address: string | undefined,
  nextColumn: number,
) {
  if (address) return columnIndex(address);
  if (!Number.isInteger(nextColumn) || nextColumn < 0 || nextColumn > 16_383) {
    throw new FormatError('The spreadsheet has an invalid cell reference.');
  }
  return nextColumn;
}

export function sharedStringParser(add: (value: string) => void) {
  const parser = new SaxesParser({ xmlns: false });
  let inString = false;
  let inText = false;
  let ignoredText = 0;
  let text = '';
  parser.on('opentag', (tag) => {
    const name = localName(tag.name);
    if (name === 'si') {
      inString = true;
      text = '';
    }
    if (name === 'rPh') ignoredText++;
    if (name === 't' && inString && ignoredText === 0) inText = true;
  });
  parser.on('text', (part) => {
    if (inText && ignoredText === 0) text += part;
  });
  parser.on('cdata', (part) => {
    if (inText && ignoredText === 0) text += part;
  });
  parser.on('closetag', (tag) => {
    const name = localName(typeof tag === 'string' ? tag : tag.name);
    if (name === 't') inText = false;
    if (name === 'rPh') ignoredText--;
    if (name === 'si') {
      add(text);
      inString = false;
    }
  });
  return parser;
}

function excelDate(serial: number, date1904: boolean) {
  const adjusted = !date1904 && serial > 0 && serial < 60 ? serial + 1 : serial;
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const date = new Date(epoch + adjusted * 86_400_000);
  if (!Number.isFinite(date.getTime())) {
    throw new FormatError('The spreadsheet contains an invalid date.');
  }
  return date;
}

function isDateFormat(code: string) {
  // Repeated unmatched '[' characters make a global replacement regex scan
  // the same suffix quadratically. Each successful search below skips its
  // entire span, and a failed bracket search is never repeated.
  let noClosingBracket = false;
  let index = 0;
  while (index < code.length) {
    const character = code[index]!;
    if (character === '[' && !noClosingBracket) {
      const end = code.indexOf(']', index + 1);
      if (end !== -1) {
        index = end + 1;
        continue;
      }
      noClosingBracket = true;
    } else if (character === '"') {
      const end = code.indexOf('"', index + 1);
      if (end !== -1) {
        index = end + 1;
        continue;
      }
    } else if (
      character === '\\' &&
      index + 1 < code.length &&
      !/[\n\r\u2028\u2029]/.test(code[index + 1]!)
    ) {
      index += 2;
      continue;
    }
    if (/[ymdhMsb]/.test(character)) return true;
    index++;
  }
  return false;
}

async function readStyles(stream: Readable, count: (n: number) => void) {
  const formats = new Map<number, string>();
  const parser = new SaxesParser();
  let customId: number | undefined;
  let customCode = '';
  let xfs = false;
  const dateStyles = new Set<number>();
  let styleIndex = 0;
  parser.on('opentag', (tag) => {
    const name = localName(tag.name);
    if (name === 'numFmt') {
      customId = Number(tag.attributes.numFmtId);
      customCode = String(tag.attributes.formatCode ?? '');
    }
    if (name === 'xf' && xfs) {
      const id = Number(tag.attributes.numFmtId);
      if (
        (id >= 14 && id <= 22) ||
        (id >= 27 && id <= 36) ||
        (id >= 45 && id <= 47) ||
        (id >= 50 && id <= 58) ||
        isDateFormat(formats.get(id) ?? '')
      )
        dateStyles.add(styleIndex);
      styleIndex++;
    }
    if (name === 'cellXfs') xfs = true;
  });
  parser.on('closetag', (tag) => {
    const name = localName(typeof tag === 'string' ? tag : tag.name);
    if (name === 'numFmt' && customId !== undefined) {
      formats.set(customId, customCode);
      customId = undefined;
    }
    if (name === 'cellXfs') xfs = false;
  });
  const decoder = new StringDecoder('utf8');
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    count(buffer.length);
    parser.write(decoder.write(buffer));
  }
  parser.write(decoder.end()).close();
  return dateStyles;
}

async function entryText(
  zip: yauzl.ZipFile,
  entry: ZipEntry,
  consume: (data: string) => void,
  count: (n: number) => void,
) {
  const stream = await openEntry(zip, entry);
  const decoder = new StringDecoder('utf8');
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    count(buffer.length);
    consume(decoder.write(buffer));
  }
  consume(decoder.end());
}

/** Stream XLSX ZIP parts from disk. SQLite keeps the potentially large shared-string table off heap. */
export async function* readXlsxRecords(
  input: Readable,
  scratchDirectory?: string,
): AsyncGenerator<unknown[]> {
  const directory = await createImportScratchDirectory(
    scratchDirectory ?? appPath('.data/import-scratch'),
    'transfer-xlsx',
  );
  const path = join(directory, 'upload.xlsx');
  let zip: yauzl.ZipFile | undefined;
  let database: DatabaseSync | undefined;
  let insertString: ReturnType<DatabaseSync['prepare']> | undefined;
  let selectString: ReturnType<DatabaseSync['prepare']> | undefined;
  let sharedStringTransaction = false;
  let actualBytes = 0;
  const count = (amount: number) => {
    actualBytes += amount;
    if (actualBytes > MAX_UNZIPPED_BYTES)
      throw new FormatError('The spreadsheet is too large to import.');
  };
  try {
    database = new DatabaseSync(join(directory, 'strings.sqlite'));
    // This database is disposable and rebuilt from the workbook every read.
    // Avoid per-row journal syncs; the import archive is the durable source.
    database.exec(
      'PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA temp_store = FILE; PRAGMA cache_size = -2048',
    );
    database.exec(
      'CREATE TABLE strings (id INTEGER PRIMARY KEY, value TEXT NOT NULL)',
    );
    insertString = database.prepare('INSERT INTO strings (value) VALUES (?)');
    selectString = database.prepare('SELECT value FROM strings WHERE id = ?');
    await pipeline(input, createWriteStream(path, { flags: 'wx' }));
    zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
      yauzl.open(
        path,
        { lazyEntries: true, validateEntrySizes: true, autoClose: false },
        (error, opened) => (error ? reject(error) : resolve(opened!)),
      ),
    );
    const entries = await entriesOf(zip);
    if (
      entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0) >
      MAX_UNZIPPED_BYTES
    )
      throw new FormatError('The spreadsheet is too large to import.');
    // The central directory can lie about sizes. Decompress every member once
    // and enforce the actual aggregate before interpreting any XML.
    for (const entry of entries) {
      const stream = await openEntry(zip, entry);
      for await (const chunk of stream) count(Buffer.byteLength(chunk));
    }
    zip.close();
    zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
      yauzl.open(
        path,
        { lazyEntries: true, validateEntrySizes: true, autoClose: false },
        (error, opened) => (error ? reject(error) : resolve(opened!)),
      ),
    );
    const reopenedEntries = await entriesOf(zip);
    actualBytes = 0;
    const byName = new Map(
      reopenedEntries.map((entry) => [entry.fileName, entry]),
    );
    const shared = byName.get('xl/sharedStrings.xml');
    if (shared) {
      database.exec('BEGIN');
      sharedStringTransaction = true;
      const parser = sharedStringParser((value) => insertString!.run(value));
      await entryText(zip, shared, (chunk) => parser.write(chunk), count);
      parser.close();
      database.exec('COMMIT');
      sharedStringTransaction = false;
    }
    const workbookEntry = byName.get('xl/workbook.xml');
    let date1904 = false;
    let firstSheetRel: string | undefined;
    if (workbookEntry) {
      const parser = new SaxesParser();
      parser.on('opentag', (tag) => {
        const name = localName(tag.name);
        if (name === 'workbookPr')
          date1904 =
            tag.attributes.date1904 === '1' ||
            tag.attributes.date1904 === 'true';
        if (name === 'sheet' && firstSheetRel === undefined)
          firstSheetRel = String(
            Object.entries(tag.attributes).find(
              ([key]) => key === 'r:id' || key.endsWith(':id'),
            )?.[1] ?? '',
          );
      });
      await entryText(
        zip,
        workbookEntry,
        (chunk) => parser.write(chunk),
        count,
      );
      parser.close();
    }
    let sheetPath = 'xl/worksheets/sheet1.xml';
    const relationships = byName.get('xl/_rels/workbook.xml.rels');
    if (firstSheetRel && relationships) {
      const parser = new SaxesParser();
      let target: string | undefined;
      parser.on('opentag', (tag) => {
        if (
          localName(tag.name) === 'Relationship' &&
          tag.attributes.Id === firstSheetRel
        )
          target = String(tag.attributes.Target ?? '');
      });
      await entryText(
        zip,
        relationships,
        (chunk) => parser.write(chunk),
        count,
      );
      parser.close();
      if (target)
        sheetPath = target.startsWith('/')
          ? target.slice(1)
          : posix.normalize(posix.join('xl', target));
    }
    const stylesEntry = byName.get('xl/styles.xml');
    const dateStyles = stylesEntry
      ? await readStyles(await openEntry(zip, stylesEntry), count)
      : new Set<number>();
    const sheet = byName.get(sheetPath);
    if (!sheet) return;
    const stream = await openEntry(zip, sheet);
    let row: unknown[] | undefined;
    let cell:
      | {
          index: number;
          type?: string;
          style: number;
          value: string;
          inline: string;
          formula?: boolean;
        }
      | undefined;
    let capture: 'v' | 't' | undefined;
    let inlinePhonetic = 0;
    let nextColumn = 0;
    for await (const event of xmlEvents(stream, count)) {
      if ('name' in event) {
        if (event.name === 'row') {
          if (event.attributes.r !== undefined) {
            const rowNumber = Number(event.attributes.r);
            if (
              !Number.isInteger(rowNumber) ||
              rowNumber < 1 ||
              rowNumber > 1_048_576
            ) {
              throw new FormatError(
                'The spreadsheet has an invalid row reference.',
              );
            }
          }
          row = [];
          nextColumn = 0;
        }
        if (event.name === 'c') {
          cell = {
            index: cellColumnIndex(event.attributes.r, nextColumn),
            type: event.attributes.t,
            style: Number(event.attributes.s ?? 0),
            value: '',
            inline: '',
          };
          nextColumn = cell.index + 1;
        }
        if (event.name === 'rPh' && cell?.type === 'inlineStr')
          inlinePhonetic++;
        if (event.name === 'f' && cell) cell.formula = true;
        if (event.name === 'v') capture = 'v';
        if (event.name === 't') capture = 't';
      } else if ('text' in event) {
        if (capture === 'v' && cell) cell.value += event.text;
        if (
          capture === 't' &&
          cell &&
          cell.type === 'inlineStr' &&
          !inlinePhonetic
        )
          cell.inline += event.text;
      } else {
        if (event.end === 'rPh' && inlinePhonetic) inlinePhonetic--;
        if (event.end === 'v' || event.end === 't') capture = undefined;
        if (event.end === 'c' && cell && row) {
          const raw = cell.type === 'inlineStr' ? cell.inline : cell.value;
          let value: unknown = raw;
          if (cell.type === 's') {
            const index = Number(raw);
            const sharedString =
              Number.isSafeInteger(index) && index >= 0
                ? selectString!.get(index + 1)
                : undefined;
            if (!sharedString)
              throw new FormatError(
                'The spreadsheet contains an invalid shared string reference.',
              );
            value = String(sharedString.value);
          } else if (cell.type === 'b') value = raw === '1' ? 'true' : 'false';
          else if (cell.type === 'd') {
            const date = new Date(raw);
            if (Number.isFinite(date.getTime())) value = date;
          } else if (cell.type === 'e') value = raw;
          else if (!cell.type || cell.type === 'n') {
            const number = Number(raw);
            if (raw !== '' && Number.isFinite(number))
              value = dateStyles.has(cell.style)
                ? excelDate(number, date1904)
                : String(number);
          }
          row[cell.index] = value;
          cell = undefined;
        }
        if (event.end === 'row' && row) {
          const current = row;
          row = undefined;
          if (current.some((value) => value !== undefined && value !== ''))
            yield current;
        }
      }
    }
  } finally {
    if (sharedStringTransaction) {
      try {
        database?.exec('ROLLBACK');
      } catch {
        // The database is disposable; cleanup below remains authoritative.
      }
    }
    try {
      database?.close();
    } catch {
      // Preserve the import error; the private job directory is still removed.
    }
    try {
      zip?.close();
    } catch {
      // A failed ZIP close must not strand scratch data or mask parser errors.
    }
    await rm(directory, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}
