// GitHub supplies paths; Turbo supplies the workspace dependency graph. Custom
// routing is needed for jobs outside that graph (images, DBs and generators).
import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { releasePlan } from './release-manifest.mjs';

export const keys = [
  'code',
  'app',
  'lint',
  'api',
  'web',
  'tools',
  'stack',
  'services',
  'backup',
  'gotenberg',
  'caddy',
  'ci',
  'generator',
  'image',
  'full',
];
const roots =
  /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json|tsconfig[^/]*\.json|\.oxlintrc\.json|\.npmrc|\.nvmrc)$/;
const inert =
  /^(docs\/|\.claude\/|\.changeset\/[^/]*\.md$|\.devcontainer\/|deploy\/(helm|k3s)\/|\.github\/(ISSUE_TEMPLATE\/|CODEOWNERS$|dependabot\.yml$|PULL_REQUEST_TEMPLATE\.md$)|LICENSE$|\.editorconfig$|[^/]*\.md$|packages\/[^/]+\/[^/]*\.md$)/;

export function classify({ files, full = false, complete = true }) {
  const flags = Object.fromEntries(keys.map((key) => [key, false]));
  const all = () => Object.fromEntries(keys.map((key) => [key, true]));
  if (full || !complete || !Array.isArray(files) || !files.length) return all();
  for (const file of files) {
    if (typeof file !== 'string' || !file || /[\r\n\0]/.test(file))
      return all();
    if (/^(tools\/ci\/|\.github\/workflows\/)/.test(file)) {
      flags.ci = true;
      continue;
    }
    if (inert.test(file)) continue;
    if (
      roots.test(file) ||
      /^(\.github\/actions\/|packages\/(?!api-client\/|ui\/))/.test(file)
    )
      return all();
    flags.code = true;
    if (/^(tools\/|knip\.jsonc$)/.test(file)) {
      flags.lint = true;
      flags.tools ||= file.startsWith('tools/');
      flags.generator ||= /^tools\/(feature|setup)\//.test(file);
      flags.stack ||= file.startsWith('tools/deploy/');
      flags.image ||= file.startsWith('tools/deploy/');
      continue;
    }
    if (/^(apps\/api\/|packages\/api-client\/)/.test(file)) {
      flags.app = flags.api = flags.image = true;
      flags.generator ||=
        /^(apps\/api\/(src\/platform\/|src\/core\/|test\/fixtures\/)|packages\/api-client\/)/.test(
          file,
        );
      if (file.startsWith('packages/') || file === 'apps/api/package.json')
        flags.web = flags.caddy = true;
    } else if (/^(apps\/web\/|apps\/web-e2e\/|packages\/ui\/)/.test(file)) {
      flags.app = flags.web = true;
      flags.caddy ||= !file.startsWith('apps/web-e2e/');
    } else if (
      /^(compose[^/]*\.yaml$|secret\.empty$|swarm\.placeholder$|scripts\/|loadtest\/|redis\/|caddy\/|backup\/|gotenberg\/|monitoring\/|clamav\/|pgbouncer\/)/.test(
        file,
      )
    ) {
      flags.stack = true;
      flags.image = true; // The hardened runtime needs the API artifact.
      flags.services ||= file === 'compose.yaml';
      flags.backup ||= /^(backup\/|scripts\/test-backup-pitr\.sh$)/.test(file);
      flags.gotenberg ||= /^(gotenberg\/|compose\.(dev|prod)\.yaml$)/.test(
        file,
      );
      flags.caddy ||= file.startsWith('caddy/');
      flags.web ||= file === 'caddy/Caddyfile';
    } else if (/^(env\.example|\.prettierrc|\.prettierignore)$/.test(file)) {
      flags.tools = flags.lint = flags.generator = true;
    } else if (file === '.trivyignore.yaml') {
      flags.image = flags.backup = flags.gotenberg = flags.caddy = true;
    } else return all(); // Unknown paths fail towards comprehensive validation.
  }
  return flags;
}

export function comparisonFiles(data, { pr = false, expected } = {}) {
  const pages = pr ? (Array.isArray(data[0]) ? data : [data]) : [data.files];
  if (!pages.every(Array.isArray)) return null;
  const entries = pages.flat();
  if (
    !entries.length ||
    entries.length >= (pr ? 3000 : 300) ||
    (pr && entries.length !== expected)
  )
    return null;
  if (!pr && !['ahead', 'identical'].includes(data.status)) return null;
  if (
    entries.some(
      (f) => !f.filename || (f.status === 'renamed' && !f.previous_filename),
    )
  )
    return null;
  return entries.flatMap((f) => [
    f.filename,
    ...(f.previous_filename ? [f.previous_filename] : []),
  ]);
}

