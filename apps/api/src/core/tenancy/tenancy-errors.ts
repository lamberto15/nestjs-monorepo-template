import { ForbiddenException } from '@nestjs/common';
import { ProblemDetailsFilter } from '../http/problem-details.filter.js';
import { TenantScopeMissingError } from './tenant-scope.js';

/**
 * Work on a tenant's data without a tenant, over HTTP: the caller has none
 * (a user without a membership, a session whose tenant they left), so 403
 * `tenant_required` rather than a 500. Drizzle wraps the pool's refusal
 * (DrizzleQueryError, the error in `cause`), so the chain is searched.
 */
ProblemDetailsFilter.map(Error, (error) => {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth++) {
    if (e instanceof TenantScopeMissingError) {
      return new ForbiddenException(
        {
          code: 'tenant_required',
          message:
            'This needs a tenant: choose one (POST /v1/auth/tenant), or ask to be added to one.',
        },
        { cause: error },
      );
    }
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
});
