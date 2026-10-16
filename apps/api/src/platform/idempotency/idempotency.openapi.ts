import type { ApiHeaderOptions } from '@nestjs/swagger';

/**
 * The value Swagger UI pre-fills for `Idempotency-Key`. Its request interceptor
 * replaces it with a fresh key, so every "Execute" is a new operation instead of
 * everyone replaying the first response of one shared example key.
 */
export const GENERATE_KEY = 'generate';

/** The `Idempotency-Key` request header, for `@ApiHeader()`. */
export const idempotencyKeyHeader = (required: boolean): ApiHeaderOptions => ({
  name: 'Idempotency-Key',
  required,
  description: [
    'A unique key per operation (a UUID), 1 to 255 printable ASCII characters. Send the same key on every retry of the same request: it runs once, and retries get its response (with Idempotent-Replayed: true). Kept for 24 hours.',
    '',
    `In Swagger UI, leave \`${GENERATE_KEY}\` to send a new key on every Execute, or type your own key and Execute twice to see a retry replayed.`,
  ].join('\n'),
  schema: { type: 'string', example: GENERATE_KEY },
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
