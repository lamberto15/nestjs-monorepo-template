import type { GetResponse } from '@nestjs-monorepo-template/api-client';

/**
 * An entry of the audit log, as GET /v1/access/audit lists it (the list
 * page asks for it, with its filters and paging: GET /v1/lists/Audit).
 */
export type AuditEntry = GetResponse<'/v1/access/audit'>['items'][number];
