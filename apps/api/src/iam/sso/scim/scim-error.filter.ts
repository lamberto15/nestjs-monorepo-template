import { STATUS_CODES } from 'node:http';
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ProblemDetailsFilter } from '../../../core/http/problem-details.filter.js';

export const SCIM_CONTENT_TYPE = 'application/scim+json';

/** The schema URNs of RFC 7643 and RFC 7644 this API reads and writes. */
export const SCIM_SCHEMA = {
  user: 'urn:ietf:params:scim:schemas:core:2.0:User',
  group: 'urn:ietf:params:scim:schemas:core:2.0:Group',
  enterpriseUser: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User',
  list: 'urn:ietf:params:scim:api:messages:2.0:ListResponse',
  patch: 'urn:ietf:params:scim:api:messages:2.0:PatchOp',
  error: 'urn:ietf:params:scim:api:messages:2.0:Error',
  serviceProviderConfig:
    'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig',
  resourceType: 'urn:ietf:params:scim:schemas:core:2.0:ResourceType',
} as const;

/** RFC 7644 §3.12's `scimType` values this API answers. */
export type ScimType =
  | 'invalidFilter'
  | 'uniqueness'
  | 'mutability'
  | 'invalidSyntax'
  | 'invalidPath'
  | 'noTarget'
  | 'invalidValue';

/** An error with SCIM's `scimType` (the filter writes it into the body). */
export class ScimException extends HttpException {
  constructor(status: number, detail: string, scimType?: ScimType) {
    super({ message: detail, scimType }, status);
  }
}

/**
 * SCIM's error body (RFC 7644 §3.12) in place of problem details on the
 * SCIM routes: an identity provider's client reads `status`, `scimType`
 * and `detail`, as `application/scim+json`. What an error answers (its
 * status) is the API's one mapping, ProblemDetailsFilter.toHttp; only the
 * body differs. Controller-scoped, so the guards' 401 and 403 come here too.
 */
@Catch()
export class ScimErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('Scim');

  catch(exception: unknown, host: ArgumentsHost) {
    if (host.getType() !== 'http') {
      throw exception;
    }
    const http = ProblemDetailsFilter.toHttp(exception);
    const status = http?.getStatus() ?? 500;
    const body = http?.getResponse();
    const fields: Record<string, unknown> =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)
        : {};
    let detail =
      typeof body === 'string'
        ? body
        : typeof fields.message === 'string'
          ? fields.message
          : (STATUS_CODES[status] ?? 'Error');
    const errors = fields.errors as
      { path?: string; message?: string }[] | undefined;
    if (Array.isArray(errors) && errors.length) {
      detail = `${detail} ${errors
        .map((error) =>
          error.path ? `${error.path}: ${error.message}` : error.message,
        )
        .join('; ')}`;
    }
    if (!http || status >= 500) {
      detail = 'Something went wrong on our side.';
      const request = host.switchToHttp().getRequest<Request>();
      this.logger.error(
        `${request.originalUrl} failed: ${(exception as Error)?.message ?? exception}`,
        (exception as Error)?.stack,
      );
    }
    const scimType =
      typeof fields.scimType === 'string'
        ? fields.scimType
        : status === 400
          ? 'invalidValue'
          : status === 409
            ? 'uniqueness'
            : undefined;
    const response = host.switchToHttp().getResponse<Response>();
    response
      .status(status)
      .setHeader('Content-Type', `${SCIM_CONTENT_TYPE}; charset=utf-8`)
      .send(
        JSON.stringify({
          schemas: [SCIM_SCHEMA.error],
          status: String(status),
          ...(scimType && { scimType }),
          detail,
        }),
      );
  }
}
