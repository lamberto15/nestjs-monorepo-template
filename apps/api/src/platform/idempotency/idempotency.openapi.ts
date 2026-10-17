import type { ApiHeaderOptions } from '@nestjs/swagger';

/**
 * The value Swagger UI pre-fills for `Idempotency-Key`. Its request interceptor
 * replaces it with a fresh key, so every "Execute" is a new operation instead of
 * everyone replaying the first response of one shared example key.
 */
export const GENERATE_KEY = 'generate';

/** Marks a header a route chose for itself (not the deployment's mode); removed from the published document. */
const FIXED = 'x-idempotency-fixed';

/** The `Idempotency-Key` request header, for `@ApiHeader()`. */
export const idempotencyKeyHeader = (
  required: boolean,
  /** A feature's own choice (record.ts `idempotency`): applyIdempotencyMode leaves it as it is. */
  fixed = false,
): ApiHeaderOptions => ({
  name: 'Idempotency-Key',
  required,
  description: [
    'A unique key per operation (a UUID), 1 to 255 printable ASCII characters. Send the same key on every retry of the same request: it runs once, and retries get its response (with Idempotent-Replayed: true). Kept for 24 hours.',
    '',
    `In Swagger UI, leave \`${GENERATE_KEY}\` to send a new key on every Execute, or type your own key and Execute twice to see a retry replayed.`,
  ].join('\n'),
  schema: {
    type: 'string',
    example: GENERATE_KEY,
    ...(fixed && { [FIXED]: true }),
  },
});

/**
 * Swagger UI's `requestInterceptor`. It runs in the browser: @nestjs/swagger
 * serializes it with `toString()`, so it must not use anything from this
 * module's scope (which is why the values are spelled out).
 */
export function swaggerRequestInterceptor(request: {
  headers: Record<string, string>;
}) {
  for (const name of Object.keys(request.headers)) {
    if (
      name.toLowerCase() === 'idempotency-key' &&
      request.headers[name] === 'generate'
    ) {
      request.headers[name] = crypto.randomUUID();
    }
  }
  return request;
}

/**
 * Makes the published document follow IDEMPOTENCY. The decorators document the
 * header as required (the default mode); under `optional` every
 * `Idempotency-Key` parameter is marked optional, except those a feature
 * chose for itself (record.ts `idempotency`: `required` stays required).
 */
export function applyIdempotencyMode(
  document: { paths?: Record<string, unknown> },
  mode: 'required' | 'optional',
) {
  for (const path of Object.values(document.paths ?? {})) {
    for (const operation of Object.values(path as Record<string, unknown>)) {
      const parameters = (operation as { parameters?: unknown }).parameters;
      if (!Array.isArray(parameters)) continue;
      for (const parameter of parameters as {
        in?: string;
        name?: string;
        required?: boolean;
        schema?: Record<string, unknown>;
      }[]) {
        if (parameter.in !== 'header' || parameter.name !== 'Idempotency-Key') {
          continue;
        }
        const fixed = parameter.schema?.[FIXED] === true;
        if (parameter.schema) delete parameter.schema[FIXED];
        if (mode === 'optional' && !fixed) parameter.required = false;
      }
    }
  }
}
