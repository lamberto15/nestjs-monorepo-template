// The optional image check of the deploy scripts: with VERIFY_IMAGES=1 they
// run scripts/verify-image.sh (cosign signature, signed SBOM, provenance of
// APP_IMAGE, GOTENBERG_IMAGE and CADDY_IMAGE) before touching anything, and
// stop when it fails. Off by default (docs/deployment.md, "Signing and
// verifying images").
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(
  new URL('../../scripts/verify-image.sh', import.meta.url),
);

export function verifyEnabled(env = process.env) {
  return ['1', 'true'].includes(String(env.VERIFY_IMAGES ?? '').toLowerCase());
}

/** Runs the script on the env's images (no arguments), resolving its exit code. */
export function runVerify(env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(SCRIPT, [], { env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/**
 * @param {{ env?: object, verify?: (env: object) => Promise<number>, log?: Function }} deps
 * @param {(msg: string) => Error} fail builds the script's own error type
 */
export async function verifyIfEnabled(deps, fail) {
  const env = deps.env ?? process.env;
  if (!verifyEnabled(env)) return;
  (deps.log ?? console.log)('Verifying the images (VERIFY_IMAGES)');
  const code = await (deps.verify ?? runVerify)(env);
  if (code !== 0) throw fail(`image verification failed (exit ${code})`);
}
