import { Injectable, Logger } from '@nestjs/common';
import type { z } from 'zod';
import type { clientErrorReportSchema } from './client-errors.schemas.js';

type ClientErrorReport = z.infer<typeof clientErrorReportSchema>;

/**
 * Logs a web app's unexpected error (report-error.ts's `send`): one line, at
 * `error`, so it reaches the same place every server-side one does
 * (requestId correlates it to the access log, and the registry
 * (core/logging/redaction.ts) keeps a pasted secret out of `message` or
 * `stack` the same way it does everywhere else). Nothing is stored beyond
 * the log: a client error is noise to watch, not a record to keep or query.
 */
@Injectable()
export class ClientErrorsService {
  private readonly logger = new Logger(ClientErrorsService.name);

  report(report: ClientErrorReport) {
    this.logger.error(
      `[${report.id}] ${report.source} error on ${report.path}: ${report.message}`,
      report.stack,
    );
  }
}
