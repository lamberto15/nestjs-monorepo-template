#!/usr/bin/env sh
# packages/ui ships TypeScript source only (no dist, no index), so the design
# sync builds a stand-in package from it: an entry re-exporting every
# component file, and the declarations tsc emits for it. Run from the repo root.
set -eu

PKG=.design-sync/.cache/ui-pkg
rm -rf "$PKG"
mkdir -p "$PKG"

for f in packages/ui/src/components/*.tsx; do
  case "$f" in *.stories.tsx) continue ;; esac
  echo "export * from '../../../$f';" | sed "s/\.tsx';$/';/"
done > "$PKG/index.ts"

version=$(node -p "require('./packages/ui/package.json').version")
cat > "$PKG/package.json" <<EOF
{
  "name": "@nestjs-monorepo-template/ui",
  "version": "$version",
  "types": "types/.design-sync/.cache/ui-pkg/index.d.ts"
}
EOF

cat > "$PKG/tsconfig.json" <<'EOF'
{
  "extends": "../../../packages/ui/tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "declaration": true,
    "emitDeclarationOnly": true,
    "rootDir": "../../..",
    "outDir": "types"
  },
  "include": ["index.ts"]
}
EOF

ln -s ../../../packages/ui/node_modules "$PKG/node_modules"
packages/ui/node_modules/.bin/tsc -p "$PKG/tsconfig.json"
