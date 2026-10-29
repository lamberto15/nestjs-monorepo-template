import { checkAnswers, checkValue, defaultIssue } from './form-answers.js';
import {
  definitionIssues,
  formDefinitionSchema,
  keyTypesOf,
  pagesOf,
  type FormDefinition,
  type FormField,
} from './form-schema.js';
import type { RuleCondition } from './form-rules.js';

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

describe('conditions', () => {
  const topic = field({
    key: 'topic',
    type: 'select',
    options: [
      { value: 'billing', label: 'Billing' },
      { value: 'other', label: 'Other' },
    ],
  });
  const other = { field: 'topic', op: 'eq', value: 'other' } as const;
  const definition: FormDefinition = {
    format: 2,
    sections: [
      {
        key: 'main',
        fields: [
          topic,
          field({
            key: 'details',
            type: 'text',
            visibleWhen: other,
            requiredWhen: other,
          }),
          field({ key: 'seats', type: 'integer', default: 1 }),
          field({
            key: 'note',
            type: 'text',
            visibleWhen: { field: 'details', op: 'isEmpty' },
          }),
        ],
      },
      {
        key: 'invoice',
        visibleWhen: { field: 'topic', op: 'eq', value: 'billing' },
        fields: [field({ key: 'number', type: 'text', required: true })],
      },
    ],
  };

  it('requires a field only when its condition holds and it shows', () => {
    const refused = checkAnswers(definition, { topic: 'other' });
    expect(!refused.ok && refused.issues.map((issue) => issue.path)).toEqual([
      'answers.details',
    ]);
    expect(checkAnswers(definition, { topic: 'other', details: 'x' })).toEqual({
      ok: true,
      answers: { topic: 'other', details: 'x', seats: 1 },
    });
  });

  it('strips the answers of hidden fields and sections, whatever was sent, and reads them as empty', () => {
    // details is hidden (topic is billing): stripped, so note shows.
    expect(
      checkAnswers(definition, {
        topic: 'billing',
        details: 12,
        number: 'A-1',
        note: 'n',
      }),
    ).toEqual({
      ok: true,
      answers: { topic: 'billing', seats: 1, number: 'A-1', note: 'n' },
    });
    // The invoice section is hidden: its required field is not, and its answer goes.
    expect(checkAnswers(definition, { number: 'A-1' })).toEqual({
      ok: true,
      answers: { seats: 1 },
    });
  });

  it('refuses at save a later or unknown field, a wrong operator or value, and conditions in format 1', () => {
    const bad: FormDefinition = {
      format: 2,
      sections: [
        {
          key: 'main',
          fields: [
            field({
              key: 'a',
              type: 'text',
              visibleWhen: { field: 'b', op: 'isEmpty' },
            }),
            field({
              key: 'b',
              type: 'text',
              visibleWhen: { field: 'a', op: 'isEmpty' },
              requiredWhen: {
                all: [
                  { field: 'a', op: 'gt', value: 3 },
                  { field: 'nope', op: 'isEmpty' },
                ],
              },
            }),
            { ...topic, visibleWhen: { field: 'topic', op: 'isEmpty' } },
            field({
              key: 'c',
              type: 'text',
              visibleWhen: { field: 'topic', op: 'eq', value: 'missing' },
            }),
          ],
        },
      ],
    };
    expect(definitionIssues(bad).map((issue) => issue.path)).toEqual([
      'sections.0.fields.0.visibleWhen.field',
      'sections.0.fields.1.requiredWhen.all.0.op',
      'sections.0.fields.1.requiredWhen.all.1.field',
      'sections.0.fields.2.visibleWhen.field',
      'sections.0.fields.3.visibleWhen.value',
    ]);
    expect(
      definitionIssues({ ...definition, format: 1 }).map((issue) => issue.path),
    ).toEqual([
      'sections.0.fields.1.visibleWhen',
      'sections.0.fields.1.requiredWhen',
      'sections.0.fields.3.visibleWhen',
      'sections.1.visibleWhen',
    ]);
    expect(definitionIssues(definition)).toEqual([]);
  });

  it('bounds the nesting of a condition', () => {
    let deep: RuleCondition = { field: 'a', op: 'isEmpty' };
    for (let i = 0; i < 5; i++) deep = { not: deep };
    const issues = definitionIssues({
      format: 2,
      sections: [
        {
          key: 'main',
          fields: [
            field({ key: 'a', type: 'text' }),
            field({ key: 'b', type: 'text', visibleWhen: deep }),
          ],
        },
      ],
    });
    expect(issues.map((issue) => issue.message)).toEqual([
      'At most 4 groups inside each other.',
    ]);
  });
});

