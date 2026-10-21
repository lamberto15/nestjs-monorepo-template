import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

/**
 * A stand-in for Turnstile's siteverify endpoint on loopback (the tests
 * never reach Cloudflare), for the bot-protection e2e files, which start it
 * in `vi.hoisted()` before AppModule loads and point CAPTCHA_VERIFY_URL at
 * it: their apps verify tokens against it with the real TurnstileVerifier.
 * It answers by the token's text (`ok:<action>:<unique>` passes for that
 * action, `spent:…` is the provider's replay refusal, `secret:…` is
 * siteverify refusing our secret (`invalid-input-secret`), anything else is
 * invalid), records what it was asked, and can be told to fail or to hang.
 */
export async function startSiteverify() {
  // Made at runtime (a local hook refuses key-like literals).
  const siteKey = `1x${randomBytes(11).toString('hex')}`;
  const secretKey = `1x${randomBytes(16).toString('hex')}`;
  const requests: Record<string, unknown>[] = [];
  const state = { down: false, hang: false, hostname: 'web.example.com' };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      requests.push({ url: req.url, ...body });
      if (state.hang) {
        return; // never answers: the client's timeout decides
      }
      if (state.down || body.secret !== secretKey) {
        res.writeHead(503).end();
        return;
      }
      const [kind, action = 'sign-in'] = String(body.response).split(':');
      const answer =
        kind === 'ok'
          ? { success: true, hostname: state.hostname, action }
          : kind === 'spent'
            ? { success: false, 'error-codes': ['timeout-or-duplicate'] }
            : kind === 'secret'
              ? { success: false, 'error-codes': ['invalid-input-secret'] }
              : { success: false, 'error-codes': ['invalid-input-response'] };
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  Object.assign(process.env, {
    CAPTCHA_PROVIDER: 'turnstile',
    CAPTCHA_VERIFY_URL: `http://127.0.0.1:${port}/siteverify`,
    CAPTCHA_TIMEOUT_MS: '300',
    TURNSTILE_SITE_KEY: siteKey,
    TURNSTILE_SECRET_KEY: secretKey,
  });
  return {
    siteKey,
    secretKey,
    requests,
    state,
    /** A fresh token the stand-in accepts for `action`; never two alike. */
    token: (action = 'sign-in') => `ok:${action}:${randomUUID()}`,
    reset() {
      requests.length = 0;
      state.down = false;
      state.hang = false;
      state.hostname = 'web.example.com';
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

type Siteverify = Awaited<ReturnType<typeof startSiteverify>>;
