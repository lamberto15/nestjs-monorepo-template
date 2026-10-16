# Email deliverability

Getting the mail the API sends into inboxes, and keeping it out of the ones
that refuse it: the domain's DNS records (SPF, DKIM, DMARC), the bounces
and complaints Amazon SES reports back, and the **suppression list** the
mail sender respects. Code: `apps/api/src/platform/deliverability/`, the
sender's side in `apps/api/src/core/mail/`.

## Why

Every mail to an address that doesn't exist, and every one a person marks
as spam, counts against the sending domain's reputation. Providers
(Gmail, Outlook) then put the rest in the spam folder; SES puts the
account under review near 5% bounces or 0.1% complaints, and suspends it
beyond. So the provider tells us about each one, and we stop writing to
that address.

## Amazon SES: the setup

SES is the template's production transport (`MAIL_TRANSPORT=ses`,
`AWS_REGION`, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` or an instance
role; `SES_ENDPOINT` only for Floci in development). Once, per sending
domain:

1. **Verify the domain** in the SES console (Verified identities → Create
   identity → Domain), with **Easy DKIM** (2048-bit). SES gives three
   CNAME records: add them to the domain's DNS. DKIM signs every mail so
   receivers know the domain really sent it.
2. **SPF:** SES sends from its own servers, so the `MAIL FROM` domain
   matters. Set a **custom MAIL FROM domain** (`mail.example.com`) on the
   identity: SES gives an MX record and a TXT record
   (`v=spf1 include:amazonses.com ~all`); add both. Without it, SPF is
   checked against `amazonses.com`, which passes but doesn't align with
   the `From` domain for DMARC.
3. **DMARC:** a TXT record at `_dmarc.example.com`:
   `v=DMARC1; p=none; rua=mailto:dmarc@example.com` to begin with (reports
   only), then `p=quarantine` and `p=reject` once the reports show every
   legitimate sender aligned. Alignment needs the DKIM record (step 1) or
   the custom MAIL FROM (step 2) on the same domain as `MAIL_FROM`.
4. **Leave the sandbox** (Account dashboard → Request production access):
   the sandbox only sends to verified addresses.
5. **Bounces and complaints to this API**, below.

`MAIL_FROM` must be an address on the verified domain
(`My App <no-reply@example.com>`).

### Bounces and complaints: the SNS topic and the webhook

SES publishes feedback to an **SNS topic**; the topic POSTs each
notification to the API, which verifies it and queues it:

1. **Create a topic** in SNS (Standard), say `ses-feedback`. Set its
   **SignatureVersion** attribute to `2` (SHA256; `1`, SHA1, is SNS's
   default and still verifies; once every topic is on 2, set
   `SES_SNS_REQUIRE_SIGNATURE_V2=on` so a version-1 message is refused).
   **Restrict who may publish to it:** anyone who can publish to the
   topic can suppress any address, so its access policy must allow
   `sns:Publish` only to SES for this account's identities:

   ```json
   {
     "Effect": "Allow",
     "Principal": { "Service": "ses.amazonaws.com" },
     "Action": "sns:Publish",
     "Resource": "arn:aws:sns:<region>:<account>:ses-feedback",
     "Condition": {
       "StringEquals": { "AWS:SourceAccount": "<account>" },
       "StringLike": { "AWS:SourceArn": "arn:aws:ses:*" }
     }
   }
   ```

   (the console's *Notifications* page adds a statement like it when you
   pick the topic; check that no `"Principal": "*"` statement remains).
   Copy the topic's ARN.
2. **Point SES at it:** on the verified identity, Notifications → Feedback
   notifications → Edit: Bounce and Complaint to the topic (Delivery too,
   if you want soft-bounce counts reset by successful deliveries; it is
   more traffic). Tick *Include original email headers* or not: the API
   reads neither. Or, with [event publishing](https://docs.aws.amazon.com/ses/latest/dg/event-publishing-add-event-destination-sns.html),
   a configuration set with an SNS destination for `Bounce`, `Complaint`
   (and `Delivery`): the message format is the same.
3. **Configure the API:** `SES_SNS_TOPIC_ARNS=<the ARN>` (several,
   comma-separated), redeploy. Until it is set, the route refuses every
   notification (403) and nothing is written.
4. **Subscribe the endpoint:** on the topic, Create subscription →
   Protocol HTTPS → Endpoint `https://<APP_DOMAIN>/v1/webhooks/mail/ses`.
   SNS sends a `SubscriptionConfirmation`; the API checks its signature
   and topic, visits its `SubscribeURL` (after checking that is an SNS
   host too) and the subscription turns *Confirmed* by itself. Nothing to
   copy from the console. (Raw message delivery must stay **off**: the
   signature is on the SNS envelope.)
