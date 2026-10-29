import { checkAnswers, checkValue, defaultIssue } from './form-answers.js';
import {
  definitionIssues,
  type FormDefinition,
  type FormField,
} from './form-schema.js';

const field = (extra: Partial<FormField> & Pick<FormField, 'type'>) =>
  ({ key: 'f', label: 'F', ...extra }) as FormField;

const form = (...fields: FormField[]): FormDefinition => ({
  format: 1,
  sections: [{ key: 'main', fields }],
});

describe('checkValue', () => {
  it('normalizes numbers, dates and choices, and refuses what is out of bounds', () => {
    const seats = field({ type: 'integer', validation: { min: 1, max: 10 } });
    expect(checkValue(seats, '3')).toEqual({ ok: true, value: 3 });
    expect(checkValue(seats, 2.5).ok).toBe(false);
    expect(checkValue(seats, 11).ok).toBe(false);
    expect(checkValue(field({ type: 'date' }), '2026-02-30').ok).toBe(false);
    expect(checkValue(field({ type: 'date' }), '2026-02-28')).toEqual({
      ok: true,
      value: '2026-02-28',
    });
    const topic = field({
      type: 'multiSelect',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    });
    expect(checkValue(topic, ['a', 'b']).ok).toBe(true);
    expect(checkValue(topic, ['a', 'c']).ok).toBe(false);
    expect(checkValue(field({ type: 'email' }), 'not an address').ok).toBe(
      false,
    );
  });

  it('takes a required checkbox only checked', () => {
    const consent = field({ type: 'checkbox', required: true });
    expect(checkValue(consent, false).ok).toBe(false);
    expect(checkValue(consent, true)).toEqual({ ok: true, value: true });
    expect(defaultIssue(consent, false)).toBeNull();
  });
});

describe('checkAnswers', () => {
  const definition = form(
    field({ key: 'name', type: 'text', required: true }),
    field({ key: 'seats', type: 'integer', default: 1 }),
  );

  it('fills defaults and refuses unknown keys and missing required answers, at their paths', () => {
    expect(checkAnswers(definition, { name: 'Ada' })).toEqual({
      ok: true,
      answers: { name: 'Ada', seats: 1 },
    });
    const refused = checkAnswers(definition, { extra: 1 });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(['answers.extra', 'answers.name']),
    );
    expect(checkAnswers(definition, [1]).ok).toBe(false);
  });
});

describe('definitionIssues', () => {
  it('refuses a key twice, a choice without options, and a published key retyped', () => {
    const issues = definitionIssues(
      form(
        field({ key: 'a', type: 'text' }),
        field({ key: 'a', type: 'select' }),
      ),
      { a: 'integer' },
    ).map((issue) => issue.path);
    expect(issues).toEqual(
      expect.arrayContaining([
        'sections.0.fields.1.key',
        'sections.0.fields.1.options',
        'sections.0.fields.0.type',
      ]),
    );
    expect(
      definitionIssues(form(field({ key: 'a', type: 'text' })), { a: 'text' }),
    ).toEqual([]);
  });
});
