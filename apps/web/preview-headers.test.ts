import { describe, expect, it } from 'vitest';
import { caddyHeaders } from './preview-headers.ts';

describe('the headers vite preview takes from the Caddyfile', () => {
  const headers = caddyHeaders();

  it('reads the production Content-Security-Policy', () => {
    const csp = headers['Content-Security-Policy'];
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).toContain("worker-src 'self'");
    expect(csp).not.toContain('{env.');
  });

  it('reads the other security headers of the block', () => {
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
  });

  it('refuses a Caddyfile without the block', () => {
    expect(() => caddyHeaders('handle {\n}\n')).toThrow(
      /Content-Security-Policy/,
    );
  });
});
