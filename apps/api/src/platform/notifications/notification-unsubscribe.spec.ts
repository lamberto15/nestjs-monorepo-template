import { randomBytes, randomUUID } from 'node:crypto';
import { JwtSigner } from '@nestjs/authentication';
import type { ConfigService } from '@nestjs/config';
import type { I18nService } from '@nestjs/i18n';
import type { MailRenderContext } from '@nestjs/mail';
import {
  NotificationUnsubscribeLinks,
  unsubscribeHeaders,
} from './notification-unsubscribe.js';
import {
  NotificationDigestMail,
  NotificationMail,
} from './notification.mails.js';

const ISSUER = 'https://api.example.com';
const DAY = 86_400_000;

describe('NotificationUnsubscribeLinks', () => {
  const secret = randomBytes(32).toString('base64url');

  it('names the user and the type, and the user and the digest modes', async () => {
    const links = new NotificationUnsubscribeLinks(secret, ISSUER);
    const userId = randomUUID();
    expect(
      await links.verify(links.signType(userId, 'note.published')),
    ).toEqual({ userId, type: 'note.published' });
    expect(
      await links.verify(
        links.signDigests(userId, ['daily', 'daily', 'hourly']),
      ),
    ).toEqual({ userId, digests: ['daily', 'hourly'] });
  });

  it('builds the https URL of the one-click endpoint', () => {
    const links = new NotificationUnsubscribeLinks(secret, ISSUER);
    expect(links.url('a.b.c')).toBe(
      'https://api.example.com/v1/notifications/unsubscribe/a.b.c',
    );
  });

  it('refuses a token signed with another secret, a changed one, and garbage', async () => {
    const links = new NotificationUnsubscribeLinks(secret, ISSUER);
    const userId = randomUUID();
    const forged = new NotificationUnsubscribeLinks(
      randomBytes(32).toString('base64url'),
      ISSUER,
    ).signType(userId, 'note.published');
    expect(await links.verify(forged)).toBeNull();

    // Another user's id put into a genuine token's payload: the signature fails.
    const [header, , signature] = links
      .signType(userId, 'note.published')
      .split('.');
    const payload = Buffer.from(
      JSON.stringify({ sub: randomUUID(), nt: 'note.published' }),
    ).toString('base64url');
    expect(await links.verify(`${header}.${payload}.${signature}`)).toBeNull();

    expect(await links.verify('')).toBeNull();
    expect(await links.verify('not.a.token')).toBeNull();
  });

  it('refuses a token of another kind, signed with the same secret or the key itself', async () => {
    const links = new NotificationUnsubscribeLinks(secret, ISSUER);
    const raw = new JwtSigner({
      key: Buffer.from(secret),
      issuer: ISSUER,
      audience: 'notification-unsubscribe',
      type: 'notification-unsubscribe+jwt',
    });
    expect(
      await links.verify(
        raw.sign({ sub: randomUUID(), nt: 'note.published' }, { ttl: DAY }),
      ),
    ).toBeNull();
    // Another issuer (another deployment) too.
    expect(
      await new NotificationUnsubscribeLinks(
        secret,
        'https://other.example.com',
      ).verify(links.signType(randomUUID(), 'note.published')),
    ).toBeNull();
  });

  it('refuses a token that names nothing to switch off', async () => {
    const links = new NotificationUnsubscribeLinks(secret, ISSUER);
    expect(await links.verify(links.signDigests(randomUUID(), []))).toBeNull();
  });

  it('expires after a year', async () => {
    let now = Date.now();
    const links = new NotificationUnsubscribeLinks(secret, ISSUER, () => now);
    const token = links.signType(randomUUID(), 'note.published');
    now += 364 * DAY;
    expect(await links.verify(token)).not.toBeNull();
    now += 2 * DAY;
    expect(await links.verify(token)).toBeNull();
  });
});

describe('unsubscribeHeaders (RFC 8058)', () => {
  it('sets List-Unsubscribe with the https URL and the one-click List-Unsubscribe-Post', () => {
    expect(unsubscribeHeaders('https://api.example.com/v1/x/t')).toEqual({
      'List-Unsubscribe': '<https://api.example.com/v1/x/t>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  it('adds the mailto beside the URL when configured', () => {
    expect(
      unsubscribeHeaders('https://api.example.com/v1/x/t', 'unsub@example.com')[
        'List-Unsubscribe'
      ],
    ).toBe('<https://api.example.com/v1/x/t>, <mailto:unsub@example.com>');
  });

  it('sends neither header when the URL is not https', () => {
    expect(unsubscribeHeaders('http://localhost:3000/v1/x/t')).toEqual({});
  });
});

describe('notification mail', () => {
  const links = new NotificationUnsubscribeLinks(
    randomBytes(32).toString('base64url'),
    ISSUER,
  );
  const settings: Record<string, string | undefined> = {
    SERVICE_NAME: 'Acme',
    WEB_URL: 'https://web.example.com',
    APP_URL: ISSUER,
    APP_TIMEZONE: 'UTC',
  };
  const config = {
    get: (name: string) => settings[name],
  } as unknown as ConfigService<any, true>;
  const i18n = {
    t: () => 'subject',
    formatDate: () => 'then',
  } as unknown as I18nService;
  const context = { locale: 'en' } as MailRenderContext;
  const token = links.signType(randomUUID(), 'note.published');

  const immediate = (unsubscribe: string | null) =>
    new NotificationMail(i18n, config, links).render(
      { name: 'Ada', title: 'T', body: 'B', link: null, unsubscribe },
      context,
    ) as { headers: Record<string, string>; context: Record<string, unknown> };

  it('carries the one-click headers and the footer link', () => {
    const rendered = immediate(token);
    expect(rendered.headers).toEqual({
      'List-Unsubscribe': `<${ISSUER}/v1/notifications/unsubscribe/${token}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
    expect(rendered.context.unsubscribeUrl).toBe(
      `https://web.example.com/unsubscribe?token=${encodeURIComponent(token)}`,
    );
  });

  it('adds the mailto when MAIL_UNSUBSCRIBE_MAILTO is set', () => {
    settings.MAIL_UNSUBSCRIBE_MAILTO = 'unsub@example.com';
    try {
      expect(immediate(token).headers['List-Unsubscribe']).toMatch(
        /^<https:.*>, <mailto:unsub@example\.com>$/,
      );
    } finally {
      delete settings.MAIL_UNSUBSCRIBE_MAILTO;
    }
  });

  it('offers nothing for a mandatory type (no token)', () => {
    const rendered = immediate(null);
    expect(rendered.headers).toEqual({});
    expect(rendered.context.unsubscribeUrl).toBeNull();
  });

  it('does the same for a digest', () => {
    const digest = (unsubscribe: string | null) =>
      new NotificationDigestMail(i18n, config, links).render(
        {
          name: 'Ada',
          items: [{ title: 'T', body: 'B', link: null, at: new Date() }],
          count: 1,
          more: 0,
          timezone: null,
          unsubscribe,
        },
        context,
      ) as { headers: Record<string, string> };
    expect(Object.keys(digest(token).headers)).toEqual([
      'List-Unsubscribe',
      'List-Unsubscribe-Post',
    ]);
    expect(digest(null).headers).toEqual({});
  });
});
