import { text, uuid } from 'drizzle-orm/pg-core';
import { defineRecord } from './record.js';
import { recordPermissions } from './record-policy.js';

const table = { ownerId: text('owner_id'), unitId: uuid('unit_id') };
const declare = (
  extra: { clientAccess?: false | 'own'; grants?: 'standard' | 'none' } = {},
  unit = false,
) =>
  defineRecord({
    subject: 'Widget',
    path: 'widgets',
    apiTag: 'widgets',
    className: 'Widget',
    noun: 'widget',
    table: 'widgets',
    softDelete: false,
    unit,
    fields: {},
    capabilities: [],
    ...extra,
  });
const actionsOf = (permissions: { subject: string; action: string }[]) =>
  permissions.map((permission) => permission.action).sort();

describe('recordPermissions: clientAccess and grants', () => {
  it('denies API clients by default, and gives the standard seed roles', () => {
    const permissions = recordPermissions(declare(), table);
    expect(permissions.clientPermissions).toEqual([]);
    expect(permissions.seedRoles?.map((role) => role.key)).toEqual([
      'editor',
      'viewer',
    ]);
  });

  it("gives every client its own records with clientAccess 'own'", () => {
    const { clientPermissions } = recordPermissions(
      declare({ clientAccess: 'own' }),
      table,
    );
    expect(actionsOf(clientPermissions ?? [])).toEqual([
      'create',
      'delete',
      'read',
      'update',
    ]);
  });

  it("keeps the feature's own client permissions when access is closed", () => {
    const extra = { subject: 'Widget', action: 'read', conditions: [] };
    expect(
      recordPermissions(declare(), table, { clientPermissions: [extra] })
        .clientPermissions,
    ).toEqual([extra]);
  });

  it("gives no seed role with grants 'none', but the feature's own", () => {
    expect(
      recordPermissions(declare({ grants: 'none' }, true), table).seedRoles,
    ).toEqual([]);
    const own = { key: 'auditor', name: 'Auditor', permissions: [] };
    expect(
      recordPermissions(declare({ grants: 'none' }), table, {
        seedRoles: [own],
      }).seedRoles,
    ).toEqual([own]);
  });

  it('gives unit leads their units only with a unit', () => {
    const keys = (unit: boolean) =>
      recordPermissions(declare({}, unit), table).seedRoles?.map(
        (role) => role.key,
      );
    expect(keys(true)).toEqual(['editor', 'unit-lead', 'viewer']);
    expect(keys(false)).toEqual(['editor', 'viewer']);
  });
});

describe('recordPermissions: names', () => {
  it('names one record by its noun and several by its path', () => {
    const permissions = recordPermissions(declare(), table);
    expect(permissions.subjects.Widget!.names).toEqual({
      singular: 'Widget',
      plural: 'Widgets',
    });
  });
});