5. **Test it:** on the identity, *Send test email* with a simulator
   address (`bounce@simulator.amazonses.com`,
   `complaint@simulator.amazonses.com`): the address shows up in
   `GET /v1/mail/suppressions` within seconds, and the audit log has
   `mailSuppression.created` by `System: Mail intake`.

**What the route checks**, in order, before anything is queued
(`sns/ses-intake.ts`; every refusal is a problem with a `code`):

| Check | Refusal |
| --- | --- |
| The body is SNS's JSON (`Type`, `MessageId`, `TopicArn`, `Signature`, `SignatureVersion` 1 or 2, `SigningCertURL`…) | 400 `sns_malformed` |
| `Timestamp` is within the last hour (5 minutes of skew ahead): SNS retries within that, and a captured message can't be replayed after the events table forgot it | 400 `sns_stale` |
| `SignatureVersion` is 2 when `SES_SNS_REQUIRE_SIGNATURE_V2` is on | 401 `sns_signature_version_refused` |
| `SigningCertURL` is `https://sns.<region>.amazonaws.com[.cn]/SimpleNotificationService-<id>.pem`, no credentials, no port, no query | 401 `sns_certificate_refused`: nothing is fetched from anywhere else, whatever the message says |
| `TopicArn` is in `SES_SNS_TOPIC_ARNS` | 403 `sns_topic_not_allowed`, before the certificate is fetched |
| The RSA signature verifies with that certificate (fetched once a day per URL; at most 16 KB; valid at the time) | 401 `sns_signature_invalid`; 503 `sns_certificate_unavailable` while it can't be fetched or isn't a valid certificate (SNS retries) |
| A `SubscribeURL` is an SNS host too | 401 `sns_subscribe_url_refused` |

Then: a `SubscriptionConfirmation` is confirmed; an
`UnsubscribeConfirmation` is logged and **not** visited (a visit would
re-subscribe: if someone unsubscribed the endpoint, that is for a person
to look at); a `Notification` whose `Message` is an SES bounce, complaint
or delivery becomes events on the `mail-events` queue (job id: the
message id). The request writes nothing. The worker
(`MailEventsProcessor`, as the system principal `system:mail-intake`)
records each event once (`mail_events`, unique per message and
recipient: a redelivered notification changes nothing) and updates the
list, in one transaction with the audit entries.

Why not `@VerifyWebhook()` (the incoming-webhooks module,
[webhooks-and-realtime.md](webhooks-and-realtime.md))? It verifies HMAC
schemes keyed on a shared secret, synchronously; SNS signs with RSA and a
certificate fetched from a URL the message names. The route is its own,
with the reasons in its comments; the replay protection is the events
table's unique index instead of the inbox.

## The suppression list

One row per address (`mail_suppressions`), normalized (trimmed, lower
case):

| Reason | How it gets there | What the sender does |
| --- | --- | --- |
| `hard_bounce` | SES reports a `Permanent` bounce: the mailbox doesn't exist | sends nothing: pointless, and it costs reputation |
| `soft_bounce` | `MAIL_SOFT_BOUNCE_THRESHOLD` (3) `Transient`/`Undetermined` bounces (a full mailbox, greylisting), each within `MAIL_SOFT_BOUNCE_WINDOW_HOURS` (24) of the last; a delivery notice resets the count | sends nothing **except essential mail** for `MAIL_SOFT_BOUNCE_SUPPRESSION_HOURS` (72); then the address is only watched again |
| `complaint` | the person reported a mail as spam | sends nothing **except essential mail** (below) |
| `manual` | an administrator added it (`POST /v1/mail/suppressions`, with a note) | sends nothing, essential mail included |

Each row keeps the provider's events (`events`, `softBounces`,
`lastDetail`: the bounce sub-type and diagnostic code), when it was first
and last seen, when it was suppressed (`suppressedAt`; null while an
address is only watched for soft bounces), and how many mails were kept
from it since (`skipped`, `lastSkippedAt`). A stronger reason replaces a
weaker one (complaint > hard bounce > manual > soft bounce); a weaker
report only updates the counts.

