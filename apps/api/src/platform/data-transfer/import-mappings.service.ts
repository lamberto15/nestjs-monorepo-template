import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, asc, count, eq } from 'drizzle-orm';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { uniqueToConflict } from '../../iam/access/api-clients.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import { defineResource } from '../../iam/resources/resource.js';
import { DataTransferService } from './data-transfer.service.js';
import {
  type CreateImportMappingDto,
  MAX_MAPPINGS_PER_IMPORT,
} from './import-mappings.schemas.js';
import {
  importMappings,
  type ImportMappingRow,
} from './import-mappings.tables.js';
import { mappingProblems, staleTargets } from './import-mapping.js';

/** Audited as `importMapping.created` and `importMapping.deleted`. */
export const IMPORT_MAPPING = defineResource({
  subject: 'ImportMapping',
  audit: {},
});

/**
 * The tenant's saved column mappings of an import. Whoever may run the import
 * may read, save and delete them (the template's own permission:
 * `mappableColumns` answers 404 otherwise). Every read says which targets
 * are stale for the caller, and a save is refused as the import would be.
 */
@Injectable()
export class ImportMappingsService {
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly transfers: DataTransferService,
    private readonly audit: AuditService,
  ) {}

  async list(principal: RequestPrincipal, importer: string) {
    const columns = await this.transfers.mappableColumns(principal, importer);
    const rows = await this.db
      .select()
      .from(importMappings)
      .where(eq(importMappings.importer, importer))
      .orderBy(asc(importMappings.name));
    return {
      items: rows.map((row) =>
        this.item(row, staleTargets(row.mapping, columns)),
      ),
    };
  }

  async create(
    principal: RequestPrincipal,
    importer: string,
    dto: CreateImportMappingDto,
    ip?: string,
  ) {
    const columns = await this.transfers.mappableColumns(principal, importer);
    const problems = mappingProblems(dto.mapping, columns);
    if (problems.length) throw new BadRequestException(problems.join(' '));
    const row = await inTransaction(this.txHost, async (tx) => {
      const [{ total }] = await tx
        .select({ total: count() })
        .from(importMappings)
        .where(eq(importMappings.importer, importer));
      if (total! >= MAX_MAPPINGS_PER_IMPORT) {
        throw new BadRequestException(
          `At most ${MAX_MAPPINGS_PER_IMPORT} saved mappings per import: delete one first.`,
        );
      }
      const [created] = await tx
        .insert(importMappings)
        .values({ importer, name: dto.name, mapping: dto.mapping })
        .returning()
        .catch((error: unknown) => {
          throw uniqueToConflict(
            error,
            `A mapping named "${dto.name}" exists for this import.`,
          );
        });
      await this.audit.recordChange(
        principal,
        IMPORT_MAPPING,
        { action: 'created', id: created!.id, after: created! },
        tx,
        ip,
      );
      return created!;
    });
    return this.item(row, []);
  }

  async remove(
    principal: RequestPrincipal,
    importer: string,
    id: string,
    ip?: string,
  ) {
    await this.transfers.mappableColumns(principal, importer);
    await inTransaction(this.txHost, async (tx) => {
      const [deleted] = await tx
        .delete(importMappings)
        .where(
          and(eq(importMappings.id, id), eq(importMappings.importer, importer)),
        )
        .returning();
      if (!deleted) {
        throw new NotFoundException(`Mapping ${id} not found.`);
      }
      await this.audit.recordChange(
        principal,
        IMPORT_MAPPING,
        { action: 'deleted', id, before: deleted },
        tx,
        ip,
      );
    });
  }

  private item(row: ImportMappingRow, stale: string[]) {
    return {
      id: row.id,
      importer: row.importer,
      name: row.name,
      mapping: row.mapping,
      stale,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
