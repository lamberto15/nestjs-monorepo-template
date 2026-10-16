import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  HttpClient,
  HttpClientModule,
  HttpResponseError,
  InjectHttpClient,
} from '@nestjs/http-client';
import { UnrecoverableError } from 'bullmq';
import type { PlatformEnv } from '../platform.env.js';

/** The HTTP client of Gotenberg (@nestjs/http-client). */
export const GOTENBERG = 'gotenberg';

/**
 * Gotenberg's client: GOTENBERG_URL, one attempt of GOTENBERG_TIMEOUT_MS.
 * The queue retries (with backoff), not the client: a retried POST would
 * run inside the job's attempt, past its timeout.
 */
export const gotenbergClient = () =>
  HttpClientModule.registerAsync({
    name: GOTENBERG,
    inject: [ConfigService],
    useFactory: (config: ConfigService<PlatformEnv, true>) => ({
      baseUrl: config.get('GOTENBERG_URL', { infer: true }),
      timeout: config.get('GOTENBERG_TIMEOUT_MS', { infer: true }),
      retry: false,
    }),
  });

/**
 * Gotenberg refused the document itself (a 4xx other than 408 and 429):
 * the same HTML would be refused again, so the job is not retried.
 */
export class PdfRejectedError extends UnrecoverableError {
  constructor(readonly status: number) {
    // BullMQ also knows it by its name, UnrecoverableError's: kept.
    super(`Gotenberg refused the document (HTTP ${status}).`);
  }
}

/**
 * HTML to PDF, by Gotenberg's Chromium route (`/forms/chromium/convert/html`).
 * Gotenberg is its own container (Compose's `gotenberg`), never Chromium in
 * the worker: a browser that runs out of memory or is attacked doesn't take
 * the queues, workflows and database credentials with it. Custom code: no
 * @nestjs package talks to Gotenberg; its API is one multipart POST.
 */
@Injectable()
export class PdfRenderer {
  constructor(
    @InjectHttpClient(GOTENBERG) private readonly http: HttpClient,
    private readonly config: ConfigService<PlatformEnv, true>,
  ) {}

  /** Whether GOTENBERG_URL is set: documents are off without it. */
  get enabled() {
    return Boolean(this.config.get('GOTENBERG_URL', { infer: true }));
  }

  /**
   * The PDF of a whole HTML page. Its CSS `@page` sets the paper and
   * margins (A4 in the layout). `trace` goes to Gotenberg's logs
   * (`Gotenberg-Trace`): the document's id.
   */
  async render(html: string, { trace }: { trace: string }): Promise<Buffer> {
    const form = new FormData();
    // Gotenberg serves it from its own /tmp: the only URL Chromium may load.
    form.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
    form.append('preferCssPageSize', 'true');
    form.append('printBackground', 'true');
    // Headings and reading order for screen readers (PDF/UA-friendly).
    form.append('generateTaggedPdf', 'true');
    try {
      const response = await this.http.post('/forms/chromium/convert/html', {
        body: form,
        headers: { 'gotenberg-trace': trace },
        responseType: 'arrayBuffer',
      });
      const pdf = Buffer.from(response.data);
      if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') {
        throw new Error('Gotenberg answered something other than a PDF.');
      }
      return pdf;
    } catch (error) {
      if (
        error instanceof HttpResponseError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408 &&
        error.status !== 429
      ) {
        throw new PdfRejectedError(error.status);
      }
      throw error; // a timeout, a 5xx, the network: tried again
    }
  }
}
