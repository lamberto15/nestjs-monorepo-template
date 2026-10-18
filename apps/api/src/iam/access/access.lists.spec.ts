import { PgDialect } from 'drizzle-orm/pg-core';
import type { ListQuery } from '../../core/http/list-query.js';
import { AUDIT_LIST } from './access.lists.js';

const dialect = new PgDialect();
const where = (query: Record<string, string>) =>
  dialect.sqlToQuery(
    AUDIT_LIST.where(AUDIT_LIST.schema.parse(query) as ListQuery)!,
  );

describe('AUDIT_LIST: actorLabel', () => {
  it('matches the stored label, a member’s name or address, a client’s name', () => {
    const { sql, params } = where({ 'actorLabel.contains': 'Ada' });
    expect(sql).toContain('"audit_log"."actor_label" ilike');
    expect(sql).toContain('"users"."name" ilike');
    expect(sql).toContain('"users"."email" ilike');
    expect(sql).toContain('"api_clients"."name" ilike');
    expect(params.every((param) => param === '%Ada%')).toBe(true);
  });

  it('looks up only members and clients of the entry’s own tenant', () => {
    const { sql } = where({ actorLabel: 'ada@example.com' });
    expect(sql).toContain(
      '"memberships"."tenant_id" = "audit_log"."tenant_id"',
    );
    expect(sql).toContain(
      '"api_clients"."tenant_id" = "audit_log"."tenant_id"',
    );
    expect(sql).toContain(`"audit_log"."actor" = 'user:' || "users"."id"`);
    expect(sql).toContain(
      `"audit_log"."actor" = 'client:' || "api_clients"."id"`,
    );
  });

  it('searches for % and _ as the characters', () => {
    const { params } = where({ 'actorLabel.startsWith': '50%_off' });
    expect(new Set(params)).toEqual(new Set(['50\\%\\_off%']));
  });

  it('takes no other operator', () => {
    expect(() =>
      AUDIT_LIST.schema.parse({ 'actorLabel.endsWith': 'x' }),
    ).toThrow();
  });
});
