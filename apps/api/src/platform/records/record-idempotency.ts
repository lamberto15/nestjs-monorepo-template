import { applyDecorators } from '@nestjs/common';
import { Idempotent } from '@nestjs/idempotency';
import { ApiHeader } from '@nestjs/swagger';
import { idempotencyKeyHeader } from '../idempotency/idempotency.openapi.js';
import { principalScope } from '../idempotency/idempotency.scopes.js';
import type { RecordRouteSpec } from './record-routes.js';

/**
 * `Idempotency-Key` on a record's write route, as the record declares it
 * (record.ts `idempotency`): unset, the deployment's mode rules (IDEMPOTENCY;
 * the document follows it); `required` or `optional`, the feature's own
 * choice wins over the deployment's, in the route and in the OpenAPI
 * document; `off`, the route takes no key.
 */
export function RecordIdempotent(spec: RecordRouteSpec) {
  if (spec.idempotency === 'off') return applyDecorators();
  const own =
    spec.idempotency === undefined
      ? undefined
      : spec.idempotency === 'required';
  return applyDecorators(
    Idempotent({
      scope: principalScope,
      ...(own !== undefined && { required: own }),
    }),
    ApiHeader(idempotencyKeyHeader(own ?? true, own !== undefined)),
  );
}
