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
//                 name inside a line); the command fails when one is gone

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
    edits: [['AGENTS.md', ' `deliverability`, `ai`, ', ' `deliverability`, ']],
  },
};
