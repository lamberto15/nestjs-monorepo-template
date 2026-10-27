import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ConfigEnv, UserConfig } from 'vite';
import { describe, expect, it } from 'vitest';
import { caddyWebHeaders, productionHeaders } from './production-headers.ts';

const caddyfile = readFileSync(
  resolve(import.meta.dirname, '../../caddy/Caddyfile'),
  'utf8',
);

/** What the plugin adds to Vite's configuration for this command. */
function configFor(env: ConfigEnv) {
  const hook = productionHeaders().config as (
    config: UserConfig,
    env: ConfigEnv,
  ) => UserConfig | undefined;
  return hook({}, env);
}

describe("the preview's production headers", () => {
  it("are the Caddyfile's web app headers, the policy whole", () => {
    const headers = caddyWebHeaders(caddyfile);
    expect(Object.keys(headers).toSorted()).toEqual([
      'Content-Security-Policy',
      'Cross-Origin-Opener-Policy',
      'Permissions-Policy',
      'Referrer-Policy',
      'Strict-Transport-Security',
      'X-Content-Type-Options',
      'X-Frame-Options',
    ]);
    const policy = headers['Content-Security-Policy'];
    // The Caddyfile's line, less the origins of files Caddy adds at its start.
    const line = /^\s*Content-Security-Policy "(.*)"$/m.exec(caddyfile)?.[1];
    expect(line).toContain("default-src 'self'");
    expect(policy).toBe(line?.replaceAll(' {env.WEB_FILES_ORIGINS};', ';'));
    expect(policy).toContain("connect-src 'self';");
    expect(policy).toContain("img-src 'self' data:;");
    expect(policy).not.toContain("'unsafe-eval'");
  });

  it('refuses a Caddyfile without the block', () => {
    expect(() => caddyWebHeaders('{$APP_DOMAIN} {\n}\n')).toThrow(
      /no web app `header` block/,
    );
  });

  it('are sent by `vite preview` only, never by the dev server or a build', () => {
    expect(
      configFor({ command: 'serve', mode: 'production', isPreview: true }),
    ).toEqual({ preview: { headers: caddyWebHeaders(caddyfile) } });
    expect(
      configFor({ command: 'serve', mode: 'development', isPreview: false }),
    ).toBeUndefined();
    expect(
      configFor({ command: 'build', mode: 'production', isPreview: false }),
    ).toBeUndefined();
  });
});