export function expectedJobs(
  f,
  event = 'pull_request',
  benchmark = 'off',
  unitWhole = false,
) {
  if (benchmark === 'e2e') return ['changes', 'compose-images', 'e2e'];
  if (benchmark === 'unit')
    return [
      'changes',
      'unit-api',
      'unit-web',
      ...(!unitWhole ? ['coverage'] : []),
    ];
  const rules = {
    changes: true,
    'ci-validate': f.ci,
    'compose-images':
      f.app || f.tools || f.services || f.generator || f.full || f.web,
    'compose-secrets': f.stack,
    'swarm-stack': f.stack,
    'tooling-lint': f.lint && !f.app && !f.tools,
    check: f.app,
    'unit-api': f.api,
    'unit-web': f.web,
    coverage: !unitWhole && (f.api || f.web),
    e2e: f.api || f.services,
    'e2e-telemetry': f.api || f.services,
    'e2e-web': f.api || f.web || f.services,
    'feature-smoke': f.generator || f.tools || f.services,
    'template-without-notes': f.full,
    'openapi-diff': event === 'pull_request' && f.api,
    security: f.app || f.tools,
    image: f.image,
    'backup-image': f.backup,
    'hardened-stack': f.api || f.stack,
    'caddy-image': f.caddy,
    'gotenberg-image': f.gotenberg,
  };
  return Object.entries(rules)
    .filter(([, needed]) => needed)
    .map(([job]) => job);
}

export function gitFiles(base, head, run = execFileSync) {
  try {
    if (!/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(head))
      return null;
    run('git', ['merge-base', '--is-ancestor', base, head]);
    // --no-renames includes both paths of a rename as a deletion + addition.
    return run(
      'git',
      ['diff', '--no-renames', '--name-only', '-z', base, head],
      { encoding: 'utf8' },
    )
      .split('\0')
      .filter(Boolean);
  } catch {
    return null;
  }
}

export function runChanges(
  env = process.env,
  gh = (args) => execFileSync('gh', args, { encoding: 'utf8' }),
) {
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const full =
    !['push', 'pull_request'].includes(env.GITHUB_EVENT_NAME) ||
    env.GITHUB_REF.startsWith('refs/tags/');
  const base = event.pull_request?.base.sha ?? event.before ?? '';
  const head = event.pull_request?.head.sha ?? env.GITHUB_SHA;
  let files;
  if (!full && /^[a-f0-9]{40}$/.test(base) && !/^0+$/.test(base)) {
    try {
      const pr = env.GITHUB_EVENT_NAME === 'pull_request';
      const endpoint = pr
        ? `pulls/${event.number}/files`
        : `compare/${base}...${head}`;
      const args = ['api', `repos/${env.GITHUB_REPOSITORY}/${endpoint}`];
      if (pr) args.push('--paginate', '--slurp');
      files = comparisonFiles(JSON.parse(gh(args)), {
        pr,
        expected: event.pull_request?.changed_files,
      });
    } catch {
      files = null;
    }
  }
  const flags = classify({ files, full, complete: Boolean(files) });
  // Turbo must use the same comparison; a missing ref disables affected mode.
  const affected =
    !flags.full &&
    files.every((file) => /^(apps\/api\/|apps\/web\/|packages\/)/.test(file)) &&
    Boolean(gitFiles(base, head));
  const benchmark = event.inputs?.benchmark ?? 'off';
  const plan = releasePlan(flags, env, event, classify, gitFiles);
  const unitWhole = event.inputs?.unit_layout === 'whole';
  const outputs = {
    ...flags,
    base,
    head,
    affected,
    benchmark,
    unit_whole: unitWhole,
    publish: plan.publish,
    release_ready: !plan.error,
    expected: JSON.stringify(
      expectedJobs(flags, env.GITHUB_EVENT_NAME, benchmark, unitWhole),
    ),
  };
  appendFileSync(
    env.GITHUB_OUTPUT,
    Object.entries(outputs)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
  );
  return outputs;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runChanges();
