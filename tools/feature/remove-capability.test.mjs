// The capability remover's tests (tools/feature/remove-capability.mjs):
//   node --test tools/feature/remove-capability.test.mjs
// Each removes a capability from a scratch copy of this checkout (its
// sources, no node_modules), so the manifest (removable.mjs) is checked
// against the tree as it is: a marker, a file or a text it names that is
// gone fails here. The real tree is never written.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { markdownLinks } from '../docs/links.mjs';
import { REMOVABLE } from './removable.mjs';
import { removeCapability } from './remove-capability.mjs';
import { stripBlocks, walk } from './remove.mjs';

const REPO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const LEFT_OUT = new Set([
  'node_modules',
  '.git',
  '.claude',
  '.turbo',
  'dist',
  'coverage',
  'drizzle',
]);
const TOOL = path.join(REPO, 'tools/feature/remove-capability.mjs');

const copies = [];
/** A scratch copy of the checkout's sources. */
function copy() {
  const root = mkdtempSync(path.join(tmpdir(), 'capability-remove-'));
  copies.push(root);
  cpSync(REPO, root, {
    recursive: true,
    filter: (source) => !LEFT_OUT.has(path.basename(source)),
  });
  return root;
}
after(() => {
  for (const root of copies) rmSync(root, { recursive: true, force: true });
});

const read = (file) => readFileSync(file, 'utf8');

for (const name of Object.keys(REMOVABLE)) {
  describe(`removeCapability(${name})`, () => {
    const root = copy();

    it('changes nothing on a dry run', async () => {
      const before = read(
        path.join(root, 'apps/api/src/platform/platform.module.ts'),
      );
      const result = await removeCapability(root, { name, dryRun: true });
      assert.ok(result.deleted.includes(`apps/api/src/platform/${name}`));
      assert.ok(existsSync(path.join(root, 'apps/api/src/platform', name)));
      assert.equal(
        read(path.join(root, 'apps/api/src/platform/platform.module.ts')),
        before,
      );
    });

    it('removes its folder, files, markers, module, tables, texts and docs', async () => {
      const result = await removeCapability(root, { name });
      for (const file of result.deleted) {
        assert.ok(!existsSync(path.join(root, file)), file);
      }
      for (const file of REMOVABLE[name].files ?? []) {
        assert.ok(!existsSync(path.join(root, file)), file);
      }
      // No marker, import or table of it is left in the API.
      const module = read(
        path.join(root, 'apps/api/src/platform/platform.module.ts'),
      );
      assert.doesNotMatch(module, new RegExp(`'\\./${name}/`));
      assert.doesNotMatch(
        read(path.join(root, 'apps/api/src/schema.ts')),
        new RegExp(`/platform/${name}/`),
      );
      for (const file of [
        ...walk(path.join(root, 'apps'), '.ts', '.tsx'),
        ...walk(path.join(root, 'tools'), '.mjs'),
        path.join(root, 'env.example'),
        path.join(root, 'compose.prod.yaml'),
        path.join(root, '.github/workflows/ci.yml'),
      ]) {
        assert.doesNotMatch(
          read(file),
          new RegExp(
            `^\\s*(?:#|//|\\{/\\*) capability:${name} (?:begin|end)`,
            'm',
          ),
          file,
        );
      }
      // Nothing links to its page.
      for (const file of walk(path.join(root, 'docs'), '.md')) {
        for (const line of read(file).split('\n')) {
          for (const href of markdownLinks(line)) {
            assert.ok(
              path.resolve(path.dirname(file), href.split('#')[0]) !==
                path.join(root, 'docs', `${name}.md`),
              `${file}: ${line}`,
            );
          }
        }
      }
      // Its sections in shared pages are gone.
      for (const [relative, heading] of REMOVABLE[name].sections ?? []) {
        assert.ok(
          !read(path.join(root, relative)).split('\n').includes(heading),
          `${relative}: ${heading}`,
        );
      }
      assert.ok(result.removed.some((r) => r.endsWith('platform.module.ts')));
    });

    it('says there is nothing left to remove on a second run', async () => {
      assert.deepEqual(await removeCapability(root, { name }), {
        nothing: true,
      });
      const run = spawnSync(process.execPath, [TOOL, name, '--root', root], {
        encoding: 'utf8',
      });
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /Nothing to remove/);
    });
  });
}

describe('removeCapability refuses', () => {
  const root = copy();
  const platform = path.join(root, 'apps/api/src/platform/platform.module.ts');

  it('a name it does not support, and a path', async () => {
    for (const name of ['records', '../ai', 'ai/..', '-r']) {
      await assert.rejects(
        () => removeCapability(root, { name }),
        /not a capability this command can remove/,
      );
    }
  });

  it('while something else imports it, listing the files, and changes nothing', async () => {
    const user = path.join(root, 'apps/api/src/platform/tags/uses-ai.ts');
    writeFileSync(
      user,
      "import { aiEnabled } from '../ai/ai-models.js';\n\nexport const on = aiEnabled;\n",
    );
    const before = read(platform);
    await assert.rejects(
      () => removeCapability(root, { name: 'ai' }),
      /apps\/api\/src\/platform\/tags\/uses-ai\.ts/,
    );
    assert.equal(read(platform), before);
    assert.ok(existsSync(path.join(root, 'apps/api/src/platform/ai')));
    rmSync(user);
  });

  it('when a text the manifest names is gone (a stale manifest)', async () => {
    const agents = path.join(root, 'AGENTS.md');
    const text = read(agents);
    writeFileSync(agents, text.replace('`ai`', '`ai-helper`'));
    await assert.rejects(
      () => removeCapability(root, { name: 'ai' }),
      /AGENTS\.md holds .* 0 times, not once/,
    );
    writeFileSync(agents, text);
  });
});

describe('stripBlocks', () => {
  it('drops each block with its markers, in any comment style', () => {
    const { out, count } = stripBlocks(
      [
        'a',
        '  // capability:ai begin',
        '  x',
        '  // capability:ai end',
        '# capability:ai begin',
        'Y=1',
        '# capability:ai end',
        '      {/* capability:ai begin */}',
        '      <Panel />',
        '      {/* capability:ai end */}',
        '// capability:ai-other begin',
        'kept',
        '// capability:ai-other end',
        'b',
        '',
      ].join('\n'),
      'capability:ai',
    );
    assert.equal(count, 3);
    assert.equal(
      out,
      'a\n// capability:ai-other begin\nkept\n// capability:ai-other end\nb\n',
    );
  });

  it('throws on a begin without its end', () => {
    assert.throws(
      () => stripBlocks('// capability:ai begin\nx\n', 'capability:ai'),
      /has no "capability:ai end"/,
    );
  });
});
