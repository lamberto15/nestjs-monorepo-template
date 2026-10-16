import {
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
