import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import type { CoreEnv } from '../../core/config/core.env.js';
import {
  DOCUMENT_TEMPLATES_DIR,
  DocumentTemplates,
  textDirection,
} from './document-templates.js';

const templates = new DocumentTemplates({
  get: () => 'test',
} as unknown as ConfigService<CoreEnv, true>);

/** The note template with these values, as NoteDocuments fills it. */
const note = (
  values: Partial<Record<string, string | null>> = {},
  locale = 'en',
) =>
  templates.render(
    'note',
    {
      labels: {
        document: 'Note',
        number: 'Number',
        status: 'Status',
        created: 'Created',
        published: 'Published',
        issued: 'Issued today',
      },
      note: {
        title: 'Hello',
        number: 'NOTE-2026-00001',
        status: 'Draft',
        body: 'World',
        createdAt: 'today',
        publishedAt: null,
        ...values,
      },
    },
    { locale, title: values.title ?? 'Hello' },
  );

/** The page's body: what the note template put in it, without the layout. */
const body = (html: string) => html.slice(html.indexOf('<body>'));

describe('document templates', () => {
  it.each([
    ['a script', '<script>alert(1)</script>'],
    ['an image with a handler', '<img src=x onerror="alert(1)">'],
    ['an attribute breakout', '"><svg onload=alert(1)>'],
    ['a single-quote breakout', "' onmouseover='alert(1)"],
    [
      'a remote stylesheet',
      '<link rel="stylesheet" href="https://evil.example/x.css">',
    ],
    [
      'a style with a remote URL',
      '<style>@import url(https://evil.example/x.css)</style>',
    ],
    ['an iframe', '<iframe src="file:///etc/passwd"></iframe>'],
    ['a comment closer', '--><script>alert(1)</script><!--'],
  ])('keeps %s inert, in every field', async (_name, payload) => {
    const html = await note({
      title: payload,
      number: payload,
      status: payload,
      body: payload,
      createdAt: payload,
      publishedAt: payload,
    });
    const page = body(html);
    // Nothing the values carried became markup: no tag, no attribute.
    expect(page).not.toMatch(/<(script|img|svg|link|style|iframe)\b/i);
    // A `<` the values carried is escaped: every tag here is the template's.
    expect(page).not.toMatch(/<[^>]*\son[a-z]+\s*=/i);
    expect(page).not.toContain('-->');
    // The text is there, escaped, as a reader sees it.
    expect(page).toContain(
      payload
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;'),
    );
    // The title in <head> is escaped too.
    expect(html).not.toMatch(/<title>[^<]*<(script|img|svg)/i);
  });

  it('never evaluates template syntax that comes in a value', async () => {
    const html = await note({
      title: '{{ @root.labels.document }}',
      body: '{{{ dir }}}',
    });
    expect(body(html)).toContain('{{ @root.labels.document }}');
    expect(body(html)).toContain('{{{ dir }}}');
  });

  it('leaves out an empty text and an unpublished date', async () => {
    const html = await note({ body: null, number: null });
    expect(html).not.toContain('class="text"');
    expect(html).not.toContain('NOTE-2026');
    expect(html).not.toContain('Published');
  });

  it('writes Arabic right to left, with its language on the page', async () => {
    const html = await note({ title: 'مرحبا بالعالم' }, 'ar');
    expect(html).toContain('<html lang="ar" dir="rtl">');
    expect(html).toContain('مرحبا بالعالم');
  });

  it.each([
    ['ar', 'rtl'],
    ['ar-AE', 'rtl'],
    ['he', 'rtl'],
    ['fa_IR', 'rtl'],
    ['en', 'ltr'],
    ['en-SG', 'ltr'],
    ['zh', 'ltr'],
    ['ms', 'ltr'],
    ['de', 'ltr'],
  ])('reads %s as %s', async (locale, dir) => {
    expect(textDirection(locale)).toBe(dir);
    expect(await note({}, locale)).toContain(
      `<html lang="${locale}" dir="${dir}">`,
    );
  });

  describe('the template files', () => {
    const files = readdirSync(DOCUMENT_TEMPLATES_DIR, { recursive: true })
      .map(String)
      .filter((file) => file.endsWith('.html'));
    const read = (file: string) =>
      readFileSync(join(DOCUMENT_TEMPLATES_DIR, file), 'utf8');

    it('exist', () => {
      expect(files).toEqual(
        expect.arrayContaining(['layout.html', 'note.html']),
      );
    });

    it.each(files)(
      '%s inserts nothing unescaped (but the layout its body)',
      (file) => {
        const raw = [...read(file).matchAll(/\{\{\{\s*([^}]*?)\s*\}\}\}/g)].map(
          (match) => match[1],
        );
        expect(raw).toEqual(file.startsWith('layout') ? ['body'] : []);
      },
    );

    it.each(files)(
      '%s loads nothing: no URL, script, link, frame or import',
      (file) => {
        const text = read(file);
        expect(text).not.toMatch(/\b(https?|ftp|wss?):|\/\/[a-z0-9]/i);
        expect(text).not.toMatch(/<(script|link|iframe|object|embed|base)\b/i);
        expect(text).not.toMatch(/\b(src|href|srcset|action)\s*=/i);
        expect(text).not.toMatch(/url\(|@import/i);
      },
    );

    it.each(files)('%s puts no value inside a <style>', (file) => {
      for (const [, css] of read(file).matchAll(
        /<style>([\s\S]*?)<\/style>/g,
      )) {
        expect(css).not.toContain('{{');
      }
    });
  });
});
