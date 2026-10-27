import { describe, expect, it } from 'vitest';
import { catalog } from '@/features/access/test/fixtures';
import {
  fromPermissions,
  isValid,
  toPermissions,
  type EditorState,
} from '@/features/access/permissions';

describe('the permission editor’s model', () => {
  it('builds the request body from the catalog: one permission per rule, catalog order', () => {
    const state: EditorState = {
      // Entered out of order: the body follows the catalog.
      'Expense.approve': [{ conditions: { upTo: ' 5000 ' }, fields: null }],
      'Note.update': [{ conditions: { draft: '', mine: '' }, fields: null }],
      'Note.read': [
        { conditions: { mine: '' }, fields: null },
        // Any rule grants it: "in my units", only the text.
        { conditions: { inMyUnits: '' }, fields: ['body'] },
        // The same rule twice is one permission.
        { conditions: { mine: '' }, fields: null },
      ],
      'Access.manageUsers': [{ conditions: {}, fields: null }],
    };
    expect(toPermissions(catalog, state)).toEqual([
      { subject: 'Access', action: 'manageUsers', conditions: [] },
      { subject: 'Note', action: 'read', conditions: [{ key: 'mine' }] },
      {
        subject: 'Note',
        action: 'read',
        conditions: [{ key: 'inMyUnits' }],
        fields: ['body'],
      },
      {
        subject: 'Note',
        action: 'update',
        conditions: [{ key: 'mine' }, { key: 'draft' }],
      },
      {
        subject: 'Expense',
        action: 'approve',
        // A `cents` parameter is a number, under the input's name.
        conditions: [{ key: 'upTo', params: { max: 5000 } }],
      },
    ]);
  });

  it('sends `fields: []` for none of the restrictable fields, and leaves it out for all', () => {
    expect(
      toPermissions(catalog, {
        'Note.create': [{ conditions: {}, fields: [] }],
        'Note.read': [{ conditions: {}, fields: null }],
      }),
    ).toEqual([
      { subject: 'Note', action: 'read', conditions: [] },
      { subject: 'Note', action: 'create', conditions: [], fields: [] },
    ]);
  });

  it('reads a stored role back into the same body, and sets aside what the catalog lacks', () => {
    const stored = [
      { subject: 'Note', action: 'read', conditions: [{ key: 'mine' }] },
      { subject: 'Note', action: 'read', conditions: [{ key: 'mine' }] },
      {
        subject: 'Note',
        action: 'create',
        conditions: [],
        fields: ['custom', 'body'],
      },
      {
        subject: 'Expense',
        action: 'approve',
        conditions: [{ key: 'upTo', params: { max: 120 } }],
      },
      { subject: 'all', action: 'manage', conditions: [] },
    ];
    const { state, unknown } = fromPermissions(catalog, stored);
    expect(unknown).toEqual([
      { subject: 'all', action: 'manage', conditions: [] },
    ]);
    expect(state['Expense.approve']).toEqual([
      { conditions: { upTo: '120' }, fields: null },
    ]);
    expect(toPermissions(catalog, state)).toEqual([
      { subject: 'Note', action: 'read', conditions: [{ key: 'mine' }] },
      {
        subject: 'Note',
        action: 'create',
        conditions: [],
        fields: ['body', 'custom'],
      },
      {
        subject: 'Expense',
        action: 'approve',
        conditions: [{ key: 'upTo', params: { max: 120 } }],
      },
    ]);
  });

  it('wants a value for a condition that takes one, a whole number for cents', () => {
    const rule = (text: string): EditorState => ({
      'Expense.approve': [{ conditions: { upTo: text }, fields: null }],
    });
    expect(isValid(catalog, rule(''))).toBe(false);
    expect(isValid(catalog, rule('12.5'))).toBe(false);
    expect(isValid(catalog, rule('1250'))).toBe(true);
  });
});
