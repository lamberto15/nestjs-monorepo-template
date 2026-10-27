import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import type { StoredUpload } from '@nestjs/storage';
import { StorageDisk } from '@nestjs/storage';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiConsumes,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  pageSchema,
} from '../../core/http/pagination.js';
import { timezone } from '../../iam/account/account.schemas.js';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import { DataTransferService } from './data-transfer.service.js';
import { jobStatusFilter } from '../queues/job-status.js';
import { startedSchema, statusSchema } from './data-transfer.schemas.js';
import { TRANSFER_FORMATS } from './data-transfer.types.js';
import { CONTENT_TYPES, formatOf } from './formats.js';
import { ImportUpload } from './import-upload.interceptor.js';

const exportSchema = z.object({
  name: z.string().min(1).max(80).meta({ example: 'notes' }),
  format: z.enum(TRANSFER_FORMATS).default('csv'),
  filters: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      'The list filters of that data, as on its list route: { "status": "draft" }, or the list\'s `filter` (JSON) and `q`.',
    ),
  sort: z
    .string()
    .max(500)
    .optional()
    .describe(
      "The list's `sort` (`-createdAt,title`), checked by its declaration, so the file is in the order the list shows. Default: newest first.",
    ),
  timezone: timezone
    .optional()
    .describe(
      "The time zone of the file's dates (ISO 8601 with its offset). Default: the user's own, else the server's (APP_TIMEZONE).",
    ),
});
const templateQuerySchema = z.object({
  format: z.enum(TRANSFER_FORMATS).default('csv'),
  timezone: timezone
    .optional()
    .describe(
      "The time zone of the template's date-time columns. Default: the user's own, else the server's (APP_TIMEZONE).",
    ),
});
const importFieldsSchema = z.object({
  name: z.string().min(1).max(80).meta({ example: 'notes' }),
  matchOn: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe('Update existing rows by this declared match key.'),
  dryRun: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true')
    .describe('true: check every row, write nothing.'),
  // Documents the upload: Swagger takes a @Body schema over @ApiBody, so the
  // file is declared here. Multer has taken it out of the body by the time
  // this validates, hence optional; the route answers 400 without it.
  file: z.unknown().optional().meta({
    type: 'string',
    format: 'binary',
    description:
      'Required. CSV, JSON (an array) or Excel (.xlsx), at most 50 MB. GET /v1/data/imports/{name}/template gives one to fill.',
  }),
});
const catalogSchema = z.object({
  importLimits: z.object({ maxBytes: z.number(), maxRows: z.number() }),
  exports: z
    .array(
      z.object({
        name: z.string().meta({ example: 'notes' }),
        subject: z
          .string()
          .meta({ example: 'Note' })
          .describe(
            'The permission subject of the data: the one of its list (`GET /v1/lists/{subject}`), so a list page finds its export.',
          ),
        columns: z
          .array(z.string())
          .describe("The file's columns, in order (custom fields included)."),
        formats: z.array(z.enum(TRANSFER_FORMATS)),
      }),
    )
    .describe('The data you may export: POST /v1/data/exports { name }.'),
  imports: z
    .array(
      z.object({
        name: z.string().meta({ example: 'notes' }),
        formats: z.array(z.enum(TRANSFER_FORMATS)),
        matchKeys: z
          .array(z.string())
          .describe('Optional keys accepted by matchOn.'),
        columns: z
          .array(
            z.object({
              name: z
                .string()
                .describe(
                  'The header (a datetime column gets the zone in a template: `dueAt (Asia/Dubai)`).',
                ),
              type: z.enum([
                'text',
                'number',
                'boolean',
                'date',
                'datetime',
                'list',
              ]),
              required: z.boolean(),
              description: z.string().optional(),
              options: z
                .array(z.string())
                .optional()
                .describe('The values allowed (one, or several for a list).'),
              min: z
                .number()
                .optional()
                .describe(
                  'Length for text, value for a number, entries for a list.',
                ),
              max: z.number().optional(),
              example: z.unknown().optional(),
            }),
          )
          .describe(
            'The columns you may fill (fields your permissions hide left out).',
          ),
        template: z
          .string()
          .meta({ example: '/v1/data/imports/notes/template' })
          .describe('A file to fill: add ?format=csv|json|xlsx.'),
      }),
    )
    .describe('The data you may import: POST /v1/data/imports (name, file).'),
});
const transfersQuerySchema = z.object({
  kind: z
    .enum(['export', 'import'])
    .optional()
    .describe('Only exports, or only imports. Default: both.'),
  status: jobStatusFilter,
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z
    .uuid()
    .optional()
    .describe('`nextCursor` of the previous page (the same `kind`).'),
});
/**
 * Exports and imports of any data a feature registered (DataExporter,
 * DataImporter), as CSV, JSON or Excel. The work runs on the workers: the
 * request answers 202, the realtime connection hears `data.export-ready` /
 * `data.import-finished`, and GET /data/transfers/{id} tells the same.
 */
