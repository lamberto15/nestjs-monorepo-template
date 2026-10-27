# Design sync notes

Syncs `packages/ui` (Storybook shape) to the claude.ai/design project pinned in `config.json`.

## Setup

- [GENERAL] `packages/ui` ships TypeScript source only: no `dist/`, no index, no `.d.ts`. `cfg.buildCmd` (`sh .design-sync/build-ui-pkg.sh`, run from the repo root) builds a stand-in package in `.design-sync/.cache/ui-pkg/`: an `index.ts` re-exporting every component file, a `package.json` named after the UI package, and `tsc` declarations. Without it the converter walks up to the repo root's `package.json` and finds 0 exports (`[TITLE_UNMAPPED]` drops every story).
- [GENERAL] `cfg.srcDir` and `cfg.tsconfig` resolve from the stand-in package dir, hence the `../../../` prefixes.
- [GENERAL] `.storybook/preview.tsx` imports `globals.css`, whose Geist `.woff2` imports break the converter's decorator bundle (no asset loaders there). `cfg.provider` = `DirectionProvider` (ltr) replaces it; the decorator's other work (the `.dark` toggle, a `bg-background p-4` div) isn't needed: light is the default and `body` already applies `bg-background text-foreground`.
- CSS comes from `[CSS_FROM_STORYBOOK]` (the compiled Tailwind in `sb-reference`), Geist fonts included. Rebuild the reference whenever stories or `globals.css` change, or new utility classes won't be in the shipped CSS.
- `[TOKENS_MISSING]` for `--anchor-width`, `--transform-origin`, `--available-height`, `--dice-*`, `--tw` is expected: Base UI / Dice UI set them at runtime, `--tw` is Tailwind-internal.
- No `pnpm` script runs this; it is a manual sync (`/design-sync`). Re-sync inputs, from the repo root: `sh .design-sync/build-ui-pkg.sh`, then (in `packages/ui`) `npx storybook build -c .storybook -o <repo-root>/.design-sync/sb-reference`; the driver takes `--node-modules packages/ui/node_modules` and needs no `--entry` (it's in config).

## Coverage

- Only the 7 components with stories (Alert, Badge, Button, Card, Input, Switch, Tabs) get cards, `.d.ts` and `.prompt.md`. The other ~40 component files ship in `_ds_bundle.js` (290 exports on `window.NestUI`) but are undocumented for the design agent. Adding a `*.stories.tsx` in `packages/ui` is how a component joins the sync.

## Re-sync risks

- `build-ui-pkg.sh` globs `packages/ui/src/components/*.tsx`; a component moved into a subfolder silently drops out.
- The shipped CSS is Storybook's compiled Tailwind, which scans `packages/ui/src` only: `globals.css`'s `@source "../../../apps/**"` resolves to `packages/apps/` (doesn't exist), so the web app's layout classes (`grid-cols-*`, `lg:*`, `p-6`, `text-xl`…) are absent. `conventions.md` names only verified classes and sends the design agent to inline `var(--token)` styles otherwise. Re-validate its class table whenever `globals.css` or the components change; fixing the `@source` path widens the vocabulary.
- All 18 stories graded `match` on the first sync (2026-10-27); no `close` acceptances, no skips.
