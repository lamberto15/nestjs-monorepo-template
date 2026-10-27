import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Public } from '@nestjs/authentication';
import { Throttle, minutes } from '@nestjs/throttler';
import { ApiNoContentResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { clientErrorReportSchema } from './client-errors.schemas.js';
import { ClientErrorsService } from './client-errors.service.js';

/**
 * Where the web app sends an error it did not expect (apps/web/src/lib/report-error.ts,
 * #751): `POST /v1/client-errors`. Public: the error can happen before
 * sign-in (the sign-in page itself, a sign-out), and this tells nothing
 * about an account either way. Rate-limited past what any one tab's
 * own limit (report-error.ts, 20/minute) already lets through, for every
 * tab and client combined.
 */
@ApiTags('client errors')
@Public()
@Controller('client-errors')
export class ClientErrorsController {
  constructor(private readonly clientErrors: ClientErrorsService) {}

  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 120, ttl: minutes(1) } })
  @ApiOperation({
    summary: 'Report a web app error it did not expect',
    description:
      'The report id shown to the user, where it was heard, its message and stack, and the route. Logged, never stored.',
  })
  @ApiNoContentResponse({ description: 'Logged.' })
  report(
    @Body({ schema: clientErrorReportSchema })
    report: z.infer<typeof clientErrorReportSchema>,
  ) {
    this.clientErrors.report(report);
  }
}
