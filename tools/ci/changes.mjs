import { githubCli } from './github-cli.mjs';
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
  'api_image',
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
    if (roots.test(file)) {
      // Root dependency changes validate all applications. Merge only true
      // contributions so another path can still require an infrastructure job.
      const application = {
        ...all(),
        full: false,
        stack: false,
        services: false,
        backup: false,
        gotenberg: false,
      };
      for (const [key, needed] of Object.entries(application))
        if (needed) flags[key] = true;
      continue;
    }
    if (/^(\.github\/actions\/|packages\/(?!api-client\/|ui\/))/.test(file))
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
    if (/^(apps\/api\/|packages\/api-client\/|\.dockerignore$)/.test(file)) {
      flags.app = flags.api = flags.image = flags.api_image = true;
      flags.generator ||=
        /^(apps\/api\/(src\/(platform|core|iam)\/|src\/app.module\.ts$|test\/fixtures\/)|packages\/api-client\/)/.test(
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
      flags.image =
        flags.api_image =
        flags.backup =
        flags.gotenberg =
        flags.caddy =
          true;
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
      (f) =>
        !f.filename ||
        ![
          'added',
          'removed',
          'modified',
          'renamed',
          'copied',
          'changed',
          'unchanged',
        ].includes(f.status) ||
        (f.status === 'renamed' && !f.previous_filename),
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
  unitWhole = true,
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
  gh = (args) => execFileSync(githubCli(), args, { encoding: 'utf8' }),
  planning = releasePlan,
  compare = gitFiles,
) {
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const full =
    !['push', 'pull_request'].includes(env.GITHUB_EVENT_NAME) ||
    env.GITHUB_REF.startsWith('refs/tags/');
  let base = event.pull_request?.base.sha ?? event.before ?? '';
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
  let flags = classify({ files, full, complete: Boolean(files) });
  const benchmark = event.inputs?.benchmark ?? 'off';
  if (event.inputs?.bootstrap_release === 'true' && benchmark !== 'off')
    throw new Error(
      'Bootstrap requires comprehensive validation, not benchmark mode',
    );
  const scenarios = {
    api: ['apps/api/src/features/notes/notes.service.ts'],
    web: ['apps/web/src/main.tsx'],
    shared: ['package.json'],
    infrastructure: ['backup/Dockerfile'],
    ci: ['tools/ci/changes.mjs'],
  };
  const scope = event.inputs?.validation_scope ?? 'full';
  if (
    env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
    benchmark === 'off' &&
    scope !== 'full'
  ) {
    if (!scenarios[scope])
      throw new Error('Unknown validation timing scenario');
    if (event.inputs?.bootstrap_release === 'true')
      throw new Error('Bootstrap requires comprehensive validation');
    flags = classify({ files: scenarios[scope] });
    files = null; // Explicit routing: there is no synthetic Git comparison.
  }
  const plan = planning(flags, env, event, classify, compare);
  if (plan.previous) {
    base = plan.previous.sourceSha;
    files = compare(base, head);
  }
  // A main release validates cumulative changes, including components whose
  // intervening release failed. Turbo must use that same base, too.
  const affected =
    !flags.full &&
    Array.isArray(files) &&
    files.length > 0 &&
    files.every((file) => /^(apps\/api\/|apps\/web\/|packages\/)/.test(file)) &&
    Boolean(compare(base, head));
  const unitWhole = (event.inputs?.unit_layout ?? 'whole') === 'whole';
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
