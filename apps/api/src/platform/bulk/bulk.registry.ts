import { Injectable } from '@nestjs/common';
import type { BulkOperation } from './bulk.types.js';

/** The bulk operations the features registered, by name. */
@Injectable()
export class BulkRegistry {
  private readonly operations = new Map<string, BulkOperation>();

  register(operation: BulkOperation<any>) {
    if (this.operations.has(operation.name)) {
      throw new Error(`Two bulk operations are named "${operation.name}".`);
    }
    this.operations.set(operation.name, operation);
  }

  get(name: string) {
    return this.operations.get(name);
  }
}