**Essential mail.** A mail class marked `@EssentialMail()`
(`core/mail/mail-suppression.ts`) is one the person asked for or must be
told: the password reset, the sign-in link, the address confirmation,
the account-deletion notice. It still goes to an address that
**complained** (that person asked for this very mail: they are trying to
get back in, and a provider counts a complaint against mail the person
didn't want) and to one that **bounced softly** (the mailbox exists; it
was full or greylisting, and anyone could fill the soft-bounce count by
firing sign-in-link requests at someone's address while it is: a
suppression that blocked account recovery would be a lockout anyone can
cause). It never goes to an address that **bounced hard** (the mailbox
isn't there; a reset mail to it only hurts the reputation) or that an
administrator **listed** (their decision stands until they remove it).

**Soft bounces expire.** A `soft_bounce` suppression lasts
`MAIL_SOFT_BOUNCE_SUPPRESSION_HOURS` (72): a full mailbox gets emptied,
and the provider only reports a delivery when delivery notices are on.
After that the entry is watched-only again (cleared when the address is
next written to, or when its next bounce or delivery arrives); the count
starts over when the previous soft bounce is older than
`MAIL_SOFT_BOUNCE_WINDOW_HOURS` (24). Hard bounces, complaints and manual
entries last until an administrator removes them. Everything else (notifications, digests, report mails, invitations:
the recipient didn't ask) is not essential. Mark a new mail class only
when the recipient asked for it or the law requires the notice.

**The sender** (`MailProcessor`, the worker's side of the mail queue)
asks the list right before sending, not when the mail was queued (a job
may wait hours): the recipients the list names are dropped, the mail goes
to the rest, and a mail with nobody left is *done*, not failed. The job's
result lists `skipped` recipients with their reason (visible in
`GET /v1/ops/queues` while the job is kept), the entry's `skipped` count
grows, and `mail_suppressed_total{reason}` counts it. Core knows only the
`MAIL_SUPPRESSION` token; the platform provides the list behind it, so an
app without the platform sends to everyone.

**Administrators** (`MailSuppression.view`, `MailSuppression.manage`;
users only, never while impersonating):

| Need | Route |
| --- | --- |
| The list: `?address=…` (any case), `?address.endsWith=@example.com`, `?reason=complaint`, `?source=ses`, `?suppressedAt.isNull=true` (watched only), `?sort=-lastSeenAt` | `GET /v1/mail/suppressions` |
| One entry | `GET /v1/mail/suppressions/{id}` |
| Stop mail to an address (`{ address, note? }`; 409 when listed) | `POST /v1/mail/suppressions` |
| Send to it again (after checking the mailbox works, or the person asked) | `DELETE /v1/mail/suppressions/{id}` |

Audited: `mailSuppression.created` (by the intake job or the
administrator), `mailSuppression.updated` (the reason changed),
`mailSuppression.deleted`. The events behind an entry stay when the entry
is removed and are deleted after `MAIL_EVENTS_RETENTION_DAYS` (90) by
`MailEventsRetentionJob` (03:40, `system:mail-events-retention`); a new
report lists the address again.

**Personal data.** Addresses are personal data: a user's own entries
and events are in their data export (`POST /v1/account/export`, kind
`mailSuppression`) and are deleted with their account
(`PersonalDataSource.erase`). The address of a deleted account is mailed
by nothing afterwards, so nothing is lost; if the provider reports it
again, it is listed again.

## Watching it

Metrics (`GET /metrics`, [deployment.md](deployment.md#metrics)):
`mail_sent_total` (the workers), `mail_suppressed_total{reason}`,
`mail_events_total{provider,type}` (the api, as received),
`mail_suppressions{reason}` (the list's size). Alerts
(`monitoring/prometheus/alerts.yml`): `MailBounceRateHigh` (over 5% of
the mails sent in an hour bounced hard, at least 20 sent, for 15 min)
and `MailComplaints` (any complaint in the last hour: each one is worth a
look).

## Other providers

The intake is an interface (`MailEventIntake`, `mail-event.types.ts`):
`receive(request)` authenticates the provider's call and turns it into
`MailEvent`s (`hard_bounce`, `soft_bounce`, `complaint`, `delivery`, with
the address, the time and the provider's detail); the queue, the list and
the sender know no provider. Postmark, SendGrid, Resend or Mailgun would
be a class each (their webhooks are HMAC-signed JSON, so `@VerifyWebhook()`
with a custom scheme can do the verification), registered into
`MailEventIntakeRegistry` from its constructor, reached at
`POST /v1/webhooks/mail/<name>`. Keep the order of checks the SES intake
has: format, then source, then signature, and never fetch a URL the
message names without checking its host first.
