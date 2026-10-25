import type { ConfigService } from '@nestjs/config';
import type { CoreEnv } from '../../core/config/core.env.js';
import type { Principal } from '../../iam/auth/principal.js';
import { SettingsService } from '../settings/settings.service.js';
import {
  DATA_TRANSFER_IMPORT_MAX_MIB,
  DATA_TRANSFER_IMPORT_MAX_ROWS,
} from './data-transfer.settings.js';

export interface ImportLimits {
  maxBytes: number;
  maxRows: number;
}

/** Resolve once for a request; queued jobs carry this snapshot to the worker. */
export async function importLimits(
  settings: SettingsService,
  config: ConfigService<CoreEnv, true>,
  principal: Principal,
): Promise<ImportLimits> {
  const [size, rows] = await Promise.all([
    settings.resolve(DATA_TRANSFER_IMPORT_MAX_MIB, principal),
    settings.resolve(DATA_TRANSFER_IMPORT_MAX_ROWS, principal),
  ]);
  // Environment values seed the shipped default for deployments that have
  // not saved a runtime override. They are not ceilings on tenant settings.
  return {
    maxBytes:
      size.source === 'default'
        ? config.get('IMPORT_MAX_BYTES', { infer: true })
        : size.value * 1024 * 1024,
    maxRows:
      rows.source === 'default'
        ? config.get('IMPORT_MAX_ROWS', { infer: true })
        : rows.value,
  };
}

/** Defaults for jobs queued before runtime limits were added. */
export const LEGACY_IMPORT_LIMITS: ImportLimits = {
  maxBytes: 50 * 1024 * 1024,
  maxRows: 1_000_000,
};
