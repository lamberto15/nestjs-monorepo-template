import {
  applyIdempotencyMode,
  GENERATE_KEY,
  swaggerRequestInterceptor,
} from './idempotency.openapi.js';

describe('swaggerRequestInterceptor', () => {
  it('replaces the pre-filled value with a fresh key on every request', () => {
    const first = swaggerRequestInterceptor({
      headers: { 'Idempotency-Key': GENERATE_KEY },
    });
    const second = swaggerRequestInterceptor({
      headers: { 'Idempotency-Key': GENERATE_KEY },
    });
    expect(first.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.headers['Idempotency-Key']).not.toBe(
      first.headers['Idempotency-Key'],
    );
  });

  it('keeps a key the user typed, so a retry can be tested', () => {
    const request = swaggerRequestInterceptor({
      headers: { 'idempotency-key': 'my-retry-test', Accept: '*/*' },
    });
    expect(request.headers).toEqual({
      'idempotency-key': 'my-retry-test',
      Accept: '*/*',
    });
  });

  it('runs on its own, as Swagger UI runs it from its source text', () => {
    // @nestjs/swagger ships the function to the browser with toString():
    // rebuild it from its source the same way.
    // oxlint-disable-next-line typescript/no-implied-eval
    const shipped = new Function(
      `return (${swaggerRequestInterceptor.toString()})`,
    )() as typeof swaggerRequestInterceptor;
    const request = shipped({ headers: { 'Idempotency-Key': GENERATE_KEY } });
    expect(request.headers['Idempotency-Key']).not.toBe(GENERATE_KEY);
  });
});

const documented = () => ({
  paths: {
    '/v1/things': {
      post: {
        parameters: [
          { in: 'header', name: 'Idempotency-Key', required: true },
          { in: 'header', name: 'If-Match', required: true },
          { in: 'query', name: 'Idempotency-Key', required: true },
        ],
      },
      get: {},
    },
  },
});

describe('applyIdempotencyMode', () => {
  it('leaves the document as the decorators wrote it under required', () => {
    const document = documented();
    applyIdempotencyMode(document, 'required');
    expect(document).toEqual(documented());
  });

  it('marks only the Idempotency-Key header optional under optional', () => {
    const document = documented();
    applyIdempotencyMode(document, 'optional');
    expect(document.paths['/v1/things'].post.parameters).toEqual([
      { in: 'header', name: 'Idempotency-Key', required: false },
      { in: 'header', name: 'If-Match', required: true },
      { in: 'query', name: 'Idempotency-Key', required: true },
    ]);
  });
});

describe('a feature that chose its own Idempotency-Key (idempotencyKeyHeader fixed)', () => {
  const chosen = (required: boolean) => ({
    paths: {
      '/v1/things': {
        post: {
          parameters: [
            {
              in: 'header',
              name: 'Idempotency-Key',
              required,
              schema: { type: 'string', 'x-idempotency-fixed': true },
            },
          ],
        },
      },
    },
  });

  it('stays required under an optional deployment, without the marker', () => {
    const document = chosen(true);
    applyIdempotencyMode(document, 'optional');
    expect(document.paths['/v1/things'].post.parameters[0]).toEqual({
      in: 'header',
      name: 'Idempotency-Key',
      required: true,
      schema: { type: 'string' },
    });
  });

  it('stays optional under a required deployment, without the marker', () => {
    const document = chosen(false);
    applyIdempotencyMode(document, 'required');
    expect(document.paths['/v1/things'].post.parameters[0]).toEqual({
      in: 'header',
      name: 'Idempotency-Key',
      required: false,
      schema: { type: 'string' },
    });
  });
});