@ApiTags('data')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@Can.Anyone() // Each route checks the data's own permission.
@Controller('data')
export class DataTransferController {
  constructor(
    private readonly transfers: DataTransferService,
    private readonly disk: StorageDisk,
  ) {}

  @Get()
  @ApiOperation({ summary: 'What you may export and import' })
  @ApiOkResponse({ standardSchema: catalogSchema })
  catalog(@CurrentUser() user: RequestPrincipal) {
    return this.transfers.catalog(user);
  }

  @Post('exports')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Export data to a file (a background job)' })
  @ApiAcceptedResponse({ standardSchema: startedSchema })
  @ApiForbiddenResponse({
    description:
      'You may not export it (forbidden), or its filters use a field your permissions hide (field_forbidden, naming it).',
  })
  startExport(
    @CurrentUser() user: RequestPrincipal,
    @Body({ schema: exportSchema }) body: z.infer<typeof exportSchema>,
  ) {
    // Field by field: nothing a client sends reaches the code-only options
    // (`internal`, `tag`, `id`).
    return this.transfers.startExport(user, {
      name: body.name,
      format: body.format,
      filters: body.filters,
      sort: body.sort,
      timezone: body.timezone,
    });
  }

  @Post('imports')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(ImportUpload())
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'Import a file: every row is checked, valid rows are written (a background job)',
  })
  @ApiAcceptedResponse({ standardSchema: startedSchema })
  async startImport(
    @CurrentUser() user: RequestPrincipal,
    @Req() request: { importLimits: { maxBytes: number; maxRows: number } },
    @UploadedFile() file: StoredUpload | undefined,
    @Body({ schema: importFieldsSchema })
    body: z.infer<typeof importFieldsSchema>,
  ) {
    if (!file) {
      throw new BadRequestException('Attach the file as the "file" field.');
    }
    const format = formatOf(file.contentType);
    if (!format) {
      // Refused: the upload must not stay on the disk.
      await this.disk.delete(file.key).catch(() => undefined);
      throw new BadRequestException('Send CSV, JSON or Excel (.xlsx).');
    }
    return this.transfers.startImport(user, {
      name: body.name,
      key: file.key,
      format,
      dryRun: body.dryRun,
      matchOn: body.matchOn,
      limits: request.importLimits,
    });
  }

  @Get('imports/:name/template')
  @ApiOperation({
    summary: 'A file to fill for an import',
    description:
      "The columns you may import, as headers, and an example row to replace: date-times in your time zone (named in the header), lists comma-separated. The Excel file adds a Columns sheet (required, type, format, example) and dropdowns for the choices. Rows are then checked as the feature's POST checks them.",
  })
  @ApiProduces(...Object.values(CONTENT_TYPES))
  @ApiOkResponse({ description: 'The template file, as an attachment.' })
  @ApiNotFoundResponse()
  async template(
    @CurrentUser() user: RequestPrincipal,
    @Param('name') name: string,
    @Query({ schema: templateQuerySchema })
    query: z.infer<typeof templateQuerySchema>,
  ) {
    const { file, type, filename } = await this.transfers.template(
      user,
      name,
      query,
    );
    return new StreamableFile(file, {
      type,
      disposition: `attachment; filename="${filename}"`,
    });
  }

  @Get('transfers')
  @ApiOperation({
    summary: 'The exports and imports you started in this tenant',
    description:
      'Newest first, by cursor (`limit`, `cursor` = the previous `nextCursor`); `?kind=export|import`. Each item as GET /v1/data/transfers/{id} tells it, links included. Those started by you (or your scheduled reports) in the current tenant, kept 7 days after they end; the account exports (POST /v1/account/export) are listed at GET /v1/account/exports.',
  })
  @ApiOkResponse({ standardSchema: pageSchema(statusSchema) })
  list(
    @CurrentUser() user: RequestPrincipal,
    @Query({ schema: transfersQuerySchema })
    query: z.infer<typeof transfersQuerySchema>,
  ) {
    return this.transfers.list(user, query);
  }

  @Get('transfers/:id')
  @ApiOperation({
    summary:
      'An export or import you started: progress, then the result and its links',
  })
  @ApiOkResponse({ standardSchema: statusSchema })
  @ApiNotFoundResponse()
  status(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.transfers.status(user, id);
  }
}
