import { Injectable, Logger } from '@nestjs/common';
import { encryptedProperties } from '../../core/encryption/encrypted-columns.js';
import type {
  DataExporter,
  DataImporter,
  TransferColumn,
  TransferFinished,
} from './data-transfer.types.js';

/** Told when a transfer finishes (on the worker that ran it). */
export type TransferListener = (
  finished: TransferFinished,
) => Promise<void> | void;

/** The exporters and importers the features registered, by name. */
@Injectable()
export class DataTransferRegistry {
  private readonly exporters = new Map<string, DataExporter>();
  private readonly importers = new Map<string, DataImporter>();
  private readonly listeners: TransferListener[] = [];
  private readonly logger = new Logger('DataTransfer');

  registerExporter(exporter: DataExporter<any>) {
    this.claim(this.exporters, exporter.name, 'exporter');
    assertNoEncryptedColumns(exporter.name, exporter.columns);
    this.exporters.set(exporter.name, exporter);
  }

  registerImporter(importer: DataImporter<any>) {
    this.claim(this.importers, importer.name, 'importer');
    this.importers.set(importer.name, importer);
  }

  exporter(name: string) {
    return this.exporters.get(name);
  }

  importer(name: string) {
    return this.importers.get(name);
  }

  allExporters() {
    return [...this.exporters.values()];
  }

  allImporters() {
    return [...this.importers.values()];
  }

  /**
   * Calls `listener` when a transfer finishes, completed or failed for good,
   * on the worker that ran it (register from a constructor, as exporters
   * do). Tell yours apart by the job's `tag` (`startExport({ tag })`). A
   * listener's error is logged; it never fails the transfer.
   */
  onFinished(listener: TransferListener) {
    this.listeners.push(listener);
  }

  /** Tells the listeners (the processor calls it). */
  async finished(event: TransferFinished) {
    for (const listener of this.listeners) {
      try {
        await listener(event);
      } catch (error) {
        this.logger.error('A transfer listener failed', {
          id: event.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private claim(map: Map<string, unknown>, name: string, kind: string) {
    if (map.has(name)) {
      throw new Error(`Two data ${kind}s are named "${name}".`);
    }
  }
}

/**
 * An export never writes an encrypted column (core/encryption) as it is
 * stored: a cell for one needs a `value` that decrypts it, in an exporter
 * whose permission check lets the reader see it (docs/encryption.md).
 * Boot fails for a plain column naming one, so it can't leak by default.
 */
export function assertNoEncryptedColumns(
  exporter: string,
  columns: readonly TransferColumn[],
) {
  const names = encryptedProperties();
  const leaking = columns.filter((c) => !c.value && names.has(c.key));
  if (leaking.length > 0) {
    throw new Error(
      `Exporter "${exporter}": ${leaking.map((c) => c.key).join(', ')} is an encrypted column; give it a \`value\` that decrypts it for readers allowed to see it, or leave it out.`,
    );
  }
}
