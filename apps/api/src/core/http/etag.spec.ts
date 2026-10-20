import { PreconditionFailedException } from '@nestjs/common';
import { assertUnchanged, etagOf, etagOfResponse, untagged } from './etag.js';

/** A record's `watching` (?include=watching) is the reader's: in the GET's tag as a marker, not in the write's. */
describe('the ETag of a response with `watching`', () => {
  const record = { id: 'a', title: 'T' };
  const shown = (watching: boolean) =>
    untagged({ ...record, watching }, ['watching']);

  it('differs by the flag, and keeps the record tag as its prefix', () => {
    const base = etagOf(record);
    const yes = etagOfResponse(shown(true));
    const no = etagOfResponse(shown(false));
    expect(yes).not.toBe(no);
    expect(yes).toMatch(/^"[\w-]+"$/);
    for (const tag of [yes, no]) {
      expect(tag.startsWith(base.slice(0, -1))).toBe(true);
    }
    // Without the flag: the plain tag.
    expect(etagOfResponse(record)).toBe(base);
  });

  it('marks a list by its items flags', () => {
    const page = (flags: boolean[]) =>
      untagged(
        {
          items: flags.map((watching, i) =>
            untagged({ id: String(i), watching }, ['watching']),
          ),
        },
        [],
      );
    expect(etagOfResponse(page([true, false]))).not.toBe(
      etagOfResponse(page([false, false])),
    );
  });

  it('is accepted as If-Match: the marker is ignored, a changed record still refused', () => {
    const tag = etagOfResponse(shown(true));
    expect(() => assertUnchanged(tag, record)).not.toThrow();
    expect(() => assertUnchanged(etagOf(record), record)).not.toThrow();
    expect(() => assertUnchanged(tag, { ...record, title: 'Other' })).toThrow(
      PreconditionFailedException,
    );
  });
});
