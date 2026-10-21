import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '@nestjs/authentication';
import { Deprecated } from '../../../src/core/http/deprecated.js';

/** Test-only routes for `@Deprecated()` (test/deprecated.e2e-spec.ts). */
@ApiTags('test-deprecated')
@Controller('test-deprecated')
export class TestDeprecatedController {
  @Public()
  @Get('old')
  @Deprecated({
    since: '2026-01-01',
    sunset: '2027-01-01',
    link: 'https://example.com/docs/deprecations/old',
    successor: 'https://example.com/v2/new',
  })
  old() {
    return { ok: true };
  }

  @Public()
  @Get('current')
  current() {
    return { ok: true };
  }
}
