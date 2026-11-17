import { randomUUID } from 'node:crypto';
import { notHeld, legalHolds } from './legal-holds.tables.js';
import { placeLegalHoldSchema } from './legal-hold.schemas.js';
import { PgDialect } from 'drizzle-orm/pg-core';

describe('placeLegalHoldSchema', () => {
  it('takes a subject, a reason and optionally one record', () => {
    const recordId = randomUUID();
    expect(
      placeLegalHoldSchema.parse({
        subject: 'Note',
        reason: ' Case 12 ',
        recordId,
      }),
    ).toEqual({ subject: 'Note', reason: 'Case 12', recordId });
    expect(
      placeLegalHoldSchema.parse({ subject: 'User', reason: 'x' }),
    ).toEqual({
      subject: 'User',
      reason: 'x',
    });
  });

  it('refuses a subject that is not a name, no reason and a record that is not an id', () => {
    for (const bad of [
      { subject: 'note', reason: 'x' },
      { subject: 'No te', reason: 'x' },
      { subject: 'Note', reason: '  ' },
      { subject: 'Note', reason: 'x', recordId: 'abc' },
      { reason: 'x' },
    ]) {
      expect(placeLegalHoldSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('notHeld', () => {
  it('is a NOT EXISTS over the active holds of the subject, with the subject as a parameter', () => {
    const { sql: text, params } = new PgDialect().sqlToQuery(
      notHeld('Note', legalHolds.id),
    );
    expect(text).toMatch(/^not exists \(select 1 from "legal_holds" where/);
    expect(text).toContain('"released_at" is null');
    expect(text).toContain('"record_id" is null)) or');
    expect(params).toEqual(['Note']);
  });
});