describe('pages and repeatable groups', () => {
  const people = field({
    key: 'people',
    type: 'group',
    required: true,
    validation: { maxItems: 2 },
    fields: [
      { key: 'name', type: 'text', label: 'Name', required: true },
      { key: 'age', type: 'integer', label: 'Age', validation: { min: 0 } },
    ],
  });
  const definition: FormDefinition = {
    format: 3,
    sections: [
      { key: 'one', fields: [field({ key: 'title', type: 'text' })] },
      { key: 'two', startsPage: true, fields: [people] },
    ],
  };

  it('checks each item at its indexed path, and the number of items', () => {
    expect(
      checkAnswers(definition, {
        people: [{ name: 'Ada', age: '36' }, { name: 'Bob' }],
      }),
    ).toEqual({
      ok: true,
      answers: { people: [{ name: 'Ada', age: 36 }, { name: 'Bob' }] },
    });
    const refused = checkAnswers(definition, {
      people: [{ age: -1, extra: 1 }, { name: 'Bob' }],
    });
    expect(!refused.ok && refused.issues.map((issue) => issue.path)).toEqual([
      'answers.people.0.extra',
      'answers.people.0.name',
      'answers.people.0.age',
    ]);
    const many = checkAnswers(definition, {
      people: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
    });
    expect(!many.ok && many.issues).toEqual([
      { path: 'answers.people', message: 'At most 2 items.' },
    ]);
    const none = checkAnswers(definition, { people: [] });
    expect(!none.ok && none.issues.map((issue) => issue.path)).toEqual([
      'answers.people',
    ]);
  });

  it('keeps groups one level deep and under the hard cap, and pages and groups to format 3', () => {
    const nested = {
      format: 3,
      sections: [
        {
          key: 'main',
          fields: [
            {
              ...people,
              validation: { maxItems: 500 },
              fields: [
                { key: 'name', type: 'text', label: 'N' },
                { key: 'name', type: 'text', label: 'N' },
              ],
            },
          ],
        },
      ],
    } as FormDefinition;
    expect(definitionIssues(nested).map((issue) => issue.path)).toEqual([
      'sections.0.fields.0.validation.maxItems',
      'sections.0.fields.0.fields.1.key',
    ]);
    expect(
      formDefinitionSchema.safeParse({
        sections: [
          {
            key: 'main',
            fields: [
              {
                ...people,
                fields: [{ key: 'inner', type: 'group', label: 'Inner' }],
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      definitionIssues({ ...definition, format: 2 }).map((issue) => issue.path),
    ).toEqual(['sections.1.startsPage', 'sections.1.fields.0.type']);
    expect(definitionIssues(definition)).toEqual([]);
    expect(pagesOf(definition.sections).map((page) => page.length)).toEqual([
      1, 1,
    ]);
  });

  it('fixes the type of a group’s field once published', () => {
    expect(keyTypesOf(definition)).toMatchObject({
      people: 'group',
      'people.age': 'integer',
    });
    expect(
      definitionIssues(definition, { 'people.age': 'text' }).map(
        (issue) => issue.path,
      ),
    ).toEqual(['sections.1.fields.0.fields.1.type']);
  });
});
