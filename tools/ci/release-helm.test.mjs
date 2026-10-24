import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { createManifest } from './release-manifest.mjs';
let available = true;
try {
  execFileSync('helm', ['version', '--short'], { stdio: 'pipe' });
} catch {
  available = false;
}
if (process.env.REQUIRE_HELM && !available)
  throw new Error('Helm is required for release render validation');

test(
  'Helm lint and render preserve rebuilt API and reused web/Gotenberg digests',
  { skip: !available },
  () => {
    const repository = 'example/template';
    const digest = (n) => 'sha256:' + String(n).repeat(64);
    const previous = createManifest({
      repository,
      sourceSha: 'a'.repeat(40),
      runId: 1,
      published: { api: digest(1), caddy: digest(2), gotenberg: digest(3) },
    });
    const mixed = createManifest({
      repository,
      sourceSha: 'b'.repeat(40),
      runId: 2,
      previous,
      published: { api: digest(4) },
    });
    const values = ['-f', 'deploy/helm/app/values.single-node.yaml'];
    for (const [component, path] of [
      ['api', 'image'],
      ['caddy', 'web.image'],
      ['gotenberg', 'gotenberg.image'],
    ]) {
      values.push(
        '--set',
        `${path}.repository=${mixed.images[component].repository}`,
        '--set',
        `${path}.digest=${mixed.images[component].digest}`,
      );
    }
    execFileSync('helm', ['lint', 'deploy/helm/app', '--strict', ...values], {
      stdio: 'pipe',
    });
    const render = execFileSync(
      'helm',
      [
        'template',
        'app',
        'deploy/helm/app',
        '-n',
        'nestjs-monorepo',
        ...values,
      ],
      { encoding: 'utf8' },
    );
    for (const image of Object.values(mixed.images))
      assert.ok(render.includes(`${image.repository}@${image.digest}`));
    assert.ok(!render.includes(previous.images.api.digest));
    assert.equal(mixed.images.caddy.runId, 1);
    assert.equal(mixed.images.api.runId, 2);
  },
);
