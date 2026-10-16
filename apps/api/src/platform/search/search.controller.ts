import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { z } from 'zod';
import { listSchema } from '../../core/http/pagination.js';
import type { Principal } from '../../iam/auth/principal.js';
import { SearchRegistry } from './search.registry.js';

const searchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(200).meta({ example: 'dark mode -legacy' }),
    subject: z
      .string()
      .max(100)
      .optional()
      .describe('Only this kind of record (`Note`); default: every kind.'),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    lang: z.string().max(35).optional(),
  })
  .strict();

const hitSchema = z.object({
  subject: z.string(),
  id: z.string(),
  title: z.string(),
  snippet: z.string().nullable(),
  score: z.number(),
  link: z.string().nullable(),
});

/** One search box over every kind of record the caller may read. */
@ApiTags('search')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@Controller('search')
export class SearchController {
  constructor(private readonly registry: SearchRegistry) {}

  @Get()
  @Can.Anyone() // Each source filters by what the caller may read.
  @ApiOperation({
    summary: 'Search every kind of record you may read',
    description:
      'Words match anywhere; "quoted words" as a phrase; -word excludes; or between words. Best matches first, across kinds; snippets mark the matches with <b>…</b>.',
  })
  @ApiOkResponse({ standardSchema: listSchema(hitSchema) })
  async search(
    @CurrentUser() user: Principal,
    @Query({ schema: searchQuerySchema })
    query: z.infer<typeof searchQuerySchema>,
  ) {
    const sources = query.subject
      ? [this.registry.get(query.subject)].filter((s) => s !== undefined)
      : this.registry.all();
    const hits = (
      await Promise.all(
        sources.map((source) => source.search(user, query.q, query.limit)),
      )
    ).flat();
    hits.sort((a, b) => b.score - a.score);
    return { items: hits.slice(0, query.limit) };
  }
}
