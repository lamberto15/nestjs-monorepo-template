import { describe, expect, it } from 'vitest';
import {
  INVITATION_LIMITS,
  ROLE_LIMITS,
  UNIT_LIMITS,
} from '@/features/access/api';
import { API_CLIENT_LIMITS } from '@/features/api-clients/queries';
import { REPORT_LIMITS } from '@/features/reports/api';
import { TAG_LIMITS } from '@/features/tags/api';
import { TENANT_LIMITS } from '@/features/tenants/queries';
import { SENDER_LIMITS } from '@/features/webhooks/sender-queries';
import { AUTH_LIMITS } from '@/lib/auth-limits';
import {
  hasRoute,
  requestProperties,
  type TextLimits,
} from '@/test/request-schemas';

type Request = readonly [path: string, method: 'post' | 'patch'];

/**
 * Every web form whose limits the API's OpenAPI document states: the request
 * it sends, and the limits its zod schema takes from the app's constants. A
 * limit the web allows beyond the API's only shows as a 400 after the submit.
 * (The example feature's are checked beside its own tests: it can be removed,
 * and this file must not name it.)
 */
const forms: {
  form: string;
  requests: readonly Request[];
  limits: Record<string, TextLimits>;
}[] = [
  {
    form: 'the new API client',
    requests: [['/v1/access/clients', 'post']],
    limits: { name: { maxLength: API_CLIENT_LIMITS.name } },
  },
  {
    form: 'a role',
    requests: [
      ['/v1/access/roles', 'post'],
      ['/v1/access/roles/{id}', 'patch'],
    ],
    limits: {
      name: { maxLength: ROLE_LIMITS.name },
      description: { maxLength: ROLE_LIMITS.description },
    },
  },
  {
    form: 'a unit',
    requests: [
      ['/v1/access/organizational-units', 'post'],
      ['/v1/access/organizational-units/{id}', 'patch'],
    ],
    limits: { name: { maxLength: UNIT_LIMITS.name } },
  },
  {
    form: 'an invitation',
    requests: [['/v1/access/users', 'post']],
    limits: { name: { maxLength: INVITATION_LIMITS.name } },
  },
  {
    form: 'a scheduled report',
    requests: [
      ['/v1/reports', 'post'],
      ['/v1/reports/{id}', 'patch'],
    ],
    limits: { name: { maxLength: REPORT_LIMITS.name } },
  },
  {
    form: 'a tenant',
    requests: [
      ['/v1/tenants', 'post'],
      ['/v1/tenants/{id}', 'patch'],
    ],
    limits: {
      name: { maxLength: TENANT_LIMITS.name },
      slug: { maxLength: TENANT_LIMITS.slug },
    },
  },
  {
    form: 'a tag',
    requests: [
      ['/v1/tags', 'post'],
      ['/v1/tags/{id}', 'patch'],
    ],
    limits: {
      name: { maxLength: TAG_LIMITS.name },
      description: { maxLength: TAG_LIMITS.description },
    },
  },
  {
    form: 'an incoming webhook sender',
    requests: [
      ['/v1/webhook-senders', 'post'],
      ['/v1/webhook-senders/{id}', 'patch'],
    ],
    limits: { description: { maxLength: SENDER_LIMITS.description } },
  },
  {
    form: 'the sign-up',
    requests: [['/v1/auth/sign-up', 'post']],
    limits: {
      name: { maxLength: AUTH_LIMITS.name },
      password: {
        minLength: AUTH_LIMITS.passwordMin,
        maxLength: AUTH_LIMITS.passwordMax,
      },
      tenantName: { maxLength: AUTH_LIMITS.tenantName },
    },
  },
  {
    form: 'the profile',
    requests: [['/v1/auth/me', 'patch']],
    limits: { name: { maxLength: AUTH_LIMITS.name } },
  },
  {
    form: 'the password reset',
    requests: [['/v1/auth/password/reset', 'post']],
    limits: {
      password: {
        minLength: AUTH_LIMITS.passwordMin,
        maxLength: AUTH_LIMITS.passwordMax,
      },
    },
  },
  {
    form: 'the password change',
    requests: [['/v1/auth/password/change', 'post']],
    limits: {
      newPassword: {
        minLength: AUTH_LIMITS.passwordMin,
        maxLength: AUTH_LIMITS.passwordMax,
      },
    },
  },
  {
    form: 'accepting an invitation',
    requests: [['/v1/auth/invitations/accept', 'post']],
    limits: {
      name: { maxLength: AUTH_LIMITS.name },
      password: {
        minLength: AUTH_LIMITS.passwordMin,
        maxLength: AUTH_LIMITS.passwordMax,
      },
    },
  },
  {
    form: 'a passkey name',
    requests: [
      ['/v1/auth/passkeys', 'post'],
      ['/v1/auth/passkeys/{id}', 'patch'],
    ],
    limits: { name: { maxLength: AUTH_LIMITS.passkeyName } },
  },
];

describe("the forms' limits equal the API schema's", () => {
  for (const { form, requests, limits } of forms) {
    for (const [path, method] of requests) {
      // A route a feature-removal job took out has nothing to compare.
      it.skipIf(!hasRoute(path))(
        `${form}: ${method.toUpperCase()} ${path}`,
        () => {
          const properties = requestProperties(path, method);
          for (const [field, limit] of Object.entries(limits)) {
            expect(properties[field], field).toMatchObject(limit);
          }
        },
      );
    }
  }
});
