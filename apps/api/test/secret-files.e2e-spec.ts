import { rmSync } from 'node:fs';
import { bootApp, type TestApp } from './support.js';

// Before AppModule loads: this file's secrets come from files (X_FILE), the
// way Docker secrets hand them over, not from the variables. The
// administrator's password moves from its variable (setup-env.ts) to a file.
const { dir, metricsToken, webhookKey } = await vi.hoisted(async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { randomBytes } = await import('node:crypto');
  const dir: string = mkdtempSync(join(tmpdir(), 'secret-files-e2e-'));
  const put = (name: string, contents: string) => {
    const path = join(dir, name);
    writeFileSync(path, contents, { mode: 0o600 });
    process.env[`${name}_FILE`] = path;
  };
  const metricsToken = randomBytes(24).toString('hex');
  const webhookKey = randomBytes(32).toString('base64');
  put('ADMIN_PASSWORD', `${process.env.ADMIN_PASSWORD}\n`);
  process.env.ADMIN_PASSWORD = '';
  // CRLF, as a file saved on Windows has it.
  put('METRICS_TOKEN', `${metricsToken}\r\n`);
  // Read from process.env by the webhooks module, not through ConfigService.
  put('WEBHOOKS_ENCRYPTION_KEYS', `${webhookKey}\n`);
  return { dir, metricsToken, webhookKey };
});

describe('secrets from files (e2e)', () => {
  let node: TestApp;

  beforeAll(async () => {
    node = await bootApp();
  });
  afterAll(async () => {
    await node.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('boots and signs the administrator in with the password from its file', async () => {
    // bootApp signed in with process.env.ADMIN_PASSWORD: the file's value, put there at boot.
    const res = await node.admin().get('/v1/auth/me').expect(200);
    expect(res.body.user.email).toBe('admin@example.com');
  });

  it('serves /metrics to the token from its file, trailing CRLF dropped', async () => {
    await node
      .http()
      .get('/metrics')
      .set('Authorization', `Bearer ${metricsToken}`)
      .expect(200);
  });

  it('gives process.env the values, for the code that reads it itself', () => {
    expect(process.env.WEBHOOKS_ENCRYPTION_KEYS).toBe(webhookKey);
    expect(process.env.METRICS_TOKEN).toBe(metricsToken);
  });
});
