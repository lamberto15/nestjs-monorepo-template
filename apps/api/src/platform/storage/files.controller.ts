import {
  Controller,
  Get,
  Put,
  Req,
  Res,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { Public } from '@nestjs/authentication';
import { ApiExcludeController } from '@nestjs/swagger';
import {
  receiveSignedUpload,
  serveSignedUrl,
  StorageDisk,
} from '@nestjs/storage';
import type { Request, Response } from 'express';
import { FILES_ROUTE } from './storage.config.js';

/**
 * The Content-Security-Policy of a served file (a PDF shown inline above
 * all): nothing may load (`default-src 'none'`), nothing frames it
 * (`frame-ancestors 'none'`), and it runs as a unique origin without
 * scripts, forms or popups (`sandbox`). Chrome's PDF viewer renders under
 * it (checked with Chrome 155); `nosniff` comes from serveSignedUrl.
 */
export const FILE_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";

/**
 * Serves the private disk's signed URLs when it's a local disk: the
 * signature in the query string is the credential (no session needed), it
 * names one key, one method and an expiry. With S3, the URLs point at the
 * bucket and this route answers 404. Tenancy (docs/tenancy.md): a URL is
 * issued only after the route that issues it checked the tenant (the
 * attachment's row, the transfer's job), and a key is under its tenant's
 * `tenants/<id>/` prefix, so a URL never reaches another tenant's file.
 */
@ApiExcludeController()
@Public()
@Controller({ path: FILES_ROUTE, version: VERSION_NEUTRAL })
export class FilesController {
  constructor(private readonly disk: StorageDisk) {}

  @Get()
  download(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // A file is never a page: whatever it is, it loads nothing, runs
    // nothing, and no page frames it. Replaces the app's policy (Swagger
    // UI's) for these responses; a PDF shown inline (?inline=true on its
    // download route) still renders in the browser's viewer.
    res.setHeader('Content-Security-Policy', FILE_CSP);
    return serveSignedUrl(this.disk, { req, res });
  }

  @Put()
  async upload(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await receiveSignedUpload(this.disk, { req, res });
  }
}
