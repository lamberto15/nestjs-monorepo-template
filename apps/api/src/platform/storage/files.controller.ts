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
 * Serves the private disk's signed URLs when it's a local disk: the
 * signature in the query string is the credential (no session needed), it
 * names one key, one method and an expiry. With S3, the URLs point at the
 * bucket and this route answers 404.
 */
@ApiExcludeController()
@Public()
@Controller({ path: FILES_ROUTE, version: VERSION_NEUTRAL })
export class FilesController {
  constructor(private readonly disk: StorageDisk) {}

  @Get()
  download(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return serveSignedUrl(this.disk, { req, res });
  }

  @Put()
  async upload(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await receiveSignedUpload(this.disk, { req, res });
  }
}
