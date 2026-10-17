import { z } from 'zod';

/** What the access API answers with (its routes' OpenAPI responses, the typed client's types). */

const conditionSchema = z.object({
  key: z.string().meta({ example: 'mine' }),
  params: z.record(z.string(), z.unknown()).optional(),
});

/** A member of the tenant, as GET /access/users lists them. */
export const userViewSchema = z.object({
  id: z.uuid(),
  kind: z.literal('user'),
  email: z.string(),
  name: z.string(),
  emailVerified: z.boolean(),
  locale: z.string().nullable().describe('The language they chose, or null.'),
  timezone: z
    .string()
    .nullable()
    .describe('Their IANA time zone, or null (APP_TIMEZONE).'),
  active: z
    .boolean()
    .describe('The membership in this tenant and the account, together.'),
  hasPassword: z
    .boolean()
    .describe('false: invited, or signs in only with a provider.'),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  roleIds: z.array(z.uuid()),
  roles: z.array(
    z.object({
      roleId: z.uuid(),
      expiresAt: z.iso
        .datetime()
        .nullable()
        .describe('When the grant ends; null: never.'),
    }),
  ),
  teamIds: z.array(z.uuid()),
});

/** A role of the tenant, with its permissions and how many users hold it. */
export const roleViewSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  key: z
    .string()
    .nullable()
    .describe(
      "The code's name of a built-in or seeded role (`administrator`, `editor`); null for roles made through the API.",
    ),
  name: z.string(),
  description: z.string(),
  system: z.boolean().describe('Built in: never edited nor deleted.'),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  permissions: z.array(
    z.object({
      subject: z.string(),
      action: z.string(),
      conditions: z.array(conditionSchema),
      fields: z
        .array(z.string())
        .optional()
        .describe('Only these restrictable fields; absent: all of them.'),
    }),
  ),
  members: z.int().describe('The users who hold it.'),
});

export const createdRoleSchema = z.object({ id: z.uuid() });

/** GET /access/catalog: every permission that exists, and the system jobs. */
export const catalogSchema = z.object({
  subjects: z.array(
    z.object({
      subject: z.string().meta({ example: 'Note' }),
      label: z.string(),
      fields: z
        .array(
          z.object({
            field: z.string(),
            label: z.string(),
            sensitive: z
              .boolean()
              .describe('Redacted in the audit log and revisions.'),
          }),
        )
        .describe('The fields a permission may grant one by one.'),
      actions: z.array(
        z.object({
          action: z.string().meta({ example: 'read' }),
          label: z.string(),
          conditions: z.array(
            z.object({
              key: z.string(),
              label: z.string(),
              description: z.string(),
              input: z
                .object({
                  name: z.string(),
                  label: z.string(),
                  type: z.enum(['text', 'cents']),
                })
                .nullable()
                .describe('The parameter the condition takes, if any.'),
            }),
          ),
        }),
      ),
    }),
  ),
  systemJobs: z.array(
    z.object({
      key: z.string(),
      actor: z
        .string()
        .describe('`system:<key>`: the actor of its audit entries.'),
      label: z.string(),
      description: z.string(),
      permissions: z.array(
        z.object({
          subject: z.string(),
          action: z.string(),
          conditions: z.array(conditionSchema),
          fields: z.array(z.string()).nullable(),
        }),
      ),
    }),
  ),
});

/** An entry of the audit log. */
export const auditEntrySchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid().nullable(),
  at: z.iso.datetime(),
  actor: z
    .string()
    .describe('`user:<id>`, `client:<id>`, `system:<key>` or `anonymous`.'),
  actorLabel: z.string(),
  action: z.string().meta({ example: 'note.created' }),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  details: z.record(z.string(), z.unknown()).nullable(),
  ip: z.string().nullable(),
});

/** A user or an API client of the tenant, as a picker shows it (GET /access/principals). */
export const principalSchema = z.object({
  id: z.uuid(),
  key: z
    .string()
    .describe(
      "The principal's key: `user:<id>` or `client:<id>`, as `scopeId` of a setting's user scope and `actor` filters take it.",
    )
    .meta({ example: 'user:0190a1b2-0000-7000-8000-000000000000' }),
  kind: z.enum(['user', 'client']),
  label: z.string().describe("The user's name, or the client's."),
  email: z.string().nullable().describe("A user's address; null for a client."),
  active: z
    .boolean()
    .describe(
      'A user: the membership in this tenant and the account; a client: not revoked.',
    ),
});
