import { stat } from 'node:fs/promises';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

/**
 * CI's e2e shards (`--shard=i/n`), split by file size instead of Vitest's
 * equal file counts: a file's size follows its run time (every test boots an
 * app), and equal counts left one shard twice the other's test time (1006 s
 * against 535 s, issue #681). Largest file first, each to the lightest
 * shard; ties by path, so every runner computes the same split without a
 * timing file to keep up to date. The order within a shard stays Vitest's
 * (BaseSequencer's sort: larger files first).
 */
export class SizeSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]) {
    const { index, count } = this.ctx.config.shard!;
    const sized = await Promise.all(
      files.map(async (spec) => ({
        spec,
        size: (await stat(spec.moduleId)).size,
      })),
    );
    sized.sort(
      (a, b) =>
        b.size - a.size || a.spec.moduleId.localeCompare(b.spec.moduleId),
    );
    const loads = Array.from({ length: count }, () => 0);
    return sized
      .filter(({ size }) => {
        const lightest = loads.indexOf(Math.min(...loads));
        loads[lightest]! += size;
        return lightest === index - 1;
      })
      .map(({ spec }) => spec);
  }
}
