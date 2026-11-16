// What `pnpm capability:remove` (tools/feature/remove-capability.mjs) needs
// to know of each platform capability it can take out, beyond what it
// derives: the folder (apps/api/src/platform/<name>/), its module, queue and
// settings in the composition files, its tables in the schema barrel, its
// e2e test (apps/api/test/<name>.e2e-spec.ts), the web app's feature folder,
// routes and locale files (the feature paths), its docs page
// (docs/<name>.md) and the links to it, and every `capability:<name> begin`
// … `end` block in shared files. Only true leaves are here: no other
// capability imports them.
//
// Each entry:
//   about:        what it is, for the command's messages
//   files:        more files to delete (adapters in features and fixtures,
//                 tests named otherwise), relative to the repository
//   texts:        keys in shared locale files ({ app: 'web' | 'api', file, key })
//   dependencies: packages only it uses, by workspace package: the command
//                 prints the `pnpm remove` for them (never edits package.json)
//   edits:        [file, text, replacement]: prose a marker can't hold (a
//                 name inside a line, a Markdown table's row); the command
//                 fails unless each text is there once

export const REMOVABLE = {
  ai: {
    about: 'the AI helper (docs/ai.md)',
    files: [
      'apps/api/src/features/notes/note-ai.ts',
      'apps/api/test/fixtures/test-items/test-item-ai.ts',
      'apps/api/test/ai-off.e2e-spec.ts',
      'apps/web/src/features/notes/note-ai.test.tsx',
    ],
    texts: [{ app: 'web', file: 'settings.json', key: ['groups', 'ai'] }],
    dependencies: {
      '@nestjs-monorepo-template/api': [
        '@ai-sdk/anthropic',
        '@nestjs/ai',
        'ai',
      ],
    },
    edits: [
      ['AGENTS.md', ' `deliverability`, `ai`, ', ' `deliverability`, '],
      [
        'docs/configuration.md',
        '`DOCUMENTS` (2), `AI` (2), ',
        '`DOCUMENTS` (2), ',
      ],
      [
        'docs/configuration.md',
        '`RESEND_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, ',
        '`RESEND_WEBHOOK_SECRET`, ',
      ],
      [
        'docs/configuration.md',
        '  (`SENTRY_DSN`), the AI helper (`ANTHROPIC_API_KEY`), Web Push\n',
        '  (`SENTRY_DSN`), Web Push\n',
      ],
      [
        'docs/deployment.md',
        '| `ANTHROPIC_API_KEY_FILE` | the app (api, worker; not `migrate`) | `ANTHROPIC_API_KEY` |\n',
        '',
      ],
      ['docs/architecture.md', ' AI sources (`AiRegistry`),', ''],
      [
        'docs/adding-a-feature.md',
        "  note-ai.ts                            the AI helper's source\n",
        '',
      ],
    ],
  },
};
