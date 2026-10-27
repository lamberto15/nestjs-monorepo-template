#!/usr/bin/env node
// Lighthouse CI scans a real route (/sign-in), which calls the API for the
// sign-in methods and to check who is signed in. There is no API running in
// this job (lighthouse.yml has no database or Redis service), so this
// answers just those two requests — enough for the page to render — and
// starts `vite preview` in front of it. Anything else the page asks for
// 404s; the page does not need it to render.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const API_PORT = 3100;
const PREVIEW_PORT = 4173;

const methods = {
  password: true,
  signUp: false,
  tenantSignUp: false,
  magicLink: false,
  passkeys: false,
  providers: [],
  captcha: null,
};

const api = createServer((request, response) => {
  if (request.url === '/v1/auth/me') {
    response.writeHead(401, { 'content-type': 'application/problem+json' });
    response.end(
      JSON.stringify({
        status: 401,
        code: 'unauthorized',
        detail: 'unauthorized (lighthouse)',
      }),
    );
    return;
  }
  if (request.url === '/v1/auth/methods') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(methods));
    return;
  }
  response.writeHead(404, { 'content-type': 'application/problem+json' });
  response.end(JSON.stringify({ status: 404, code: 'not_found' }));
});

await new Promise((resolve) => api.listen(API_PORT, '127.0.0.1', resolve));

const preview = spawn(
  'pnpm', // NOSONAR S4036: the CI runner's pnpm, from PATH (no one fixed path fits every runner)
  ['exec', 'vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'],
  {
    stdio: 'inherit',
    env: { ...process.env, API_URL: `http://127.0.0.1:${API_PORT}` },
  },
);

const stop = (code) => {
  preview.kill();
  api.close();
  process.exit(code ?? 0);
};
process.on('SIGTERM', () => stop(0));
process.on('SIGINT', () => stop(0));
preview.on('exit', (code) => stop(code ?? 0));
