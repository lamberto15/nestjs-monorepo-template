// Called as a Node CLI inside the Artillery image, before any VUs connect.
// The access token is captured by run.sh, not printed to the Actions log.
'use strict';
const { randomUUID } = require('node:crypto');

async function accessToken() {
  const { BASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD, CAPTCHA } = process.env;
  if (!BASE_URL || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
    throw new Error('BASE_URL, ADMIN_EMAIL and ADMIN_PASSWORD are required');
  }
  const headers = { 'Content-Type': 'application/json' };
  if (CAPTCHA && CAPTCHA !== 'off') {
    headers['X-Captcha-Token'] = `stub:pass:${randomUUID()}`;
  }
  const response = await fetch(`${BASE_URL}/v1/auth/token`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!response.ok) {
    throw new Error(`administrator sign-in: HTTP ${response.status}`);
  }
  const body = await response.json();
  if (typeof body.accessToken !== 'string' || !body.accessToken) {
    throw new Error('administrator sign-in did not return an access token');
  }
  return body.accessToken;
}

if (require.main === module) {
  accessToken().then(
    (token) => process.stdout.write(token),
    (error) => {
      console.error(`Realtime login failed: ${error.message}`);
      process.exitCode = 1;
    },
  );
}
module.exports = { accessToken };
