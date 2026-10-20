// realtime.yml's processor: signs the load-test administrator in once for
// the whole run and hands the access token to every virtual user as `token`
// (the same route and account the k6 setup uses). Custom code because the
// socket.io engine can't call an HTTP route and then template the handshake's
// headers from the answer; one sign-in, not one per user, since a password
// check costs ~0.4 s of a CPU (docs/development.md, "Load tests").
'use strict';

let token;

async function accessToken() {
  const { BASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD, CAPTCHA } = process.env;
  if (!BASE_URL || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
    throw new Error('BASE_URL, ADMIN_EMAIL and ADMIN_PASSWORD are required (loadtest/run.sh sets them)');
  }
  const headers = { 'Content-Type': 'application/json' };
  // The stub provider (compose.loadtest.yaml) passes any `stub:pass:` token
  // that wasn't seen before.
  if (CAPTCHA && CAPTCHA !== 'off') {
    headers['X-Captcha-Token'] = `stub:pass:${Date.now()}-${Math.random()}`;
  }
  const res = await fetch(`${BASE_URL}/v1/auth/token`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`administrator sign-in: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()).accessToken;
}

function signedIn(context, _events, done) {
  token ??= accessToken();
  token.then(
    (value) => {
      context.vars.token = value;
      done();
    },
    (error) => {
      // Retry on the next user rather than caching a failure.
      token = undefined;
      done(error);
    },
  );
}

module.exports = { signedIn };
