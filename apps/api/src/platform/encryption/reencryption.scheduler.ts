import { Injectable } from '@nestjs/common';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { encryptedColumns } from '../../core/encryption/encrypted-columns.js';
import { SystemContext } from '../../iam/access/system-context.js';
import { REENCRYPTION_JOB } from '../platform.jobs.js';
import { ReencryptionService } from './reencryption.service.js';

/**
 * Every hour at :20, on one instance: queues the re-encryption of every
 * tenant's and table's stale rows (ReencryptionService.schedule()), so a
 * key added in front of DATA_ENCRYPTION_KEYS or BLIND_INDEX_KEYS reaches
 * every row within the hour after the deploy. Nothing to do (and no
 * query) while no column is declared encrypted.
 */
@Injectable()
export class ReencryptionScheduler {
  constructor(
    private readonly reencryption: ReencryptionService,
    private readonly system: SystemContext,
  ) {}

  /** Returns how many jobs it queued. */
  @Cron('20 * * * *', { name: 'reencryption' })
  @OnOneInstance({ key: 'encryption:reencryption' })
  @WithoutOverlapping()
  run() {
    if (encryptedColumns().length === 0) {
      return Promise.resolve(0);
    }
    return this.system.run(
      REENCRYPTION_JOB,
      () => this.reencryption.schedule(),
      // forEachTenant() gives each tenant its own scope.
      { transaction: false },
    );
  }
}
