import type { ConfigService } from '@nestjs/config';
import { HttpClient, HttpTimeoutError } from '@nestjs/http-client';
import { UnrecoverableError } from 'bullmq';
import type { PlatformEnv } from '../platform.env.js';
import { PdfRejectedError, PdfRenderer } from './pdf-renderer.js';

const PDF = Buffer.from('%PDF-1.7\n%stub\n');

/** A renderer whose Gotenberg answers with `answer` (and records the request). */
function renderer(
  answer: (request: Request) => Promise<Response> | Response,
  { url = 'http://gotenberg:3000', timeout = 1000 } = {},
) {
  const requests: Request[] = [];
  const http = new HttpClient({
    baseUrl: url,
    timeout,
    retry: false,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      return answer(request);
    },
  });
  const config = {
    get: (key: string) => (key === 'GOTENBERG_URL' ? url : undefined),
  } as unknown as ConfigService<PlatformEnv, true>;
  return { pdf: new PdfRenderer(http, config), requests };
}

describe('PdfRenderer', () => {
  it("posts the page to Gotenberg's Chromium route as index.html, and returns the PDF", async () => {
    const { pdf, requests } = renderer(() => new Response(PDF));
    const out = await pdf.render('<!DOCTYPE html><p>Hi</p>', { trace: 'd1' });

    expect(out.equals(PDF)).toBe(true);
    const [request] = requests;
    expect(request!.method).toBe('POST');
    expect(new URL(request!.url).pathname).toBe('/forms/chromium/convert/html');
    expect(request!.headers.get('gotenberg-trace')).toBe('d1');
    const form = await request!.formData();
    const file = form.get('files') as File;
    expect(file.name).toBe('index.html');
    expect(await file.text()).toBe('<!DOCTYPE html><p>Hi</p>');
    expect(form.get('preferCssPageSize')).toBe('true');
  });

  it.each([400, 409, 413])(
    'gives up on a %s: the same page would be refused again',
    async (status) => {
      const { pdf } = renderer(() => new Response('no', { status }));
      const error = await pdf.render('<p/>', { trace: 'd' }).catch((e) => e);
      expect(error).toBeInstanceOf(PdfRejectedError);
      expect(error).toBeInstanceOf(UnrecoverableError);
      expect(error.status).toBe(status);
    },
  );

  it.each([408, 429, 500, 503])(
    'lets the queue try a %s again',
    async (status) => {
      const { pdf } = renderer(() => new Response('busy', { status }));
      const error = await pdf.render('<p/>', { trace: 'd' }).catch((e) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(UnrecoverableError);
    },
  );

  it('times out, retryably', async () => {
    const { pdf } = renderer(
      (request) =>
        new Promise((_resolve, reject) =>
          request.signal.addEventListener('abort', () =>
            reject(request.signal.reason),
          ),
        ),
      { timeout: 50 },
    );
    const error = await pdf.render('<p/>', { trace: 'd' }).catch((e) => e);
    expect(error).toBeInstanceOf(HttpTimeoutError);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
  });

  it('refuses an answer that is not a PDF', async () => {
    const { pdf } = renderer(() => new Response('<html>oops</html>'));
    await expect(pdf.render('<p/>', { trace: 'd' })).rejects.toThrow(
      'something other than a PDF',
    );
  });

  it('is off without GOTENBERG_URL', () => {
    const config = { get: () => undefined } as unknown as ConfigService<
      PlatformEnv,
      true
    >;
    expect(new PdfRenderer(new HttpClient(), config).enabled).toBe(false);
  });
});
