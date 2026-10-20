import { Injectable, type OnModuleInit } from '@nestjs/common';
import { encryptedColumns } from '../../core/encryption/encrypted-columns.js';
import { MetricsService } from '../../core/metrics/metrics.service.js';
import { ReencryptionService } from './reencryption.service.js';

/**
 * `encrypted_rows_on_old_key{column}` on core's `/metrics`: the rows of
 * each encrypted column whose value or blind index is not under the
 * current key yet. After a rotation it falls to 0 as the re-encryption job
 * runs; only then may the old key leave the list (docs/encryption.md).
 * One that stays above 0 is a row that doesn't open (its key is gone): the
 * job logs it. Every tenant's rows, as the maintenance role: from the
 * workers' scrape (docs/tenancy.md, "The bypass").
 */
@Injectable()
export class ReencryptionMetrics implements OnModuleInit {
  constructor(
    private readonly metrics: MetricsService,
    private readonly reencryption: ReencryptionService,
  ) {}

  onModuleInit() {
    if (encryptedColumns().length === 0) {
      return;
    }
    this.metrics.collect(
      'encrypted_rows_on_old_key',
      'Rows of an encrypted column whose value or blind index is not under the current key (the old key may leave at 0).',
      async () => {
        const samples = [];
        for (const entry of encryptedColumns()) {
          samples.push({
            labels: { column: `${entry.bindingTable}.${entry.bindingColumn}` },
            value: await this.reencryption.countStale(entry),
          });
        }
        return samples;
      },
      ['column'],
      { acrossTenants: true },
    );
  }
}
