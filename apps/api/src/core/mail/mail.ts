import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import {
  FileMailTransport,
  FileTemplateEngine,
  InMemoryMailTransport,
  LogMailTransport,
  MailModule,
  type MailTransport,
  PostmarkTransport,
  ResendTransport,
  SendGridTransport,
  SesTransport,
  SmtpTransport,
} from '@nestjs/mail';
import {
  awsCredentials,
  type Config,
  type CoreEnv,
} from '../config/core.env.js';

/**
 * The transport MAIL_TRANSPORT names. Built at startup: a missing SMTP_URL or
 * MAIL_API_KEY stops the app there, not at the first mail.
 */
export function mailTransport(config: Config<CoreEnv>): MailTransport {
  const required = (name: 'SMTP_URL' | 'MAIL_API_KEY') => {
    const value = config.get(name, { infer: true });
    if (!value) {
      throw new Error(
        `${name} is required with MAIL_TRANSPORT=${config.get('MAIL_TRANSPORT', { infer: true })}`,
      );
    }
    return value;
  };
  switch (config.get('MAIL_TRANSPORT', { infer: true })) {
    case 'file':
      return new FileMailTransport({
        directory: config.get('MAIL_DIRECTORY', { infer: true }),
      });
    case 'log':
      return new LogMailTransport();
    case 'smtp':
      return new SmtpTransport({ url: required('SMTP_URL'), pool: true });
    case 'resend':
      return new ResendTransport({ apiKey: required('MAIL_API_KEY') });
    case 'postmark':
      return new PostmarkTransport({ serverToken: required('MAIL_API_KEY') });
    case 'sendgrid':
      return new SendGridTransport({ apiKey: required('MAIL_API_KEY') });
    case 'ses':
      return new SesTransport({
        region: config.get('AWS_REGION', { infer: true }),
        endpoint: config.get('SES_ENDPOINT', { infer: true }),
        credentials: awsCredentials(config),
      });
    case 'memory':
      return new InMemoryMailTransport();
  }
}

/**
 * @nestjs/mail, global: inject `Mailer` and send a `Mailable` class. Bodies
 * are HTML templates in `src/mail/templates` (copied to dist), wrapped in
 * `layout.html`; `<name>.<locale>.html` is picked for that locale. Mail that
 * must not be lost goes through the outbox (see the notes feature).
 */
export const mail = () =>
  MailModule.forRootAsync({
    inject: [ConfigService],
    useFactory: (config: Config<CoreEnv>) => ({
      transport: mailTransport(config),
      templates: new FileTemplateEngine({
        dir: join(import.meta.dirname, '../../mail/templates'),
        layout: 'layout',
        // Development reads the files for every mail, so edits show without a restart.
        cache: config.get('NODE_ENV', { infer: true }) === 'production',
      }),
      from: config.get('MAIL_FROM', { infer: true }),
    }),
  });
