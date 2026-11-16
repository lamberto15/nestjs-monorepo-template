// What `pnpm capability:remove` (tools/feature/remove-capability.mjs) needs
// to know of each platform capability it can take out, beyond what it
// derives: the folder (apps/api/src/platform/<name>/), its module, queue and
// settings in the composition files, its tables in the schema barrel, its
// e2e test (apps/api/test/<name>.e2e-spec.ts), the web app's feature folder,
// routes and locale files (the feature paths), its docs page
// (docs/<name>.md) and the links to it, and every `capability:<name> begin`
// … `end` block in shared files. Only true leaves are here: no other
// capability imports them.
//
// Each entry:
//   about:        what it is, for the command's messages
//   files:        more files to delete (adapters in features and fixtures,
//                 tests named otherwise), relative to the repository
//   texts:        keys in shared locale files ({ app: 'web' | 'api', file, key })
//   dependencies: packages only it uses, by workspace package: the command
//                 prints the `pnpm remove` for them (never edits package.json)
//   sections:     [file, heading]: a docs page's section (the heading and
//                 what is under it, up to the next heading of its level)
//   edits:        [file, text, replacement]: prose a marker can't hold (a
//                 name inside a line, a Markdown table's row); the command
//                 fails unless each text is there once

export const REMOVABLE = {
  ai: {
    about: 'the AI helper (docs/ai.md)',
    files: [
      'apps/api/src/features/notes/note-ai.ts',
      'apps/api/test/fixtures/test-items/test-item-ai.ts',
      'apps/api/test/ai-off.e2e-spec.ts',
      'apps/web/src/features/notes/note-ai.test.tsx',
    ],
    texts: [{ app: 'web', file: 'settings.json', key: ['groups', 'ai'] }],
    dependencies: {
      '@nestjs-monorepo-template/api': [
        '@ai-sdk/anthropic',
        '@nestjs/ai',
        'ai',
      ],
    },
    edits: [
      ['AGENTS.md', ' `deliverability`, `ai`, ', ' `deliverability`, '],
      [
        'docs/configuration.md',
        '`DOCUMENTS` (2), `AI` (2), ',
        '`DOCUMENTS` (2), ',
      ],
      [
        'docs/configuration.md',
        '`RESEND_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, ',
        '`RESEND_WEBHOOK_SECRET`, ',
      ],
      ['docs/configuration.md', ', the AI helper (`ANTHROPIC_API_KEY`)', ''],
      [
        'docs/deployment.md',
        '| `ANTHROPIC_API_KEY_FILE` | the app (api, worker; not `migrate`) | `ANTHROPIC_API_KEY` |\n',
        '',
      ],
      ['docs/architecture.md', ' AI sources (`AiRegistry`),', ''],
      [
        'docs/adding-a-feature.md',
        "  note-ai.ts                            the AI helper's source\n",
        '',
      ],
      [
        'docs/adding-a-feature.md',
        '    The AI helper on its records: an `AiSource` (`<item>-ai.ts`) registered into\n    `AiRegistry` (ai.md). Rules',
        '    Rules',
      ],
    ],
  },
  forms: {
    about: 'runtime forms and their submissions (docs/forms.md)',
    files: [
      'apps/web/src/routes/public-form.tsx',
      'apps/web-e2e/test/forms.spec.ts',
    ],
    texts: [{ app: 'api', file: 'permissions.json', key: ['form'] }],
    edits: [
      [
        'AGENTS.md',
        '  `forms` (runtime forms and submissions), `bulk-operations`',
        '  `bulk-operations`',
      ],
      [
        'docs/auth.md',
        ", and a public form's\n`POST /v1/public/forms/submit`, action `public-form`: forms) can ask",
        ') can ask',
      ],
    ],
  },
  presence: {
    about: 'who else is on a record (docs/work-surfaces.md, "Record presence")',
    files: ['apps/web/src/features/work/presence-indicator.tsx'],
    texts: [{ app: 'web', file: 'work.json', key: ['presence'] }],
    sections: [['docs/work-surfaces.md', '## Record presence']],
    edits: [
      [
        'AGENTS.md',
        '(inbox, recent records, presence)',
        '(inbox, recent records)',
      ],
      [
        'README.md',
        'the work inbox, recent records, record presence',
        'the work inbox, recent records',
      ],
      [
        'docs/work-surfaces.md',
        'Three small surfaces that help a person get back to and finish their work: a\n**work inbox** (what waits on me), **recent records** (what I opened lately)\nand **record presence** (who else is on this record).',
        'Two small surfaces that help a person get back to and finish their work: a\n**work inbox** (what waits on me) and **recent records** (what I opened\nlately).',
      ],
      [
        'docs/work-surfaces.md',
        '`platform/recents`, `platform/presence`;',
        '`platform/recents`;',
      ],
      [
        'docs/work-surfaces.md',
        '- **Presence:** `PresenceIndicator` on a record page shows the other people\n  there (and a warning when someone is editing); `usePresence()` beats while\n  the page is open.\n',
        '',
      ],
      [
        'docs/webhooks-and-realtime.md',
        '| `record.presence`            | someone arrived on, left or changed mode on a record you are on (docs/work-surfaces.md) | `{ subject, recordId }` (ids only; `GET /v1/presence/{subject}/{recordId}`) |\n',
        '',
      ],
    ],
  },
  'data-quality': {
    about: 'data-quality checks, scans and findings (docs/data-quality.md)',
    files: ['apps/api/src/features/notes/note-quality.ts'],
    texts: [{ app: 'api', file: 'permissions.json', key: ['data-quality'] }],
    edits: [
      [
        'AGENTS.md',
        '  (exports, imports), `import-limits`, `reports`, `data-quality` (checks,\n  scans, findings).\n',
        '  (exports, imports), `import-limits`, `reports`.\n',
      ],
      ['docs/monorepo.md', ' `/branding`, `/data-quality`, ', ' `/branding`, '],
      [
        'docs/merging.md',
        '`MERGES` next to `mergeRoutes(NOTE_ROUTES, …)`). Background scans for duplicates\nbelong to data quality, not here: this finds them when a record is created\nor changed, or on demand.\n',
        '`MERGES` next to `mergeRoutes(NOTE_ROUTES, …)`). It finds duplicates when a\nrecord is created or changed, or on demand.\n',
      ],
      [
        'docs/adding-a-feature.md',
        "\nA record's references are also what the data-quality scan checks (one to a\nrecord in the recycle bin is an error); `quality: { recommended, duplicates }`\nin the declaration adds empty fields and duplicate candidates\n(data-quality).\n",
        '',
      ],
    ],
  },
  messaging: {
    about:
      'push and SMS: devices, phone numbers, their channels (docs/notifications.md, "Push and SMS")',
    files: [
      'apps/web/src/features/notifications/phone-devices.tsx',
      'apps/web/src/features/notifications/phone-devices.test.tsx',
      'apps/web/src/features/notifications/web-push.ts',
      'apps/web/public/push-sw.js',
      'tools/setup/vapid.mjs',
    ],
    texts: [
      {
        app: 'api',
        file: 'permissions.json',
        key: ['systemJobs', 'messaging'],
      },
      {
        app: 'api',
        file: 'permissions.json',
        key: ['systemJobs', 'messaging-inbound'],
      },
      {
        app: 'api',
        file: 'permissions.json',
        key: ['systemJobs', 'messaging-retention'],
      },
      { app: 'web', file: 'settings.json', key: ['groups', 'messaging'] },
      { app: 'web', file: 'notifications.json', key: ['phone'] },
      { app: 'web', file: 'notifications.json', key: ['devices'] },
    ],
    dependencies: {
      '@nestjs-monorepo-template/api': ['web-push', '@types/web-push'],
    },
    sections: [['docs/notifications.md', '## Push and SMS']],
    edits: [
      [
        'README.md',
        'notifications (in-app, realtime, mail, webhook, push, SMS; preferences, digests)',
        'notifications (in-app, realtime, mail, webhook; preferences, digests)',
      ],
      [
        'README.md',
        'in-app, realtime, mail, webhook, push and SMS; preferences, digests',
        'in-app, realtime, mail and webhook; preferences, digests',
      ],
      [
        'docs/notifications.md',
        'mailed at once or in a digest, pushed to a phone or texted, sent to an API client as a',
        'mailed at once or in a digest, sent to an API client as a',
      ],
      ['docs/architecture.md', ' push and SMS channels (`messaging/`),', ''],
      [
        'docs/configuration.md',
        '`MAIL` (5), `MESSAGING` (5), ',
        '`MAIL` (5), ',
      ],
      [
        'docs/configuration.md',
        '| Push and SMS | `SMS_PROVIDER` (`off`, `twilio`, `memory`: off), `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (secret), `TWILIO_FROM` (a number or a Messaging Service SID), `TWILIO_WEBHOOK_URL` (when a proxy changes the URL Twilio signs), `TWILIO_API_URL`; `PUSH_PROVIDER` (comma-separated: `off`, `web-push`, `apns`, `fcm`, `memory`: off), `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY` (secret), `WEB_PUSH_SUBJECT`; `APNS_KEY_ID`, `APNS_PRIVATE_KEY` (secret), `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_API_URL`; `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY` (secret), `FCM_API_URL`, `FCM_TOKEN_URL`; the toll-fraud caps `SMS_ALLOWED_PREFIXES` (`+1,+44`; empty: no SMS is sent), `SMS_DAILY_LIMIT_PER_TENANT` (200), `SMS_DAILY_LIMIT_PER_PREFIX` (100), `SMS_DAILY_LIMIT_PER_USER` (10), `SMS_DAILY_LIMIT_PER_IP` (20); the spend cap `SMS_MONTHLY_BUDGET_MINOR` (0: none), `SMS_PRICES` (`+1=79,+44=120`), `SMS_PRICE_DEFAULT_MINOR` (0); the limits `SMS_MAX_LENGTH` (320), `PUSH_MAX_PAYLOAD_BYTES` (3500), `DEVICES_RETENTION_DAYS` (270); [notifications.md](notifications.md#push-and-sms) |\n',
        '',
      ],
      [
        'docs/configuration.md',
        '), Web Push\n  (`PUSH_PROVIDER`, `WEB_PUSH_SUBJECT`) and SMS through Twilio (`SMS_PROVIDER`,\n  `TWILIO_*`, `SMS_ALLOWED_PREFIXES`; with none listed no SMS is sent, and\n  the wizard warns). APNs and FCM are set in the file\n  ([notifications.md](notifications.md#push-and-sms)); a re-run keeps what the\n  file names for `PUSH_PROVIDER`. It asks',
        '). It asks',
      ],
      [
        'docs/configuration.md',
        '`TWILIO_AUTH_TOKEN`, `WEB_PUSH_VAPID_PRIVATE_KEY`, `APNS_PRIVATE_KEY`, `FCM_PRIVATE_KEY`, ',
        '',
      ],
      [
        'docs/deployment.md',
        '| `TWILIO_AUTH_TOKEN_FILE` | the app (api, worker; not `migrate`) | `TWILIO_AUTH_TOKEN` |\n| `WEB_PUSH_VAPID_PRIVATE_KEY_FILE` | the app (api, worker; not `migrate`) | `WEB_PUSH_VAPID_PRIVATE_KEY` |\n| `APNS_PRIVATE_KEY_FILE` | the app (api, worker; not `migrate`) | `APNS_PRIVATE_KEY` |\n| `FCM_PRIVATE_KEY_FILE` | the app (api, worker; not `migrate`) | `FCM_PRIVATE_KEY` |\n',
        '',
      ],
      [
        'docs/deployment.md',
        '| `SmsBlocked`, `SmsBudgetNearCap`                             | SMS refused today by a toll-fraud cap, the allowlist or the spend cap (any, by reason, for 5 min); a tenant used 80% of its monthly SMS budget ([notifications.md](notifications.md#push-and-sms)) | warning           |\n',
        '',
      ],
      [
        'docs/deployment.md',
        "(an SSO connection's client secret is;\n  so are push tokens and phone numbers): `DATA_ENCRYPTION_KEYS` and",
        "(an SSO connection's client secret is):\n  `DATA_ENCRYPTION_KEYS` and",
      ],
      [
        'docs/encryption.md',
        '  keys, push tokens, phone numbers); the tests',
        '  keys); the tests',
      ],
      [
        'docs/permissions.md',
        '`retention`, `messaging`, `messaging-inbound`, `messaging-retention` (platform,',
        '`retention` (platform,',
      ],
      [
        'docs/background-work.md',
        'mail-event, messaging, usage',
        'mail-event, usage',
      ],
      [
        'docs/monorepo.md',
        '`/account/notifications` (notification preferences, the SMS number with its confirmation code, the push devices)',
        '`/account/notifications` (notification preferences)',
      ],
    ],
  },
};
