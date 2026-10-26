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
  // The environment values are the deployment's ceilings, as the session
  // limits are: a setting may only lower them. `restrictImportLimits()`
  // refuses a higher value; a value stored before that is capped here.
  const ceiling = importCeiling(config);
  return {
    maxBytes:
      size.source === 'default'
        ? ceiling.maxBytes
        : Math.min(size.value * MIB, ceiling.maxBytes),
    maxRows:
      rows.source === 'default'
        ? ceiling.maxRows
        : Math.min(rows.value, ceiling.maxRows),
  };
}

const MIB = 1024 * 1024;

const importCeiling = (config: ConfigService<CoreEnv, true>): ImportLimits => ({
  maxBytes: config.get('IMPORT_MAX_BYTES', { infer: true }),
  maxRows: config.get('IMPORT_MAX_ROWS', { infer: true }),
});

/** Refuses (400 `setting_not_allowed`) import limits above the deployment's. */
export function restrictImportLimits(
  settings: SettingsService,
  config: ConfigService<CoreEnv, true>,
) {
  settings.restrict(DATA_TRANSFER_IMPORT_MAX_MIB, (value) => {
    const { maxBytes } = importCeiling(config);
    return value * MIB > maxBytes
      ? `IMPORT_MAX_BYTES is ${maxBytes} in this deployment: the import size limit may only lower it.`
      : undefined;
  });
  settings.restrict(DATA_TRANSFER_IMPORT_MAX_ROWS, (value) => {
    const { maxRows } = importCeiling(config);
    return value > maxRows
      ? `IMPORT_MAX_ROWS is ${maxRows} in this deployment: the import row limit may only lower it.`
      : undefined;
  });
}

/** Defaults for jobs queued before runtime limits were added. */
export const LEGACY_IMPORT_LIMITS: ImportLimits = {
  maxBytes: 50 * 1024 * 1024,
  maxRows: 1_000_000,
};
