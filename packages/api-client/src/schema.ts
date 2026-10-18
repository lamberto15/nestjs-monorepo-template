/**
 * Generated from openapi.json by `pnpm client:generate`: do not edit.
 * `pnpm client:check` fails when it is stale.
 */

export interface paths {
    "/v1/webhook-endpoints": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The client's endpoints */
        get: operations["WebhookEndpointsController_list_v1"];
        put?: never;
        /**
         * Subscribe a URL to events
         * @description Send an Idempotency-Key to retry safely: a retry with the same key returns the same endpoint instead of creating a second one.
         */
        post: operations["WebhookEndpointsController_create_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/webhook-endpoints/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** One endpoint */
        get: operations["WebhookEndpointsController_get_v1"];
        put?: never;
        post?: never;
        /** Unsubscribe */
        delete: operations["WebhookEndpointsController_delete_v1"];
        options?: never;
        head?: never;
        /**
         * Change an endpoint; only what is sent changes
         * @description `description: null` clears it; an empty string is a 400.
         */
        patch: operations["WebhookEndpointsController_update_v1"];
        trace?: never;
    };
    "/v1/webhook-endpoints/{id}/rotate-secret": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Rotate the endpoint's signing secret
         * @description The old secret keeps signing next to the new one for 24 hours.
         */
        post: operations["WebhookEndpointsController_rotateSecret_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/webhook-endpoints/{id}/test": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Send a test event to the endpoint
         * @description Sends the reserved `webhook.test` event (`data`: `{ endpointId, test: true }`) to this endpoint alone, whatever it subscribed to, signed and retried as any webhook. Returns the delivery, pending: follow it at GET …/webhook-deliveries/{id}. A disabled endpoint gets no request (the delivery fails: endpoint-disabled).
         */
        post: operations["WebhookEndpointsController_test_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/webhook-deliveries": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The delivery log, newest first
         * @description Newest first, paged by cursor (`limit`, `cursor` = the previous `nextCursor`). Filter flat (`?status=failed&endpointId=…&type.startsWith=note.&createdAt.gte=2026-01-01T00:00:00Z`) or with `filter` (and/or groups), sort with `sort=-attempts`, pick fields with `fields=status,type`; `count=true` adds `total`.
         */
        get: operations["WebhookDeliveriesController_list_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/webhook-deliveries/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** One delivery, with the message sent, every attempt, their duration and the last request */
        get: operations["WebhookDeliveriesController_get_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/webhook-deliveries/{id}/retry": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Send one delivery again, now
         * @description Same webhook-id and body: a replay of a lost webhook, or a retry of a failed one.
         */
        post: operations["WebhookDeliveriesController_retry_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/webhook-deliveries/retry": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Retry every failed delivery since an outage began */
        post: operations["WebhookDeliveriesController_retryFailed_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/webhook-event-types": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The event types an endpoint may subscribe to, by feature
         * @description Declared by the features (`PlatformModule.forRoot({ eventTypes })`, a record's `events`) and the platform (notifications, approvals), each with its description when one is declared. `"*"` subscribes to all of them; any other type is a 400 on create. The reserved test event (`webhook.test`) is not among them.
         */
        get: operations["WebhookEventTypesController_list_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/access/clients/{clientId}/webhook-endpoints": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The client's endpoints */
        get: operations["ClientWebhooksController_list_v1"];
        put?: never;
        /**
         * Subscribe a URL to the client's events
         * @description The secret is in the response, this once. Send an Idempotency-Key to retry safely.
         */
        post: operations["ClientWebhooksController_create_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/access/clients/{clientId}/webhook-endpoints/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** One of its endpoints */
        get: operations["ClientWebhooksController_get_v1"];
        put?: never;
        post?: never;
        /** Unsubscribe */
        delete: operations["ClientWebhooksController_delete_v1"];
        options?: never;
        head?: never;
        /**
         * Change an endpoint; only what is sent changes
         * @description `description: null` clears it; an empty string is a 400.
         */
        patch: operations["ClientWebhooksController_update_v1"];
        trace?: never;
    };
    "/v1/access/clients/{clientId}/webhook-endpoints/{id}/rotate-secret": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Rotate the endpoint's signing secret
         * @description The new secret is in the response, this once; the old one keeps signing next to it for 24 hours.
         */
        post: operations["ClientWebhooksController_rotateSecret_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/access/clients/{clientId}/webhook-endpoints/{id}/test": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Send a test event to the endpoint
         * @description Sends the reserved `webhook.test` event (`data`: `{ endpointId, test: true }`) to this endpoint alone, whatever it subscribed to, signed and retried as any webhook. Returns the delivery, pending: follow it at GET …/webhook-deliveries/{id}. A disabled endpoint gets no request (the delivery fails: endpoint-disabled).
         */
        post: operations["ClientWebhooksController_test_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/access/clients/{clientId}/webhook-deliveries": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The client's delivery log, newest first
         * @description Newest first, paged by cursor (`limit`, `cursor` = the previous `nextCursor`). Filter flat (`?status=failed&endpointId=…&type.startsWith=note.&createdAt.gte=2026-01-01T00:00:00Z`) or with `filter` (and/or groups), sort with `sort=-attempts`, pick fields with `fields=status,type`; `count=true` adds `total`.
         */
        get: operations["ClientWebhooksController_deliveries_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/access/clients/{clientId}/webhook-deliveries/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** One delivery, with the message sent, every attempt, their duration and the last request */
        get: operations["ClientWebhooksController_delivery_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/access/clients/{clientId}/webhook-deliveries/{id}/retry": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Send one delivery again, now
         * @description Same webhook-id and body.
         */
        post: operations["ClientWebhooksController_retry_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/access/clients/{clientId}/webhook-deliveries/retry": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Retry every failed delivery since an outage began */
        post: operations["ClientWebhooksController_retryFailed_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/ops/outbox": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Outbox stats and the latest 50 dead letters
         * @description lagMs is the number to alert on: how long the oldest due message has waited. notifications.undelivered: stored notifications the worker has not delivered, though older than ten minutes.
         */
        get: operations["OpsController_state_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/ops/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Live events of workflows, webhooks, the outbox, idempotency, locks, mail and resilience (Server-Sent Events) */
        get: operations["OpsController_events_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/ops/queues": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Background job queues: counts by state and the latest failures */
        get: operations["OpsController_queueOverview_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/ops/queues/{name}/retry-failed": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Retry a queue's failed jobs */
        post: operations["OpsController_retryFailed_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/ops/dead-letters/requeue": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Requeue dead letters (these ids, or all) */
        post: operations["OpsController_requeue_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/ops/dead-letters/purge": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Delete dead letters (these ids, or all) */
        post: operations["OpsController_purge_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/features": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Which switches are on in this deployment
         * @description The deployment switches (`REALTIME`, `WEBHOOKS`, `REPORTS`, `USAGE`, `IMPERSONATION`, `AUTH_MFA`, `API_CLIENTS`), the sign-in options (`PASSKEYS`, `AUTH_SIGN_UP`, `AUTH_MAGIC_LINK`), whether PDF documents are set up, `TENANCY` and `LOCALES`. A switch that is off leaves its routes out (404) or refuses them (404 `feature_off`, 503 `documents_unavailable`). Read at startup: a change needs a restart.
         */
        get: operations["FeaturesController_list_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/data": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** What you may export and import */
        get: operations["DataTransferController_catalog_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/data/exports": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Export data to a file (a background job) */
        post: operations["DataTransferController_startExport_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/data/imports": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Import a file: every row is checked, valid rows are written (a background job) */
        post: operations["DataTransferController_startImport_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/data/imports/{name}/template": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * A file to fill for an import
         * @description The columns you may import, as headers, and an example row to replace: date-times in your time zone (named in the header), lists comma-separated. The Excel file adds a Columns sheet (required, type, format, example) and dropdowns for the choices. Rows are then checked as the feature's POST checks them.
         */
        get: operations["DataTransferController_template_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/data/transfers/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** An export or import you started: progress, then the result and its links */
        get: operations["DataTransferController_status_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/bulk/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * A bulk run you started: progress, then the result per item
         * @description The realtime connection hears `bulk.finished { id, name, action, done, failed }` when it ends.
         */
        get: operations["BulkController_status_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/custom-fields": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * A subject's custom fields, in their order
         * @description For anyone who may read the subject: forms and tables are built from them. Inactive fields only with includeInactive=true.
         */
        get: operations["CustomFieldsController_list_v1"];
        put?: never;
        /**
         * Add a field to a subject
         * @description Audited. The key is set once and never reused.
         */
        post: operations["CustomFieldsController_create_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/custom-fields/order": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Reorder a subject's fields
         * @description The fields listed come first, in that order; the others follow in theirs.
         */
        put: operations["CustomFieldsController_reorder_v1"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/custom-fields/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Deactivate a field
         * @description No longer accepted on writes nor exported; the values records hold are kept, and PATCH { active: true } brings it back.
         */
        delete: operations["CustomFieldsController_deactivate_v1"];
        options?: never;
        head?: never;
        /**
         * Change a field
         * @description Audited with what changed. A type change is refused while records hold values (except text → longText, email/url → text or longText); so is removing a choice records hold.
         */
        patch: operations["CustomFieldsController_update_v1"];
        trace?: never;
    };
    "/v1/notifications": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Your notifications, newest first
         * @description The texts are in the request's language. Filter with `?read=false`, `?type=note.published`, `?createdAt.gte=…`; page by cursor; each parameter lists what it takes.
         */
        get: operations["NotificationsController_list_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/notifications/unread-count": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** How many of your notifications are unread */
        get: operations["NotificationsController_unreadCount_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/notifications/read-all": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Mark all your notifications read
         * @description With `before`, only those created before it: what the client has shown, leaving newer ones unread.
         */
        post: operations["NotificationsController_readAll_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/notifications/types": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The notification types, and the channels you may set for each */
        get: operations["NotificationsController_types_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/notifications/preferences": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * How you are told of each type: your settings, per channel
         * @description Users set `email` (false, immediate, hourly or daily); API clients set `webhook` (the notification.created event). In-app and realtime are always on.
         */
        get: operations["NotificationsController_preferences_v1"];
        /**
         * Change how you are told
         * @description The body replaces your settings: a type or channel left out goes back to its default. A mandatory type cannot be switched off. Audited.
         */
        put: operations["NotificationsController_updatePreferences_v1"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/notifications/{id}/read": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Mark one of your notifications read */
        post: operations["NotificationsController_markRead_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/notifications/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Remove one of your notifications */
        delete: operations["NotificationsController_remove_v1"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/notifications/test": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Send yourself a test notification (development only)
         * @description Sends the caller a `system.test` notification the way a real one goes: stored for the bell, pushed to your open connections, mailed per your preference (users), sent as a `notification.created` webhook (API clients). Only in development and tests; in production the route does not exist (404).
         */
        post: operations["NotificationTestController_test_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/settings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Every setting and flag, with your value of each
         * @description Your value: your own, else your team's, else your tenant's (or a rollout), else the default. Settings not marked public show only to those who manage settings.
         */
        get: operations["SettingsController_list_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/settings/{key}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** One setting, with your value */
        get: operations["SettingsController_get_v1"];
        /**
         * Set a setting for everyone, a team, or one principal
         * @description Replaces what that scope had, in the caller's tenant. A flag at the tenant scope may take `rollout` (a percentage) instead of a value. Applies on the next request. Audited.
         */
        put: operations["SettingsController_set_v1"];
        post?: never;
        /** Remove a scope's value: back to the next scope's, or the default */
        delete: operations["SettingsController_unset_v1"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/settings/{key}/mine": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Set your own value of a setting (a preference)
         * @description Only settings whose scopes include `user`. Audited.
         */
        put: operations["SettingsController_setMine_v1"];
        post?: never;
        /** Drop your own value of a setting: back to the shared one */
        delete: operations["SettingsController_unsetMine_v1"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/settings/{key}/overrides": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The stored values of a setting, every scope */
        get: operations["SettingsController_overrides_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/account": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Your account: a pending deletion, what you agreed to */
        get: operations["AccountController_state_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/account/export": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * A copy of everything held about you
         * @description Starts an export (one record per row: kind, id, data) and answers 202 with its id: follow it at GET /v1/data/transfers/{id}, which gives the download link when done.
         */
        post: operations["AccountController_export_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/account/deletion": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Ask for your account to be deleted
         * @description Carried out after the grace period (ACCOUNT_DELETION_GRACE_DAYS), unless cancelled before; you get an email saying when. Wants a recent sign-in (`reauthentication_required`: POST /auth/reauthenticate) and, when the account has one, your password again. Records you created stay, without your name.
         */
        post: operations["AccountController_requestDeletion_v1"];
        /** Keep your account: cancel the pending deletion */
        delete: operations["AccountController_cancelDeletion_v1"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/account/consents": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** What you agreed to: the latest version of each kind */
        get: operations["AccountController_consents_v1"];
        put?: never;
        /**
         * Record that you accept a version of the terms, a policy…
         * @description The app names the kinds (`terms`, `privacy`, `marketing`) and versions. Accepting the same version again moves the time. Audited.
         */
        post: operations["AccountController_accept_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/account/deletion/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Keep your account: cancel the deletion with the mail's link
         * @description No sign-in: the token of the link in the deletion mail. It works once, for the request it was sent for, until the deletion is carried out. Audited (`account.deletion-cancelled`, `via: link`).
         */
        post: operations["AccountDeletionLinkController_cancel_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/subscriptions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The records you watch
         * @description Filter with `?subject=Note`; newest first; cursor pages.
         */
        get: operations["SubscriptionsController_list_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/subscriptions/{subject}/{recordId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Stop watching a record */
        delete: operations["SubscriptionsController_remove_v1"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Search every kind of record you may read
         * @description Words match anywhere; "quoted words" as a phrase; -word excludes; or between words. Best matches first, across kinds; snippets mark the matches with <b>…</b>.
         */
        get: operations["SearchController_search_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/lists/{subject}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * A subject's list: its filters, operators, sorts and fields
         * @description The fields the list may be filtered and sorted by, with their operators, the custom fields your tenant has now, `fields=` names, search and the list's limits. A field your permissions hide is left out. For anyone who may read the subject.
         */
        get: operations["ListsController_describe_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/people": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Your tenant's people, by name: for @mentions
         * @description The active members of your tenant whose name contains `q`, by name: each one's key (`user:<id>`, what `@user:<id>` mentions) and name, nothing else. For any member. A mention still reaches only those who may read the record (docs/comments.md).
         */
        get: operations["PeopleController_list_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/attachments/{id}/download": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Download an attachment
         * @description Whoever may read its record. Redirects to a signed link to the file, valid for 5m: it needs no credentials, so a browser can follow it (a link, an image).
         */
        get: operations["AttachmentsController_download_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/attachments/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Remove an attachment
         * @description Your own upload, or any attachment of a record you may change (for notes: Note.update). The file is deleted too. Audited (attachment.removed). Never an issued document (`locked`).
         */
        delete: operations["AttachmentsController_remove_v1"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/documents/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * A document asked for: its state, then the issued PDF
         * @description Whoever may read its record. `completed`: `attachmentId` is the PDF (GET /v1/attachments/{id}/download). The requester's realtime connection hears `document.ready { id, subject, recordId, attachmentId }` or `document.failed { id, subject, recordId, error }`.
         */
        get: operations["DocumentsController_status_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/tags": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The tags, newest first
         * @description Every subject unless `?subject=Note` (or `subject.in=`); `?name.contains=urg`, `?name=Urgent` (whatever the case); `?sort=name`. Cursor pages.
         */
        get: operations["TagsController_list_v1"];
        put?: never;
        /**
         * Create a tag
         * @description For a subject whose records take tags (`Note`); the name is unique per subject, whatever its case. Audited (`tag.created`).
         */
        post: operations["TagsController_create_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/tags/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Delete a tag
         * @description Every record carrying it loses it. Audited (`tag.deleted`).
         */
        delete: operations["TagsController_remove_v1"];
        options?: never;
        head?: never;
        /**
         * Rename, recolour or describe a tag
         * @description Only what is sent changes; null clears the colour or the description. Audited (`tag.updated`).
         */
        patch: operations["TagsController_update_v1"];
        trace?: never;
    };
    "/v1/reports": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Your scheduled reports
         * @description `?active=true`, `?exporter=notes`, `?name.contains=`, `?sort=nextRunAt`; newest first; cursor pages.
         */
        get: operations["ReportsController_list_v1"];
        put?: never;
        /**
         * Schedule a report
         * @description An export (`exporter`, `format`, `filters`, as `POST /v1/data/exports` takes them) run daily, weekly or monthly at an hour of `timezone`; the recipients get a download link (for REPORT_LINK_TTL, 24h by default). At most 20 active reports. Audited (`report.created`).
         */
        post: operations["ReportsController_create_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/reports/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** One of your scheduled reports */
        get: operations["ReportsController_get_v1"];
        put?: never;
        post?: never;
        /**
         * Delete a scheduled report
         * @description Audited (`report.deleted`).
         */
        delete: operations["ReportsController_remove_v1"];
        options?: never;
        head?: never;
        /**
         * Change a scheduled report
         * @description Only what is sent changes; the next run is computed again. Audited (`report.updated`).
         */
        patch: operations["ReportsController_update_v1"];
        trace?: never;
    };
    "/v1/reports/{id}/run": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Run a report now
         * @description Starts its export (a background job; `GET /v1/data/transfers/{id}` follows it); the recipients get the link when it is done. The schedule is unchanged. Audited (`report.ran`).
         */
        post: operations["ReportsController_run_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/access/clients/{id}/usage": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * An API client's requests per day and route
         * @description UTC days from `from` to `to`, both included (default: the last 30 days, at most 400). Today counts live.
         */
        get: operations["UsageController_clientUsage_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/usage": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Your requests per day and route (API clients)
         * @description UTC days from `from` to `to`, both included (default: the last 30 days, at most 400). Today counts live. With a daily quota, every response carries X-Quota-Limit and X-Quota-Remaining.
         */
        get: operations["UsageController_ownUsage_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/webhooks/mail/{provider}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * A mail provider reports bounces and complaints
         * @description `ses`: an SNS HTTP(S) notification (JSON, sent as text/plain) from one of SES_SNS_TOPIC_ARNS, signed by SNS (SignatureVersion 1 or 2). A `SubscriptionConfirmation` from an allowed topic is confirmed; a `Notification` carrying SES bounces, complaints or deliveries is queued for the suppression list. Nothing is written in the request.
         */
        post: operations["MailEventsController_handle_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/mail/suppressions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The suppression list, newest first
         * @description Addresses mail is not sent to (`suppressedAt` set) and addresses being watched for soft bounces (`suppressedAt.isNull=true`). `?address=ada@example.com` (any case), `?address.endsWith=@example.com`, `?reason=complaint`, `?source=ses`; `?sort=-lastSeenAt`. Cursor pages.
         */
        get: operations["SuppressionsController_list_v1"];
        put?: never;
        /**
         * Stop mail to an address
         * @description A manual entry (`reason: manual`): nothing is sent to the address, essential mail included, until it is removed. Audited (`mailSuppression.created`).
         */
        post: operations["SuppressionsController_create_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/mail/suppressions/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** One entry */
        get: operations["SuppressionsController_findOne_v1"];
        put?: never;
        post?: never;
        /**
         * Send mail to the address again
         * @description Removes the entry. For a bounced address, once the mailbox is known to work; for a complaint, only when the person asked for mail again. A new bounce or complaint lists it again. Audited (`mailSuppression.deleted`).
         */
        delete: operations["SuppressionsController_remove_v1"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/approvals/delegations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Your delegations: those you gave, and those you hold */
        get: operations["ApprovalDelegationsController_list_v1"];
        put?: never;
        /**
         * Let someone decide your approvals for a while
         * @description Between `startsAt` and `endsAt`, `toUserId` may decide the approvals assigned to you (of every subject, or of `subject`): the decision is recorded as theirs, on behalf of you. You may still decide yourself. Audited.
         */
        post: operations["ApprovalDelegationsController_create_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/approvals/delegations/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** End a delegation you gave */
        delete: operations["ApprovalDelegationsController_remove_v1"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/approvals/policy-types": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * What policies are made of: approver rules, stage modes, conditions
         * @description Each with the JSON Schema of its parameters, which sit beside `type` in a policy. Projects register their own (docs/approvals.md, "Extending").
         */
        get: operations["ApprovalPoliciesController_types_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/approvals/policies": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The approvable actions and the policy each runs under */
        get: operations["ApprovalPoliciesController_list_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/approvals/policies/{key}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** One action's policy (`Note.publish`) */
        get: operations["ApprovalPoliciesController_get_v1"];
        /**
         * Store a new version of an action's policy
         * @description The whole policy, checked against the registered rule, mode and condition types (GET /v1/approvals/policy-types). New requests run under it; running ones keep the version they started with. Audited.
         */
        put: operations["ApprovalPoliciesController_set_v1"];
        post?: never;
        /**
         * Back to the code's default policy
         * @description Stored as a new version, so the history stays. Audited.
         */
        delete: operations["ApprovalPoliciesController_reset_v1"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/approvals": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Approval requests: your inbox, and what you asked for
         * @description `?assignedToMe=true` is what waits for your decision now (yours, and those of people you stand in for); `?requestedByMe=true` what you asked for. Filter by `status`, `subject`, `action`, `recordId`, `dueAt`; newest first, cursor pages.
         */
        get: operations["ApprovalsController_list_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/approvals/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * One request: its stages, assignments, decisions and timeline
         * @description `can` says what you may do with it now. With an ETag: send it as If-Match on a decision to be refused (412) if it changed since you read it.
         */
        get: operations["ApprovalsController_get_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/approvals/{id}/approve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Approve
         * @description As an approver of the current stage, or as the delegate of one (the decision is recorded as yours, on behalf of them). Approving again changes nothing.
         */
        post: operations["ApprovalsController_approve_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/approvals/{id}/reject": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Reject (with a comment saying why)
         * @description Ends the request as rejected, in every stage mode but a quorum that can still be reached.
         */
        post: operations["ApprovalsController_reject_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/approvals/{id}/request-changes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Send it back for changes (with a comment saying which)
         * @description The requester may change the record, then resubmit (POST /v1/approvals/{id}/resubmit): a new round from the first stage.
         */
        post: operations["ApprovalsController_requestChanges_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/approvals/{id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Withdraw a request
         * @description The requester, or someone who may cancel approvals (Approval.cancel). The approvers still waiting are told.
         */
        post: operations["ApprovalsController_cancel_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/approvals/{id}/abandon": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Abandon an approved request whose outcome would not apply
         * @description For administrators (Approval.manage): an approved request whose workflow ended without applying it ends as failed (`abandoned`), so its record isn't locked any more, and `onFailed` runs. Refused while the workflow still runs or retries. Audited; the requester is told.
         */
        post: operations["ApprovalsController_abandon_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/approvals/{id}/resubmit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Resubmit after changes were requested
         * @description The same request, a new round: from the first stage, its approvers resolved again, under the policy version it started with. `payload` replaces the proposed change (checked by the action's schema).
         */
        post: operations["ApprovalsController_resubmit_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/money/rates": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The exchange rates of a day
         * @description The ECB’s euro reference rates of the newest working day on or before `date` (default today, UTC): units of each currency per euro, as decimal strings.
         */
        get: operations["MoneyController_ratesOn_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/money/convert": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Convert an amount
         * @description Converts through the euro (triangulation) at the rates of the newest working day on or before `date` that has both currencies, rounded once to the target’s minor unit. The answer carries the rate, its day and its source.
         */
        get: operations["MoneyController_convert_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/methods": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** How users can sign in here, for the sign-in page */
        get: operations["AuthController_methods_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/sign-in": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Sign in with a password: sets the session cookie
         * @description A session ends after 12 hours, or 2 hours without a request. An unknown email and a wrong password get the same answer. With two-factor on, the answer says mfaRequired: finish with POST /auth/mfa/verify.
         */
        post: operations["AuthController_signIn_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/sign-up": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create an account (when AUTH_SIGN_UP=on); it signs in once its address is verified
         * @description Verify first: no session is made, and the password signs in (or gets tokens) only after the user opened the link sent to the address and confirmed it with the same password (POST /auth/email/verify { token, password }). So nobody can sign up someone else's address and sign in as them once its owner clicks. The account has no tenant: a tenant invites it.
         */
        post: operations["AuthController_signUp_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/mfa/verify": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Finish signing in with a two-factor code */
        post: operations["AuthController_completeMfa_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/sign-out": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Sign out: ends this browser's session */
        post: operations["AuthController_signOut_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The signed-in user and what they may do */
        get: operations["AuthController_me_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Change your name, language or time zone
         * @description The language answers your requests and your emails; the time zone shows the times in your emails. Dates in the API stay UTC.
         */
        patch: operations["AuthController_updateProfile_v1"];
        trace?: never;
    };
    "/v1/auth/impersonation/stop": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Stop acting as another user */
        post: operations["AuthController_stopImpersonating_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/password/forgot": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Email a reset link
         * @description Always 202, at once, whether the address has an account or not: the answer reveals nothing. The link opens WEB_URL/reset-password?token=…, which POSTs to /auth/password/reset.
         */
        post: operations["PasswordController_forgot_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/password/reset": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Set a new password with a reset or invitation link
         * @description Signs the account out everywhere (whoever knew the old password too), and marks the address verified: the link proved it.
         */
        post: operations["PasswordController_reset_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/password/change": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Change your password
         * @description Wants a recent sign-in (`reauthentication_required`). Every other session and every token client is signed out; this browser keeps its session, under a new id.
         */
        post: operations["PasswordController_change_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/email/verify": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Confirm an address with the link's token */
        post: operations["EmailController_verify_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/email/verification": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Send the verification link again */
        post: operations["EmailController_resend_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Your browser sessions
         * @description While an administrator acts as you: only that session.
         */
        get: operations["SessionsController_list_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/sessions/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Sign one of your sessions out */
        delete: operations["SessionsController_revoke_v1"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/sign-out-everywhere": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Sign out of every browser and every app */
        post: operations["SessionsController_signOutEverywhere_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/mfa": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Whether two-factor is on */
        get: operations["MfaController_status_v1"];
        put?: never;
        post?: never;
        /** Turn two-factor off */
        delete: operations["MfaController_disable_v1"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/mfa/enroll": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Start setting up an authenticator app */
        post: operations["MfaController_enroll_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/mfa/confirm": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Turn two-factor on with a first code from the app
         * @description Returns the recovery codes, once. This browser counts as verified.
         */
        post: operations["MfaController_confirm_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/mfa/recovery-codes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** New recovery codes (the old ones stop working) */
        post: operations["MfaController_recoveryCodes_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/magic-link": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Email a sign-in link
         * @description Always 202: the answer reveals nothing. The link opens WEB_URL/magic-link?token=…, which POSTs to /auth/magic-link/verify from the same browser.
         */
        post: operations["MagicLinkController_request_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/magic-link/verify": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Sign in with the link's token: sets the session cookie */
        post: operations["MagicLinkController_consume_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/oidc/{provider}/login": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Start signing in with a provider (navigate the browser here)
         * @description With `link=true`, a signed-in session that is not recent (REAUTHENTICATION_MAX_AGE_MINUTES) is redirected to the web app (`redirectTo`, else its root) with `?error=reauthentication_required`: check GET /auth/reauthenticate first. With `reauthenticate=true`, a signed-in user steps up through the provider: it is asked to authenticate them again (`prompt=login`, `max_age=0`), and the callback accepts only that user, authenticated at the provider after the start (`auth_time`, when the ID token has one); otherwise the browser lands on the web app with `?error=reauthentication_failed`, signed in as before.
         */
        get: operations["OidcController_login_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/oidc/{provider}/callback": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Where the provider sends the browser back */
        get: operations["OidcController_callback_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/identities": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The providers connected to your account */
        get: operations["OidcController_identities_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/identities/{provider}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Disconnect a provider */
        delete: operations["OidcController_unlink_v1"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/token": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Sign in a token client with a password */
        post: operations["TokensController_issue_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/token/refresh": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Renew the access token (rotates the refresh token) */
        post: operations["TokensController_refresh_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/token/revoke": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Sign this app out (its refresh token's family) */
        post: operations["TokensController_revoke_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/reauthenticate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** When you last authenticated, and how to do it again */
        get: operations["ReauthenticationController_status_v1"];
        put?: never;
        /**
         * Prove again who you are, for the sensitive routes
         * @description Your password, with a code when two-factor is on (a code alone when the account has no password); or a passkey (with a code from a token client when two-factor is on). A session gets a new id (the cookie changes: a request sent meanwhile with the old one gets 401; reconnect realtime); a token client gets new tokens, and the family of the refreshToken it sent is revoked. Audited. Never while acting as another user.
         */
        post: operations["ReauthenticationController_reauthenticate_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/passkeys": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Your passkeys
         * @description Account-level: empty while an administrator acts as you (impersonation shows only what belongs to the tenant).
         */
        get: operations["PasskeysController_list_v1"];
        put?: never;
        /**
         * Register a passkey: the credential the browser made
         * @description The answer of the options from POST /auth/passkeys/registration/options, with a name. Audited; you get an email.
         */
        post: operations["PasskeysController_register_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/passkeys/registration/options": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Start registering a passkey: the options for the browser
         * @description Give them to `navigator.credentials.create()` (or @simplewebauthn/browser `startRegistration`), then POST the credential to /auth/passkeys. The challenge works once, for PASSKEY_CHALLENGE_TTL_SECONDS, from this session (and this origin). User verification is required. An account whose address was never proved gets 403 `email_unverified` (verify first); not while acting as another user.
         */
        post: operations["PasskeysController_registrationOptions_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/passkeys/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Remove a passkey
         * @description Not the last way to sign in (409 `last_sign_in_method`: set a password first). Audited; you get an email.
         */
        delete: operations["PasskeysController_remove_v1"];
        options?: never;
        head?: never;
        /** Rename a passkey */
        patch: operations["PasskeysController_rename_v1"];
        trace?: never;
    };
    "/v1/auth/passkeys/sign-in/options": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Start signing in with a passkey: the options for the browser
         * @description With an `email`, the account’s passkeys are offered (`allowCredentials`); without one, the browser offers the passkeys it holds for this site (usernameless, or a sign-in field with `useBrowserAutofill`). The challenge works once, for PASSKEY_CHALLENGE_TTL_SECONDS. Then POST the assertion to /auth/passkeys/sign-in (a browser) or /auth/passkeys/token (an app).
         */
        post: operations["PasskeysController_signInOptions_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/passkeys/sign-in": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Sign in with a passkey: sets the session cookie
         * @description The assertion the browser made from the options. A passkey that verified its user (Touch ID, a PIN…) counts for both factors: with two-factor on, the session is verified at once. One that did not counts as the first factor: mfaRequired, finish with POST /auth/mfa/verify. A refused assertion is a 401 saying no more.
         */
        post: operations["PasskeysController_signIn_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/passkeys/token": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Sign in a token client with a passkey (native apps)
         * @description The assertion the app made from the options (an app listed in PASSKEY_ANDROID_APPS or PASSKEY_APPLE_APPS). With two-factor on, a code (or a recoveryCode) goes with it: the token service takes no passkey as the second factor.
         */
        post: operations["PasskeysController_issueTokens_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/passkeys/reauthentication/options": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Start re-authenticating with a passkey: the options
         * @description Your passkeys, user verification required. Then POST the assertion as `passkey` to /auth/reauthenticate. The challenge is bound to this session.
         */
        post: operations["PasskeysController_reauthenticationOptions_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/access/catalog": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Every permission that exists: subjects, actions and the conditions each may carry; and the system jobs, with what each may do */
        get: operations["AccessController_catalog_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/access/roles": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The roles, with their permissions and member counts */
        get: operations["AccessController_roles_v1"];
        put?: never;
        /** Create a role */
        post: operations["AccessController_createRole_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/access/roles/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** One role, with its permissions and member count */
        get: operations["AccessController_role_v1"];
        put?: never;
        post?: never;
        /** Delete a role: its members lose its permissions */
        delete: operations["AccessController_deleteRole_v1"];
        options?: never;
        head?: never;
        /** Replace a role: name, description and permissions */
        patch: operations["AccessController_updateRole_v1"];
        trace?: never;
    };
    "/v1/access/users": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The users, with their role ids, newest first
         * @description Filter flat (`?active=true&email.contains=@example.com`, a team's members with `?teamId=<id>` or `?teamId.in=<id>,<id>`: those in it, not in the teams below) or with `filter` (and/or groups), sort with `sort=-createdAt`, pick fields with `fields=email,name`; each parameter lists what it takes. GET /v1/lists/User describes it.
         */
        get: operations["AccessController_users_v1"];
        put?: never;
        /**
         * Invite someone to this tenant
         * @description The address is emailed a link (WEB_URL/accept-invitation?token=…, valid INVITATION_TTL_HOURS). A new address chooses its password with it; an existing account accepts while signed in (POST /auth/invitations/accept). The membership, with these roles and teams, comes then. The answer is the same whether or not the address has an account; nobody sets another person's password.
         */
        post: operations["AccessController_createUser_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/access/users/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** One member of this tenant, with their role grants and teams */
        get: operations["AccessController_user_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Change a member's membership; only what is sent changes
         * @description Its activation, roles and teams in this tenant: never the account (its name, its password), which is its owner's. A deactivation ends their sessions and tokens in this tenant. The last active administrator stays.
         */
        patch: operations["AccessController_updateUser_v1"];
        trace?: never;
    };
    "/v1/access/invitations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** This tenant's invitations not accepted yet */
        get: operations["AccessController_invitations_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/access/invitations/{id}/resend": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Send a pending invitation again: a new link and expiry
         * @description Expired or not. The previous link stops working; the roles, their ends (`roleExpiresAt`) and the teams stay as they were. You must be able to grant its roles, as when inviting.
         */
        post: operations["AccessController_resendInvitation_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/access/invitations/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Withdraw an invitation: its link stops working */
        delete: operations["AccessController_revokeInvitation_v1"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/access/users/{id}/impersonate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Act as this user (support)
         * @description Replaces your session with one of the user's, for IMPERSONATION_TTL_MINUTES. Never an administrator, never nested. GET /auth/me shows the impersonator.
         */
        post: operations["AccessController_impersonate_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/access/principals": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Search the tenant's users and API clients, as principal keys
         * @description `?q=` matches a part of a user's name or address, or of a client's name, whatever the case (`%` and `_` are the characters); `?kind=user|client`, `?active=true`, `?sort=label`. Cursor pages. Each item's `key` (`user:<id>`, `client:<id>`) is what a setting's user scope takes as `scopeId`. Clients only while API_CLIENTS is on.
         */
        get: operations["AccessController_principalsList_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/access/clients": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The API clients (never their keys) */
        get: operations["AccessController_apiClients_v1"];
        put?: never;
        /**
         * Create an API client: its key is in the response, this once
         * @description With its roles and daily quota at once, in one transaction: never a client without them.
         */
        post: operations["AccessController_createClient_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/access/clients/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** One API client (never its keys) */
        get: operations["AccessController_apiClient_v1"];
        put?: never;
        post?: never;
        /**
         * Delete an API client for good: its keys stop at once
         * @description Its keys, role grants, usage and webhook endpoints go with it; the audit log keeps what it did. To stop it and keep it, revoke it instead (PATCH `active: false`).
         */
        delete: operations["AccessController_deleteClient_v1"];
        options?: never;
        head?: never;
        /** Revoke (active: false) or reactivate a client; change its roles or daily quota */
        patch: operations["AccessController_updateClient_v1"];
        trace?: never;
    };
    "/v1/access/clients/{id}/rotate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** A new key; the current ones stop after graceSeconds (0: now) */
        post: operations["AccessController_rotateClient_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/access/clients/{id}/keys/{keyId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Revoke one key now */
        delete: operations["AccessController_revokeKey_v1"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/access/audit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The audit log, newest first
         * @description Filter flat (`?action.startsWith=note.&at.gte=2026-01-01T00:00:00Z`) or with `filter` (and/or groups), sort with `sort=action,-at`, pick fields with `fields=at,action,actor`; each parameter lists what it takes.
         */
        get: operations["AccessController_auditLog_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/access/teams": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Every team, top-level first, with its parent and depth */
        get: operations["TeamsController_list_v1"];
        put?: never;
        /** Create a team */
        post: operations["TeamsController_create_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/access/teams/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Delete an empty team */
        delete: operations["TeamsController_remove_v1"];
        options?: never;
        head?: never;
        /** Rename a team, or move it with everything under it */
        patch: operations["TeamsController_update_v1"];
        trace?: never;
    };
    "/v1/auth/tenants": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The tenants you belong to
         * @description The active memberships of active tenants, the last chosen first. `current` is the one this session acts in. While impersonating, only that one.
         */
        get: operations["TenantSwitchController_tenants_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/tenant": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Act in another of your tenants
         * @description Re-issues the session (a new cookie) in that tenant. Never while impersonating. Realtime connections reconnect to hear the new tenant.
         */
        post: operations["TenantSwitchController_switch_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/invitations/accept": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Accept an invitation to a tenant
         * @description 400 `password_required`: a new address, send `password` (and `name`). 401 `sign_in_required`: the address has an account, sign in to it and accept again. 403 `invitation_other_account`: you are signed in as another account. 400 `invitation_invalid`: unknown, used or expired. A new account signs in afterwards (POST /auth/sign-in); a signed-in one switches to the tenant (POST /auth/tenant).
         */
        post: operations["TenantSwitchController_acceptInvitation_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/tenants": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Every tenant (operators) */
        get: operations["TenantsController_list_v1"];
        put?: never;
        /**
         * Create a tenant and its first administrator (operators)
         * @description The tenant gets the built-in and declared roles; the administrator is the account at `administratorEmail` (made and invited when there is none).
         */
        post: operations["TenantsController_create_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/notes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The notes you may read, newest first
         * @description Filter flat (`?status=draft&title.contains=report`) or with `filter` (and/or groups), sort with `sort=-createdAt,title`, pick fields with `fields=title,status`; each parameter lists what it takes. Only the notes you may read, whatever the filter. Filtering, searching, sorting or picking by a field your permissions hide (the text, the custom fields) is a 403 (field_forbidden).
         */
        get: operations["NotesController_list_v1"];
        put?: never;
        /**
         * Write a note
         * @description Saves a draft, starts its publication workflow and sends note.created, in one transaction. Send a new Idempotency-Key per note and the same one on every retry. With the ETag GET /v1/notes/{id} would send: use it as If-Match on the next write.
         */
        post: operations["NotesController_create_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/notes/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * One note
         * @description With an ETag: send it back as If-None-Match to get 304 while unchanged, or as If-Match on a write to be refused if it changed.
         */
        get: operations["NotesController_get_v1"];
        put?: never;
        post?: never;
        /**
         * Delete a note (to the recycle bin)
         * @description It disappears from every list; POST /v1/notes/{id}/restore brings it back until it is purged.
         */
        delete: operations["NotesController_delete_v1"];
        options?: never;
        head?: never;
        /**
         * Change a note: only what is sent changes
         * @description Your own drafts. Changing the text takes a permission that includes it. With If-Match, refused (412) if the note changed since you read it. Audited with what changed.
         */
        patch: operations["NotesController_update_v1"];
        trace?: never;
    };
    "/v1/notes/{id}/restore": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Restore a note from the recycle bin
         * @description Until the purge (SOFT_DELETE_RETENTION_DAYS after deleting it).
         */
        post: operations["NotesController_restore_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/webhooks/example-sender": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Ask for a note to be published now
         * @description Signed with Standard Webhooks (webhook-id, webhook-timestamp, webhook-signature) using EXAMPLE_SENDER_WEBHOOK_SECRET.
         */
        post: operations["ExampleSenderWebhookController_handle_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/notes/{id}/comments": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * A note's comments, oldest first
         * @description Cursor pages; `?sort=-createdAt` for newest first, `?author=user:<id>`, `?createdAt.gte=`.
         */
        get: operations["NoteCommentsController_list_v1"];
        put?: never;
        /**
         * Comment on a note
         * @description Mention people with `@<email>` or `@user:<id>`: those who may read the note are told (`comment.mentioned`); the note's watchers hear `note.commented`. Your first comment on a note makes you watch it. Audited.
         */
        post: operations["NoteCommentsController_add_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/notes/{id}/comments/{commentId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Remove a comment
         * @description Its author, or whoever may change the note (`Note.update`). For good; audited.
         */
        delete: operations["NoteCommentsController_remove_v1"];
        options?: never;
        head?: never;
        /**
         * Change your comment
         * @description Only its author; sets `editedAt`. People newly mentioned are told. Audited.
         */
        patch: operations["NoteCommentsController_edit_v1"];
        trace?: never;
    };
    "/v1/notes/{id}/attachments": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * A note's attachments, newest first
         * @description Whoever may read the note.
         */
        get: operations["NoteAttachmentsController_list_v1"];
        put?: never;
        /**
         * Attach a file to a note
         * @description Who may change the note (Note.update). Multipart, the field `file`. Its type is read from its bytes: allowed types only (ATTACHMENT_ALLOWED_TYPES), and not another one than declared. Audited (attachment.added).
         */
        post: operations["NoteAttachmentsController_upload_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/notes/{id}/tags": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Set a note's tags
         * @description Replaces the whole set (`[]` removes every tag); the tags must be `Note` tags (GET /v1/tags?subject=Note). Answers the note's tags, by name. Audited (`tags.changed`, from → to).
         */
        put: operations["NoteTagsController_set_v1"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/notes/{id}/revisions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * A note's revisions, newest first
         * @description Revision 1 is the note as written; each change adds one, with what changed (`changes`, from → to). Cursor pages; `?changedBy=user:<id>`, `?number.gte=`. The text and custom values only when your permissions include them.
         */
        get: operations["NoteRevisionsController_list_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/notes/{id}/revisions/{number}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** One revision of a note */
        get: operations["NoteRevisionsController_get_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/notes/{id}/revisions/{a}/diff/{b}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * What differs between two revisions of a note
         * @description From revision `a`'s values to `b`'s (either order); `custom.<key>` per custom value.
         */
        get: operations["NoteRevisionsController_diff_v1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/notes/{id}/revisions/{number}/restore": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Set a note back to a revision
         * @description Its title, text and custom values become the revision's, as a PATCH would set them (the same permissions, field-level ones too): audited `note.updated`, and a new revision with `restoredFrom`. With If-Match (the note's ETag), refused (412) if the note changed since you read it. Answers the note.
         */
        post: operations["NoteRevisionsController_restore_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/notes/{id}/pdf": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Issue a PDF of a note
         * @description Whoever may read the note. Answers at once with the document id; a worker renders the PDF in the request's language (`?lang=`, `X-Lang`, your saved language; right to left in Arabic) and your time zone, and adds it to the note's attachments (`locked`: it never changes and cannot be removed; asking again issues a new one). The text is in it only if you may read it.
         *
         *     Follow it at GET /v1/documents/{id}; your realtime connection hears `document.ready { id, subject, recordId, attachmentId }` (download it at GET /v1/attachments/{attachmentId}/download) or `document.failed { id, subject, recordId, error }`. Audited (document.requested, document.issued).
         */
        post: operations["NoteDocumentsController_pdf_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/notes/bulk": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Delete, restore or change many notes at once
         * @description Each note as its own route does it (permissions, field-level checks, audit, webhooks); a note that fails does not stop the others.
         *
         *     - `ids` (1 to 500): up to BULK_SYNC_LIMIT (100) answer 200 with a result per note; more answer 202.
         *     - `filter` (the list's filters, `{ "title.startsWith": "Old" }`): always 202.
         *
         *     A 202 is a background job: follow it at GET /v1/bulk/{id}; the realtime connection hears `bulk.finished`. Ids you may not act on (or that do not exist) come back `skipped`. `input` is the update's PATCH body.
         */
        post: operations["NotesController_runBulk_v1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/notes/{id}/watch": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Watch a note: be told when it changes or is published
         * @description Its owner watches it from the start. Stop with DELETE /v1/notes/{id}/watch (or /v1/subscriptions/Note/{id}).
         */
        post: operations["NotesController_watch_v1"];
        /** Stop watching a note */
        delete: operations["NotesController_unwatch_v1"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        Money: {
            /** @description The amount in major units, with exactly the currency’s decimals: "12.30", "1200" (JPY), "1.250" (KWD). */
            amount: string;
            /** @description ISO 4217. */
            currency: string;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    WebhookEndpointsController_list_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            id: string;
                            tenant: string | null;
                            url: string;
                            eventTypes: string[];
                            description: string | null;
                            enabled: boolean;
                            /** @enum {string|null} */
                            disabledReason: "manual" | "failing" | "gone" | null;
                            /** @description Epoch milliseconds. */
                            failingSince: number | null;
                            /** @description Epoch milliseconds. */
                            createdAt: number;
                            /** @description Epoch milliseconds. */
                            updatedAt: number;
                        }[];
                    };
                };
            };
            /** @description Missing or unknown API key. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    WebhookEndpointsController_create_v1: {
        parameters: {
            query?: never;
            header?: {
                /**
                 * @description A unique key per operation (a UUID), 1 to 255 printable ASCII characters. Send the same key on every retry of the same request: it runs once, and retries get its response (with Idempotent-Replayed: true). Kept for 24 hours.
                 *
                 *     In Swagger UI, leave `generate` to send a new key on every Execute, or type your own key and Execute twice to see a retry replayed.
                 */
                "Idempotency-Key"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description A public https:// URL. Private and cloud-metadata addresses are refused. */
                    url: string;
                    /** @description Event types to receive (GET /v1/webhook-event-types), or "*" for all. An unknown type is a 400; so is the reserved webhook.test. */
                    eventTypes: string[];
                    description?: string;
                };
            };
        };
        responses: {
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        tenant: string | null;
                        url: string;
                        eventTypes: string[];
                        description: string | null;
                        enabled: boolean;
                        /** @enum {string|null} */
                        disabledReason: "manual" | "failing" | "gone" | null;
                        /** @description Epoch milliseconds. */
                        failingSince: number | null;
                        /** @description Epoch milliseconds. */
                        createdAt: number;
                        /** @description Epoch milliseconds. */
                        updatedAt: number;
                        /** @description Standard Webhooks whsec_…: verify the signatures with it. Shown this once. */
                        secret: string;
                    };
                };
            };
            /** @description A refused URL (not https, a private or cloud-metadata address) or an unknown event type. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Missing or unknown API key. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    WebhookEndpointsController_get_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        tenant: string | null;
                        url: string;
                        eventTypes: string[];
                        description: string | null;
                        enabled: boolean;
                        /** @enum {string|null} */
                        disabledReason: "manual" | "failing" | "gone" | null;
                        /** @description Epoch milliseconds. */
                        failingSince: number | null;
                        /** @description Epoch milliseconds. */
                        createdAt: number;
                        /** @description Epoch milliseconds. */
                        updatedAt: number;
                    };
                };
            };
            /** @description Missing or unknown API key. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    WebhookEndpointsController_delete_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Missing or unknown API key. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    WebhookEndpointsController_update_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    url?: string;
                    /** @description Event types to receive (GET /v1/webhook-event-types), or "*" for all. An unknown type is a 400; so is the reserved webhook.test. */
                    eventTypes?: string[];
                    /** @description null clears it (an empty string is refused: 400); absent leaves it as it is. */
                    description?: string | null;
                    enabled?: boolean;
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        tenant: string | null;
                        url: string;
                        eventTypes: string[];
                        description: string | null;
                        enabled: boolean;
                        /** @enum {string|null} */
                        disabledReason: "manual" | "failing" | "gone" | null;
                        /** @description Epoch milliseconds. */
                        failingSince: number | null;
                        /** @description Epoch milliseconds. */
                        createdAt: number;
                        /** @description Epoch milliseconds. */
                        updatedAt: number;
                    };
                };
            };
            /** @description Missing or unknown API key. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    WebhookEndpointsController_rotateSecret_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description The new whsec_…. The old one keeps signing next to it for 24 hours. */
                        secret: string;
                    };
                };
            };
            /** @description Missing or unknown API key. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    WebhookEndpointsController_test_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        /** @description The webhook-id header: the same on every attempt and replay. */
                        messageId: string;
                        endpointId: string;
                        tenant: string | null;
                        type: string;
                        /** @enum {string} */
                        status: "pending" | "succeeded" | "failed";
                        attempts: number;
                        /** @description Epoch milliseconds. */
                        nextAttemptAt: number | null;
                        /** @description Epoch milliseconds. */
                        lastAttemptAt: number | null;
                        lastStatusCode: number | null;
                        lastError: string | null;
                        /** @enum {string|null} */
                        failureReason: "exhausted" | "rejected" | "endpoint-disabled" | "endpoint-deleted" | null;
                        /** @description Epoch milliseconds. */
                        createdAt: number;
                        /** @description Epoch milliseconds. */
                        completedAt: number | null;
                    };
                };
            };
            /** @description Missing or unknown API key. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    WebhookDeliveriesController_list_v1: {
        parameters: {
            query?: {
                limit?: number;
                /** @description `nextCursor` of the previous page (the same `sort`). */
                cursor?: string;
                /** @description Pages by number instead of cursor: 1 for the first, `limit` rows a page. Example: `page=3&limit=20&count=true`. */
                page?: number;
                /** @description true: add `total` (counted up to a cap; `totalCapped`). */
                count?: "true" | "false";
                lang?: string;
                /** @description Filter: endpointId = */
                endpointId?: string;
                /** @description Filter: endpointId in */
                "endpointId.in"?: string;
                /** @description Filter: status = */
                status?: "pending" | "succeeded" | "failed";
                /** @description Filter: status in */
                "status.in"?: string;
                /** @description Filter: type = */
                type?: string;
                /** @description Filter: type in */
                "type.in"?: string;
                /** @description Filter: type startsWith */
                "type.startsWith"?: string;
                /** @description Filter: attempts gte */
                "attempts.gte"?: number;
                /** @description Filter: attempts lte */
                "attempts.lte"?: number;
                /** @description Filter: createdAt gt */
                "createdAt.gt"?: string;
                /** @description Filter: createdAt gte */
                "createdAt.gte"?: string;
                /** @description Filter: createdAt lt */
                "createdAt.lt"?: string;
                /** @description Filter: createdAt lte */
                "createdAt.lte"?: string;
                /** @description Filter: createdAt between */
                "createdAt.between"?: string;
                /** @description Conditions in and/or groups, JSON: a condition { field, op, value } or a group { "and": [...] } / { "or": [...] }, 3 groups deep and 30 conditions at most. Example: {"or":[{"field":"endpointId","op":"eq","value":…},{…}]}. Fields and operators: endpointId (eq, in); status (eq, in); type (eq, in, startsWith); attempts (gte, lte); createdAt (gt, gte, lt, lte, between). */
                filter?: string;
                /** @description The order: fields comma-separated, - for descending; the newest first on ties. Example: -type. Sortable: type, attempts. */
                sort?: string;
                /** @description Only these fields in each item, comma-separated; id always comes. Example: messageId,endpointId. Fields: id, messageId, endpointId, tenant, type, status, attempts, nextAttemptAt, lastAttemptAt, lastStatusCode, lastError, failureReason, createdAt, completedAt. */
                fields?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            id: string;
                            /** @description The webhook-id header: the same on every attempt and replay. */
                            messageId: string;
                            endpointId: string;
                            tenant: string | null;
                            type: string;
                            /** @enum {string} */
                            status: "pending" | "succeeded" | "failed";
                            attempts: number;
                            /** @description Epoch milliseconds. */
                            nextAttemptAt: number | null;
                            /** @description Epoch milliseconds. */
                            lastAttemptAt: number | null;
                            lastStatusCode: number | null;
                            lastError: string | null;
                            /** @enum {string|null} */
                            failureReason: "exhausted" | "rejected" | "endpoint-disabled" | "endpoint-deleted" | null;
                            /** @description Epoch milliseconds. */
                            createdAt: number;
                            /** @description Epoch milliseconds. */
                            completedAt: number | null;
                        }[];
                        /** @description Pass it as `cursor` for the next page; null: no more (and with `page`). */
                        nextCursor: string | null;
                        /** @description With `page`: this page. */
                        page?: number;
                        /** @description With `page`: the next page; null: no more. */
                        nextPage?: number | null;
                        /** @description With `page` and `count=true`: ceil(total / limit). */
                        pageCount?: number;
                        /** @description With `count=true`: the rows matching the filters, all pages; the cap when totalCapped. */
                        total?: number;
                        /** @description true: there are more than `total` (show "10,000+"). */
                        totalCapped?: boolean;
                    };
                };
            };
            /** @description Missing or unknown API key. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    WebhookDeliveriesController_get_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        /** @description The webhook-id header: the same on every attempt and replay. */
                        messageId: string;
                        endpointId: string;
                        tenant: string | null;
                        type: string;
                        /** @enum {string} */
                        status: "pending" | "succeeded" | "failed";
                        attempts: number;
                        /** @description Epoch milliseconds. */
                        nextAttemptAt: number | null;
                        /** @description Epoch milliseconds. */
                        lastAttemptAt: number | null;
                        lastStatusCode: number | null;
                        lastError: string | null;
                        /** @enum {string|null} */
                        failureReason: "exhausted" | "rejected" | "endpoint-disabled" | "endpoint-deleted" | null;
                        /** @description Epoch milliseconds. */
                        createdAt: number;
                        /** @description Epoch milliseconds. */
                        completedAt: number | null;
                        message: {
                            id: string;
                            type: string;
                            tenant: string | null;
                            /** @description The exact JSON that was signed and sent. */
                            body: string;
                            /** @description Epoch milliseconds. */
                            createdAt: number;
                        };
                        history: {
                            deliveryId: string;
                            attempt: number;
                            /** @description Epoch milliseconds. */
                            at: number;
                            durationMs: number;
                            statusCode: number | null;
                            /** @description The first 4 KB of the response body. */
                            response: string | null;
                            error: string | null;
                        }[];
                        /** @description Every attempt of the log together, in milliseconds. */
                        durationMs: number;
                        /** @description The request of the latest attempt; null before the first. */
                        lastRequest: {
                            /** @description 1-based, within its round. */
                            attempt: number;
                            /** @description Epoch milliseconds. */
                            sentAt: number;
                            /** @description As sent: webhook-id, webhook-timestamp, webhook-signature (v1,… per live secret), content-type, user-agent. Never the secret. */
                            headers: {
                                [key: string]: string;
                            };
                        } | null;
                    };
                };
            };
            /** @description Missing or unknown API key. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    WebhookDeliveriesController_retry_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description How many deliveries were sent again. */
                        retried: number;
                    };
                };
            };
            /** @description Missing or unknown API key. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    WebhookDeliveriesController_retryFailed_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description One endpoint's failed deliveries; every endpoint's without it. */
                    endpointId?: string;
                    /**
                     * Format: date-time
                     * @description Deliveries created at or after this time: the start of the outage.
                     */
                    since?: string;
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description How many deliveries were sent again. */
                        retried: number;
                    };
                };
            };
            /** @description Missing or unknown API key. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    WebhookEventTypesController_list_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** @description The feature: the types' first segment unless declared. */
                            group: string;
                            types: {
                                /** @example note.published */
                                type: string;
                                description: string | null;
                            }[];
                        }[];
                    };
                };
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    ClientWebhooksController_list_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                clientId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            id: string;
                            tenant: string | null;
                            url: string;
                            eventTypes: string[];
                            description: string | null;
                            enabled: boolean;
                            /** @enum {string|null} */
                            disabledReason: "manual" | "failing" | "gone" | null;
                            /** @description Epoch milliseconds. */
                            failingSince: number | null;
                            /** @description Epoch milliseconds. */
                            createdAt: number;
                            /** @description Epoch milliseconds. */
                            updatedAt: number;
                        }[];
                    };
                };
            };
            /** @description No session (an API key is none). */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions, no authority over the client, or a step-up is due (reauthentication_required). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /**
             * @description feature_off: API_CLIENTS=off in this deployment.
             *
             *     No such client in your tenant, endpoint or delivery.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    ClientWebhooksController_create_v1: {
        parameters: {
            query?: never;
            header?: {
                /**
                 * @description A unique key per operation (a UUID), 1 to 255 printable ASCII characters. Send the same key on every retry of the same request: it runs once, and retries get its response (with Idempotent-Replayed: true). Kept for 24 hours.
                 *
                 *     In Swagger UI, leave `generate` to send a new key on every Execute, or type your own key and Execute twice to see a retry replayed.
                 */
                "Idempotency-Key"?: string;
            };
            path: {
                clientId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description A public https:// URL. Private and cloud-metadata addresses are refused. */
                    url: string;
                    /** @description Event types to receive (GET /v1/webhook-event-types), or "*" for all. An unknown type is a 400; so is the reserved webhook.test. */
                    eventTypes: string[];
                    description?: string;
                };
            };
        };
        responses: {
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        tenant: string | null;
                        url: string;
                        eventTypes: string[];
                        description: string | null;
                        enabled: boolean;
                        /** @enum {string|null} */
                        disabledReason: "manual" | "failing" | "gone" | null;
                        /** @description Epoch milliseconds. */
                        failingSince: number | null;
                        /** @description Epoch milliseconds. */
                        createdAt: number;
                        /** @description Epoch milliseconds. */
                        updatedAt: number;
                        /** @description Standard Webhooks whsec_…: verify the signatures with it. Shown this once. */
                        secret: string;
                    };
                };
            };
            /** @description A refused URL (not https, a private or cloud-metadata address) or an unknown event type. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No session (an API key is none). */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description `reauthentication_required`: no sign-in in the last REAUTHENTICATION_MAX_AGE_MINUTES: re-authenticate (POST /auth/reauthenticate, or sign in again: the problem lists `methods`) and retry. Or not allowed: your permissions, or acting as another user. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /**
             * @description feature_off: API_CLIENTS=off in this deployment.
             *
             *     No such client in your tenant, endpoint or delivery.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    ClientWebhooksController_get_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                clientId: string;
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        tenant: string | null;
                        url: string;
                        eventTypes: string[];
                        description: string | null;
                        enabled: boolean;
                        /** @enum {string|null} */
                        disabledReason: "manual" | "failing" | "gone" | null;
                        /** @description Epoch milliseconds. */
                        failingSince: number | null;
                        /** @description Epoch milliseconds. */
                        createdAt: number;
                        /** @description Epoch milliseconds. */
                        updatedAt: number;
                    };
                };
            };
            /** @description No session (an API key is none). */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions, no authority over the client, or a step-up is due (reauthentication_required). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /**
             * @description feature_off: API_CLIENTS=off in this deployment.
             *
             *     No such client in your tenant, endpoint or delivery.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    ClientWebhooksController_delete_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                clientId: string;
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No session (an API key is none). */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions, no authority over the client, or a step-up is due (reauthentication_required). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /**
             * @description feature_off: API_CLIENTS=off in this deployment.
             *
             *     No such client in your tenant, endpoint or delivery.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    ClientWebhooksController_update_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                clientId: string;
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    url?: string;
                    /** @description Event types to receive (GET /v1/webhook-event-types), or "*" for all. An unknown type is a 400; so is the reserved webhook.test. */
                    eventTypes?: string[];
                    /** @description null clears it (an empty string is refused: 400); absent leaves it as it is. */
                    description?: string | null;
                    enabled?: boolean;
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        tenant: string | null;
                        url: string;
                        eventTypes: string[];
                        description: string | null;
                        enabled: boolean;
                        /** @enum {string|null} */
                        disabledReason: "manual" | "failing" | "gone" | null;
                        /** @description Epoch milliseconds. */
                        failingSince: number | null;
                        /** @description Epoch milliseconds. */
                        createdAt: number;
                        /** @description Epoch milliseconds. */
                        updatedAt: number;
                    };
                };
            };
            /** @description No session (an API key is none). */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions, no authority over the client, or a step-up is due (reauthentication_required). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /**
             * @description feature_off: API_CLIENTS=off in this deployment.
             *
             *     No such client in your tenant, endpoint or delivery.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    ClientWebhooksController_rotateSecret_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                clientId: string;
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description The new whsec_…. The old one keeps signing next to it for 24 hours. */
                        secret: string;
                    };
                };
            };
            /** @description No session (an API key is none). */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description `reauthentication_required`: no sign-in in the last REAUTHENTICATION_MAX_AGE_MINUTES: re-authenticate (POST /auth/reauthenticate, or sign in again: the problem lists `methods`) and retry. Or not allowed: your permissions, or acting as another user. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /**
             * @description feature_off: API_CLIENTS=off in this deployment.
             *
             *     No such client in your tenant, endpoint or delivery.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    ClientWebhooksController_test_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                clientId: string;
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        /** @description The webhook-id header: the same on every attempt and replay. */
                        messageId: string;
                        endpointId: string;
                        tenant: string | null;
                        type: string;
                        /** @enum {string} */
                        status: "pending" | "succeeded" | "failed";
                        attempts: number;
                        /** @description Epoch milliseconds. */
                        nextAttemptAt: number | null;
                        /** @description Epoch milliseconds. */
                        lastAttemptAt: number | null;
                        lastStatusCode: number | null;
                        lastError: string | null;
                        /** @enum {string|null} */
                        failureReason: "exhausted" | "rejected" | "endpoint-disabled" | "endpoint-deleted" | null;
                        /** @description Epoch milliseconds. */
                        createdAt: number;
                        /** @description Epoch milliseconds. */
                        completedAt: number | null;
                    };
                };
            };
            /** @description No session (an API key is none). */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions, no authority over the client, or a step-up is due (reauthentication_required). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /**
             * @description feature_off: API_CLIENTS=off in this deployment.
             *
             *     No such client in your tenant, endpoint or delivery.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    ClientWebhooksController_deliveries_v1: {
        parameters: {
            query?: {
                limit?: number;
                /** @description `nextCursor` of the previous page (the same `sort`). */
                cursor?: string;
                /** @description Pages by number instead of cursor: 1 for the first, `limit` rows a page. Example: `page=3&limit=20&count=true`. */
                page?: number;
                /** @description true: add `total` (counted up to a cap; `totalCapped`). */
                count?: "true" | "false";
                lang?: string;
                /** @description Filter: endpointId = */
                endpointId?: string;
                /** @description Filter: endpointId in */
                "endpointId.in"?: string;
                /** @description Filter: status = */
                status?: "pending" | "succeeded" | "failed";
                /** @description Filter: status in */
                "status.in"?: string;
                /** @description Filter: type = */
                type?: string;
                /** @description Filter: type in */
                "type.in"?: string;
                /** @description Filter: type startsWith */
                "type.startsWith"?: string;
                /** @description Filter: attempts gte */
                "attempts.gte"?: number;
                /** @description Filter: attempts lte */
                "attempts.lte"?: number;
                /** @description Filter: createdAt gt */
                "createdAt.gt"?: string;
                /** @description Filter: createdAt gte */
                "createdAt.gte"?: string;
                /** @description Filter: createdAt lt */
                "createdAt.lt"?: string;
                /** @description Filter: createdAt lte */
                "createdAt.lte"?: string;
                /** @description Filter: createdAt between */
                "createdAt.between"?: string;
                /** @description Conditions in and/or groups, JSON: a condition { field, op, value } or a group { "and": [...] } / { "or": [...] }, 3 groups deep and 30 conditions at most. Example: {"or":[{"field":"endpointId","op":"eq","value":…},{…}]}. Fields and operators: endpointId (eq, in); status (eq, in); type (eq, in, startsWith); attempts (gte, lte); createdAt (gt, gte, lt, lte, between). */
                filter?: string;
                /** @description The order: fields comma-separated, - for descending; the newest first on ties. Example: -type. Sortable: type, attempts. */
                sort?: string;
                /** @description Only these fields in each item, comma-separated; id always comes. Example: messageId,endpointId. Fields: id, messageId, endpointId, tenant, type, status, attempts, nextAttemptAt, lastAttemptAt, lastStatusCode, lastError, failureReason, createdAt, completedAt. */
                fields?: string;
            };
            header?: never;
            path: {
                clientId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            id: string;
                            /** @description The webhook-id header: the same on every attempt and replay. */
                            messageId: string;
                            endpointId: string;
                            tenant: string | null;
                            type: string;
                            /** @enum {string} */
                            status: "pending" | "succeeded" | "failed";
                            attempts: number;
                            /** @description Epoch milliseconds. */
                            nextAttemptAt: number | null;
                            /** @description Epoch milliseconds. */
                            lastAttemptAt: number | null;
                            lastStatusCode: number | null;
                            lastError: string | null;
                            /** @enum {string|null} */
                            failureReason: "exhausted" | "rejected" | "endpoint-disabled" | "endpoint-deleted" | null;
                            /** @description Epoch milliseconds. */
                            createdAt: number;
                            /** @description Epoch milliseconds. */
                            completedAt: number | null;
                        }[];
                        /** @description Pass it as `cursor` for the next page; null: no more (and with `page`). */
                        nextCursor: string | null;
                        /** @description With `page`: this page. */
                        page?: number;
                        /** @description With `page`: the next page; null: no more. */
                        nextPage?: number | null;
                        /** @description With `page` and `count=true`: ceil(total / limit). */
                        pageCount?: number;
                        /** @description With `count=true`: the rows matching the filters, all pages; the cap when totalCapped. */
                        total?: number;
                        /** @description true: there are more than `total` (show "10,000+"). */
                        totalCapped?: boolean;
                    };
                };
            };
            /** @description No session (an API key is none). */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions, no authority over the client, or a step-up is due (reauthentication_required). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /**
             * @description feature_off: API_CLIENTS=off in this deployment.
             *
             *     No such client in your tenant, endpoint or delivery.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    ClientWebhooksController_delivery_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                clientId: string;
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        /** @description The webhook-id header: the same on every attempt and replay. */
                        messageId: string;
                        endpointId: string;
                        tenant: string | null;
                        type: string;
                        /** @enum {string} */
                        status: "pending" | "succeeded" | "failed";
                        attempts: number;
                        /** @description Epoch milliseconds. */
                        nextAttemptAt: number | null;
                        /** @description Epoch milliseconds. */
                        lastAttemptAt: number | null;
                        lastStatusCode: number | null;
                        lastError: string | null;
                        /** @enum {string|null} */
                        failureReason: "exhausted" | "rejected" | "endpoint-disabled" | "endpoint-deleted" | null;
                        /** @description Epoch milliseconds. */
                        createdAt: number;
                        /** @description Epoch milliseconds. */
                        completedAt: number | null;
                        message: {
                            id: string;
                            type: string;
                            tenant: string | null;
                            /** @description The exact JSON that was signed and sent. */
                            body: string;
                            /** @description Epoch milliseconds. */
                            createdAt: number;
                        };
                        history: {
                            deliveryId: string;
                            attempt: number;
                            /** @description Epoch milliseconds. */
                            at: number;
                            durationMs: number;
                            statusCode: number | null;
                            /** @description The first 4 KB of the response body. */
                            response: string | null;
                            error: string | null;
                        }[];
                        /** @description Every attempt of the log together, in milliseconds. */
                        durationMs: number;
                        /** @description The request of the latest attempt; null before the first. */
                        lastRequest: {
                            /** @description 1-based, within its round. */
                            attempt: number;
                            /** @description Epoch milliseconds. */
                            sentAt: number;
                            /** @description As sent: webhook-id, webhook-timestamp, webhook-signature (v1,… per live secret), content-type, user-agent. Never the secret. */
                            headers: {
                                [key: string]: string;
                            };
                        } | null;
                    };
                };
            };
            /** @description No session (an API key is none). */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions, no authority over the client, or a step-up is due (reauthentication_required). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /**
             * @description feature_off: API_CLIENTS=off in this deployment.
             *
             *     No such client in your tenant, endpoint or delivery.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    ClientWebhooksController_retry_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                clientId: string;
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description How many deliveries were sent again. */
                        retried: number;
                    };
                };
            };
            /** @description No session (an API key is none). */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions, no authority over the client, or a step-up is due (reauthentication_required). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /**
             * @description feature_off: API_CLIENTS=off in this deployment.
             *
             *     No such client in your tenant, endpoint or delivery.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    ClientWebhooksController_retryFailed_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                clientId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description One endpoint's failed deliveries; every endpoint's without it. */
                    endpointId?: string;
                    /**
                     * Format: date-time
                     * @description Deliveries created at or after this time: the start of the outage.
                     */
                    since?: string;
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description How many deliveries were sent again. */
                        retried: number;
                    };
                };
            };
            /** @description No session (an API key is none). */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions, no authority over the client, or a step-up is due (reauthentication_required). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /**
             * @description feature_off: API_CLIENTS=off in this deployment.
             *
             *     No such client in your tenant, endpoint or delivery.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    OpsController_state_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /**
             * @description operator_required: the caller does not act in the operator tenant.
             *
             *     Not allowed by your permissions.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    OpsController_events_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A stream of `data: {source, at, …}` events. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /**
             * @description operator_required: the caller does not act in the operator tenant.
             *
             *     Not allowed by your permissions.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    OpsController_queueOverview_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /**
             * @description operator_required: the caller does not act in the operator tenant.
             *
             *     Not allowed by your permissions.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    OpsController_retryFailed_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /**
             * @description operator_required: the caller does not act in the operator tenant.
             *
             *     Not allowed by your permissions.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    OpsController_requeue_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    ids?: string[];
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /**
             * @description operator_required: the caller does not act in the operator tenant.
             *
             *     Not allowed by your permissions.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    OpsController_purge_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    ids?: string[];
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /**
             * @description operator_required: the caller does not act in the operator tenant.
             *
             *     Not allowed by your permissions.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    FeaturesController_list_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description The socket.io gateway at `/realtime`. */
                        realtime: boolean;
                        /** @description The webhook endpoints and deliveries API (`/v1/webhook-endpoints`). */
                        webhooks: boolean;
                        /** @description Scheduled reports (`/v1/reports`). */
                        reports: boolean;
                        /** @description API clients' usage and daily quotas (`/v1/access/clients/{id}/usage`). */
                        usage: boolean;
                        /** @description Support impersonation (`/v1/access/users/{id}/impersonate`). */
                        impersonation: boolean;
                        /** @description Two-factor enrollment (`/v1/auth/mfa/enroll`). Off: enrolled users are still asked for a code. */
                        mfa: boolean;
                        /** @description API clients (`/v1/access/clients`) and their keys. */
                        apiClients: boolean;
                        /** @description Passkeys (`/v1/auth/passkeys`). */
                        passkeys: boolean;
                        /** @description Self sign-up (`POST /v1/auth/sign-up`). */
                        signUp: boolean;
                        /** @description Sign-in by email link (`POST /v1/auth/magic-link`). */
                        magicLink: boolean;
                        /** @description PDF documents of records. Off: they answer 503 `documents_unavailable` (no Gotenberg is configured). */
                        documents: boolean;
                        /**
                         * @description `single`: the first tenant is the only one.
                         * @enum {string}
                         */
                        tenancy: "multi" | "single";
                        /** @description The languages the API answers in; the first is the default. */
                        locales: string[];
                    };
                };
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    DataTransferController_catalog_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    DataTransferController_startExport_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @example notes */
                    name: string;
                    /**
                     * @default csv
                     * @enum {string}
                     */
                    format?: "csv" | "json" | "xlsx";
                    /** @description The list filters of that data, as on its list route: { "status": "draft" }. */
                    filters?: {
                        [key: string]: string;
                    };
                    /**
                     * @description The time zone of the file's dates (ISO 8601 with its offset). Default: the user's own, else the server's (APP_TIMEZONE).
                     * @example Europe/Berlin
                     */
                    timezone?: string;
                };
            };
        };
        responses: {
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        /** @enum {string} */
                        status: "queued";
                    };
                };
            };
            /** @description You may not export it (forbidden), or its filters use a field your permissions hide (field_forbidden, naming it). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    DataTransferController_startImport_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "multipart/form-data": {
                    /** @example notes */
                    name: string;
                    /**
                     * @description true: check every row, write nothing.
                     * @default false
                     * @enum {string}
                     */
                    dryRun?: "true" | "false";
                    /**
                     * Format: binary
                     * @description Required. CSV, JSON (an array) or Excel (.xlsx), at most 50 MB. GET /v1/data/imports/{name}/template gives one to fill.
                     */
                    file?: string;
                };
            };
        };
        responses: {
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        /** @enum {string} */
                        status: "queued";
                    };
                };
            };
        };
    };
    DataTransferController_template_v1: {
        parameters: {
            query?: {
                format?: "csv" | "json" | "xlsx";
                /** @description The time zone of the template's date-time columns. Default: the user's own, else the server's (APP_TIMEZONE). */
                timezone?: string;
            };
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The template file, as an attachment. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    DataTransferController_status_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        /** @enum {string} */
                        kind: "export" | "import";
                        name: string;
                        /** @enum {string} */
                        format: "csv" | "json" | "xlsx";
                        /** @enum {string} */
                        status: "queued" | "running" | "completed" | "failed";
                        progress: {
                            [key: string]: number;
                        };
                        result?: {
                            rows: number;
                            /**
                             * Format: uri
                             * @description The file, for 30m.
                             */
                            url?: string;
                            imported?: number;
                            failed?: number;
                            dryRun?: boolean;
                            /**
                             * Format: uri
                             * @description A CSV of the refused rows: row, field, message.
                             */
                            errorsUrl?: string;
                        };
                        error?: string;
                    };
                };
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    BulkController_status_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        name: string;
                        action: string;
                        /** @enum {string} */
                        status: "queued" | "running" | "completed" | "failed";
                        /** @description processed, done, failed: every 100 items. */
                        progress: {
                            [key: string]: number;
                        };
                        result?: {
                            done: number;
                            failed: number;
                            /** @description Ids not found, or not yours to act on (code not_found). */
                            skipped: number;
                            results: {
                                id: string;
                                /** @enum {string} */
                                status: "done" | "failed" | "skipped";
                                /** @description Why it failed: the problem the record's own route would have answered. */
                                error?: {
                                    /** @example field_forbidden */
                                    code: string;
                                    message: string;
                                    errors?: {
                                        path: string;
                                        message: string;
                                    }[];
                                };
                            }[];
                            /** @description A background job keeps 10000 results; true when there were more. */
                            truncated?: boolean;
                        };
                        error?: string;
                    };
                };
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    CustomFieldsController_list_v1: {
        parameters: {
            query: {
                subject: string;
                includeInactive?: "true" | "false";
                lang?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** Format: uuid */
                            id: string;
                            subject: string;
                            key: string;
                            label: string;
                            description: string | null;
                            /** @enum {string} */
                            type: "text" | "longText" | "number" | "boolean" | "date" | "select" | "multiSelect" | "email" | "url";
                            options: {
                                value: string;
                                label: string;
                            }[] | null;
                            required: boolean;
                            default: unknown;
                            validation: {
                                /** @description number: lowest value; multiSelect: fewest choices. */
                                min?: number;
                                /** @description number: highest value; multiSelect: most choices. */
                                max?: number;
                                minLength?: number;
                                maxLength?: number;
                                /** @description A regular expression the whole value must match (text types), in RE2 syntax: no lookaround, no backreferences. */
                                pattern?: string;
                            } | null;
                            position: number;
                            filterable: boolean;
                            sortable: boolean;
                            active: boolean;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: date-time */
                            updatedAt: string;
                        }[];
                    };
                };
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The subject takes no custom fields. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    CustomFieldsController_create_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @example Note */
                    subject: string;
                    /**
                     * @description The JSON key of the value; never changes.
                     * @example region
                     */
                    key: string;
                    /** @example Region */
                    label: string;
                    description?: string | null;
                    /**
                     * @example select
                     * @enum {string}
                     */
                    type: "text" | "longText" | "number" | "boolean" | "date" | "select" | "multiSelect" | "email" | "url";
                    /**
                     * @description The choices of select and multiSelect.
                     * @example [
                     *       {
                     *         "value": "eu",
                     *         "label": "Europe"
                     *       },
                     *       {
                     *         "value": "us",
                     *         "label": "Americas"
                     *       }
                     *     ]
                     */
                    options?: {
                        value: string;
                        label: string;
                    }[];
                    required?: boolean;
                    /** @description Filled in on create when the value is left out. */
                    default?: unknown;
                    validation?: {
                        /** @description number: lowest value; multiSelect: fewest choices. */
                        min?: number;
                        /** @description number: highest value; multiSelect: most choices. */
                        max?: number;
                        minLength?: number;
                        maxLength?: number;
                        /** @description A regular expression the whole value must match (text types), in RE2 syntax: no lookaround, no backreferences. */
                        pattern?: string;
                    };
                    /** @description Default: after the others. */
                    position?: number;
                    filterable?: boolean;
                    sortable?: boolean;
                };
            };
        };
        responses: {
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        subject: string;
                        key: string;
                        label: string;
                        description: string | null;
                        /** @enum {string} */
                        type: "text" | "longText" | "number" | "boolean" | "date" | "select" | "multiSelect" | "email" | "url";
                        options: {
                            value: string;
                            label: string;
                        }[] | null;
                        required: boolean;
                        default: unknown;
                        validation: {
                            /** @description number: lowest value; multiSelect: fewest choices. */
                            min?: number;
                            /** @description number: highest value; multiSelect: most choices. */
                            max?: number;
                            minLength?: number;
                            maxLength?: number;
                            /** @description A regular expression the whole value must match (text types), in RE2 syntax: no lookaround, no backreferences. */
                            pattern?: string;
                        } | null;
                        position: number;
                        filterable: boolean;
                        sortable: boolean;
                        active: boolean;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: date-time */
                        updatedAt: string;
                    };
                };
            };
            /** @description Invalid definition: options, validation or default that the type does not take. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The key exists (custom_field_exists), or the subject has 100 active fields (custom_field_limit). */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    CustomFieldsController_reorder_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    subject: string;
                    /** @description These fields first, in this order; the others follow. */
                    ids: string[];
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** Format: uuid */
                            id: string;
                            subject: string;
                            key: string;
                            label: string;
                            description: string | null;
                            /** @enum {string} */
                            type: "text" | "longText" | "number" | "boolean" | "date" | "select" | "multiSelect" | "email" | "url";
                            options: {
                                value: string;
                                label: string;
                            }[] | null;
                            required: boolean;
                            default: unknown;
                            validation: {
                                /** @description number: lowest value; multiSelect: fewest choices. */
                                min?: number;
                                /** @description number: highest value; multiSelect: most choices. */
                                max?: number;
                                minLength?: number;
                                maxLength?: number;
                                /** @description A regular expression the whole value must match (text types), in RE2 syntax: no lookaround, no backreferences. */
                                pattern?: string;
                            } | null;
                            position: number;
                            filterable: boolean;
                            sortable: boolean;
                            active: boolean;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: date-time */
                            updatedAt: string;
                        }[];
                    };
                };
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    CustomFieldsController_deactivate_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    CustomFieldsController_update_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @example Region */
                    label?: string;
                    description?: string | null;
                    /**
                     * @example select
                     * @enum {string}
                     */
                    type?: "text" | "longText" | "number" | "boolean" | "date" | "select" | "multiSelect" | "email" | "url";
                    options?: {
                        value: string;
                        label: string;
                    }[] | null;
                    required?: boolean;
                    /** @description null: no default. */
                    default?: unknown;
                    validation?: {
                        /** @description number: lowest value; multiSelect: fewest choices. */
                        min?: number;
                        /** @description number: highest value; multiSelect: most choices. */
                        max?: number;
                        minLength?: number;
                        maxLength?: number;
                        /** @description A regular expression the whole value must match (text types), in RE2 syntax: no lookaround, no backreferences. */
                        pattern?: string;
                    } | null;
                    filterable?: boolean;
                    sortable?: boolean;
                    /** @description false deactivates (values kept), true brings it back. */
                    active?: boolean;
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        subject: string;
                        key: string;
                        label: string;
                        description: string | null;
                        /** @enum {string} */
                        type: "text" | "longText" | "number" | "boolean" | "date" | "select" | "multiSelect" | "email" | "url";
                        options: {
                            value: string;
                            label: string;
                        }[] | null;
                        required: boolean;
                        default: unknown;
                        validation: {
                            /** @description number: lowest value; multiSelect: fewest choices. */
                            min?: number;
                            /** @description number: highest value; multiSelect: most choices. */
                            max?: number;
                            minLength?: number;
                            maxLength?: number;
                            /** @description A regular expression the whole value must match (text types), in RE2 syntax: no lookaround, no backreferences. */
                            pattern?: string;
                        } | null;
                        position: number;
                        filterable: boolean;
                        sortable: boolean;
                        active: boolean;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: date-time */
                        updatedAt: string;
                    };
                };
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Records hold values the change would break (custom_field_in_use). */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    NotificationsController_list_v1: {
        parameters: {
            query?: {
                limit?: number;
                /** @description `nextCursor` of the previous page (the same `sort`). */
                cursor?: string;
                /** @description Pages by number instead of cursor: 1 for the first, `limit` rows a page. Example: `page=3&limit=20&count=true`. */
                page?: number;
                /** @description true: add `total` (counted up to a cap; `totalCapped`). */
                count?: "true" | "false";
                lang?: string;
                /** @description Filter: read = */
                read?: "true" | "false";
                /** @description Filter: type = */
                type?: string;
                /** @description Filter: type in */
                "type.in"?: string;
                /** @description Filter: key = */
                key?: string;
                /** @description Filter: readAt gt */
                "readAt.gt"?: string;
                /** @description Filter: readAt gte */
                "readAt.gte"?: string;
                /** @description Filter: readAt lt */
                "readAt.lt"?: string;
                /** @description Filter: readAt lte */
                "readAt.lte"?: string;
                /** @description Filter: readAt between */
                "readAt.between"?: string;
                /** @description Filter: readAt isNull */
                "readAt.isNull"?: "true" | "false";
                /** @description Filter: createdAt gt */
                "createdAt.gt"?: string;
                /** @description Filter: createdAt gte */
                "createdAt.gte"?: string;
                /** @description Filter: createdAt lt */
                "createdAt.lt"?: string;
                /** @description Filter: createdAt lte */
                "createdAt.lte"?: string;
                /** @description Filter: createdAt between */
                "createdAt.between"?: string;
                /** @description Filter: updatedAt gt */
                "updatedAt.gt"?: string;
                /** @description Filter: updatedAt gte */
                "updatedAt.gte"?: string;
                /** @description Filter: updatedAt lt */
                "updatedAt.lt"?: string;
                /** @description Filter: updatedAt lte */
                "updatedAt.lte"?: string;
                /** @description Filter: updatedAt between */
                "updatedAt.between"?: string;
                /** @description Conditions in and/or groups, JSON: a condition { field, op, value } or a group { "and": [...] } / { "or": [...] }, 3 groups deep and 30 conditions at most. Example: {"or":[{"field":"read","op":"eq","value":…},{…}]}. Fields and operators: read (eq); type (eq, in); key (eq); readAt (gt, gte, lt, lte, between, isNull); createdAt (gt, gte, lt, lte, between); updatedAt (gt, gte, lt, lte, between). */
                filter?: string;
                /** @description The order: fields comma-separated, - for descending; the newest first on ties. Example: -readAt. Sortable: readAt, createdAt, updatedAt. */
                sort?: string;
                /** @description Only these fields in each item, comma-separated; id always comes. Example: type,title. Fields: id, type, title, body, data, link, key, count, read, readAt, createdAt, updatedAt. */
                fields?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** Format: uuid */
                            id: string;
                            /** @example note.published */
                            type: string;
                            title: string;
                            body: string;
                            /** @description What the texts were made from, and what a client needs to act on it. */
                            data: {
                                [key: string]: unknown;
                            };
                            /** @description A path of the web app, or null. */
                            link: string | null;
                            /** @description The collapse key, when it has one. */
                            key: string | null;
                            /** @description How many notifications this one stands for (collapsed). */
                            count: number;
                            read: boolean;
                            /** Format: date-time */
                            readAt: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: date-time */
                            updatedAt: string;
                        }[];
                        /** @description Pass it as `cursor` for the next page; null: no more (and with `page`). */
                        nextCursor: string | null;
                        /** @description With `page`: this page. */
                        page?: number;
                        /** @description With `page`: the next page; null: no more. */
                        nextPage?: number | null;
                        /** @description With `page` and `count=true`: ceil(total / limit). */
                        pageCount?: number;
                        /** @description With `count=true`: the rows matching the filters, all pages; the cap when totalCapped. */
                        total?: number;
                        /** @description true: there are more than `total` (show "10,000+"). */
                        totalCapped?: boolean;
                    };
                };
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    NotificationsController_unreadCount_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        unread: number;
                    };
                };
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    NotificationsController_readAll_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * Format: date-time
                     * @description Only those created before this moment (what the client has shown).
                     */
                    before?: string;
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        updated: number;
                    };
                };
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    NotificationsController_types_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** @example note.published */
                            type: string;
                            /** @description In the request's language. */
                            label: string;
                            /** @description Its channels cannot be switched off (their frequency may change). */
                            mandatory: boolean;
                            /** @description The defaults of the channels you may set (in-app and realtime are always on). */
                            channels: {
                                /** @description Users only: `false` (no mail), `immediate`, or bundled into an `hourly` or `daily` digest. */
                                email?: ("immediate" | "hourly" | "daily") | false;
                                /** @description API clients only: whether the `notification.created` webhook is sent. */
                                webhook?: boolean;
                            };
                        }[];
                    };
                };
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    NotificationsController_preferences_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /**
                         * @example {
                         *       "note.published": {
                         *         "email": "daily"
                         *       }
                         *     }
                         */
                        types: {
                            [key: string]: {
                                /** @description Users only: `false` (no mail), `immediate`, or bundled into an `hourly` or `daily` digest. */
                                email?: ("immediate" | "hourly" | "daily") | false;
                                /** @description API clients only: whether the `notification.created` webhook is sent. */
                                webhook?: boolean;
                            };
                        };
                    };
                };
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    NotificationsController_updatePreferences_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    [key: string]: {
                        /** @description Users only: `false` (no mail), `immediate`, or bundled into an `hourly` or `daily` digest. */
                        email?: ("immediate" | "hourly" | "daily") | false;
                        /** @description API clients only: whether the `notification.created` webhook is sent. */
                        webhook?: boolean;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /**
                         * @example {
                         *       "note.published": {
                         *         "email": "daily"
                         *       }
                         *     }
                         */
                        types: {
                            [key: string]: {
                                /** @description Users only: `false` (no mail), `immediate`, or bundled into an `hourly` or `daily` digest. */
                                email?: ("immediate" | "hourly" | "daily") | false;
                                /** @description API clients only: whether the `notification.created` webhook is sent. */
                                webhook?: boolean;
                            };
                        };
                    };
                };
            };
            /** @description An unknown type or channel, a value the channel does not take, or a mandatory type switched off (validation_failed, each error naming `<type>.<channel>`). */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    NotificationsController_markRead_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        /** @example note.published */
                        type: string;
                        title: string;
                        body: string;
                        /** @description What the texts were made from, and what a client needs to act on it. */
                        data: {
                            [key: string]: unknown;
                        };
                        /** @description A path of the web app, or null. */
                        link: string | null;
                        /** @description The collapse key, when it has one. */
                        key: string | null;
                        /** @description How many notifications this one stands for (collapsed). */
                        count: number;
                        read: boolean;
                        /** Format: date-time */
                        readAt: string | null;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: date-time */
                        updatedAt: string;
                    };
                };
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not yours, or gone. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    NotificationsController_remove_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not yours, or gone. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    NotificationTestController_test_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /**
                         * Format: uuid
                         * @description The notification, delivered to you shortly.
                         */
                        id: string;
                    };
                };
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description An administrator acting as someone. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    SettingsController_list_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** @example notes.publishDelay */
                            key: string;
                            label: string;
                            description: string | null;
                            /** @description A feature flag (boolean, may roll out to a share of principals). */
                            flag: boolean;
                            /** @description Where it may be set; `user`: you may set it for yourself. */
                            scopes: ("tenant" | "team" | "user")[];
                            public: boolean;
                            value: unknown;
                            /**
                             * @description Where your value comes from.
                             * @enum {string}
                             */
                            source: "tenant" | "team" | "user" | "rollout" | "default";
                            default: unknown;
                            /**
                             * @description The value's kind, from the declaration's schema: the input to show. `json`: anything else (an object, a union); `schema` says what.
                             * @enum {string}
                             */
                            type: "boolean" | "number" | "string" | "enum" | "json";
                            /** @description `enum`: the values it takes. */
                            options?: (string | number)[];
                            /** @description `number`: the smallest it takes. */
                            min?: number;
                            /** @description `number`: the largest it takes. */
                            max?: number;
                            /** @description `number`: whole numbers only. */
                            integer?: boolean;
                            /** @description `string`: the most characters it takes. */
                            maxLength?: number;
                            /** @description The value's JSON Schema (draft 2020-12), generated from the declaration: patterns, exclusive bounds, an object's shape. What it can't express (a refinement) is still checked on PUT. */
                            schema: {
                                [key: string]: unknown;
                            };
                            /** @description You may set and remove its value for the tenant, a team or a principal (PUT and DELETE /v1/settings/{key}, every scope it takes): Access.manageSettings, not while impersonating. */
                            canEdit: boolean;
                            /** @description You may set your own value (PUT and DELETE /v1/settings/{key}/mine): its scopes include `user`. */
                            canSetMine: boolean;
                        }[];
                    };
                };
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    SettingsController_get_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                key: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @example notes.publishDelay */
                        key: string;
                        label: string;
                        description: string | null;
                        /** @description A feature flag (boolean, may roll out to a share of principals). */
                        flag: boolean;
                        /** @description Where it may be set; `user`: you may set it for yourself. */
                        scopes: ("tenant" | "team" | "user")[];
                        public: boolean;
                        value: unknown;
                        /**
                         * @description Where your value comes from.
                         * @enum {string}
                         */
                        source: "tenant" | "team" | "user" | "rollout" | "default";
                        default: unknown;
                        /**
                         * @description The value's kind, from the declaration's schema: the input to show. `json`: anything else (an object, a union); `schema` says what.
                         * @enum {string}
                         */
                        type: "boolean" | "number" | "string" | "enum" | "json";
                        /** @description `enum`: the values it takes. */
                        options?: (string | number)[];
                        /** @description `number`: the smallest it takes. */
                        min?: number;
                        /** @description `number`: the largest it takes. */
                        max?: number;
                        /** @description `number`: whole numbers only. */
                        integer?: boolean;
                        /** @description `string`: the most characters it takes. */
                        maxLength?: number;
                        /** @description The value's JSON Schema (draft 2020-12), generated from the declaration: patterns, exclusive bounds, an object's shape. What it can't express (a refinement) is still checked on PUT. */
                        schema: {
                            [key: string]: unknown;
                        };
                        /** @description You may set and remove its value for the tenant, a team or a principal (PUT and DELETE /v1/settings/{key}, every scope it takes): Access.manageSettings, not while impersonating. */
                        canEdit: boolean;
                        /** @description You may set your own value (PUT and DELETE /v1/settings/{key}/mine): its scopes include `user`. */
                        canSetMine: boolean;
                    };
                };
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    SettingsController_set_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                key: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * @default tenant
                     * @enum {string}
                     */
                    scope?: "tenant" | "team" | "user";
                    /** @description For team: the team's id; for user: the principal's key (`user:<id>`, `client:<id>`). */
                    scopeId?: string;
                    /** @description The value; left out with `rollout`: the flag's rollout alone applies. */
                    value?: unknown;
                    /** @description Flags, tenant scope: the percentage of the tenant's principals the flag is on for. */
                    rollout?: number | null;
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @example notes.publishDelay */
                        key: string;
                        /** @enum {string} */
                        scope: "tenant" | "team" | "user";
                        /** @description The team's id, the principal's key (`user:<id>`), or '' for the tenant. */
                        scopeId: string;
                        value: unknown;
                        rollout: number | null;
                        updatedBy: string;
                        /** Format: date-time */
                        updatedAt: string;
                    };
                };
            };
            /** @description A scope the setting does not take, a value its schema refuses, a rollout on something that is not a flag at the tenant scope (validation_failed). */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No such setting, team or principal. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    SettingsController_unset_v1: {
        parameters: {
            query?: {
                scope?: "tenant" | "team" | "user";
                scopeId?: string;
            };
            header?: never;
            path: {
                key: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    SettingsController_setMine_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                key: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    value: unknown;
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @example notes.publishDelay */
                        key: string;
                        label: string;
                        description: string | null;
                        /** @description A feature flag (boolean, may roll out to a share of principals). */
                        flag: boolean;
                        /** @description Where it may be set; `user`: you may set it for yourself. */
                        scopes: ("tenant" | "team" | "user")[];
                        public: boolean;
                        value: unknown;
                        /**
                         * @description Where your value comes from.
                         * @enum {string}
                         */
                        source: "tenant" | "team" | "user" | "rollout" | "default";
                        default: unknown;
                        /**
                         * @description The value's kind, from the declaration's schema: the input to show. `json`: anything else (an object, a union); `schema` says what.
                         * @enum {string}
                         */
                        type: "boolean" | "number" | "string" | "enum" | "json";
                        /** @description `enum`: the values it takes. */
                        options?: (string | number)[];
                        /** @description `number`: the smallest it takes. */
                        min?: number;
                        /** @description `number`: the largest it takes. */
                        max?: number;
                        /** @description `number`: whole numbers only. */
                        integer?: boolean;
                        /** @description `string`: the most characters it takes. */
                        maxLength?: number;
                        /** @description The value's JSON Schema (draft 2020-12), generated from the declaration: patterns, exclusive bounds, an object's shape. What it can't express (a refinement) is still checked on PUT. */
                        schema: {
                            [key: string]: unknown;
                        };
                        /** @description You may set and remove its value for the tenant, a team or a principal (PUT and DELETE /v1/settings/{key}, every scope it takes): Access.manageSettings, not while impersonating. */
                        canEdit: boolean;
                        /** @description You may set your own value (PUT and DELETE /v1/settings/{key}/mine): its scopes include `user`. */
                        canSetMine: boolean;
                    };
                };
            };
            /** @description Not set per user, or an invalid value. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    SettingsController_unsetMine_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                key: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @example notes.publishDelay */
                        key: string;
                        label: string;
                        description: string | null;
                        /** @description A feature flag (boolean, may roll out to a share of principals). */
                        flag: boolean;
                        /** @description Where it may be set; `user`: you may set it for yourself. */
                        scopes: ("tenant" | "team" | "user")[];
                        public: boolean;
                        value: unknown;
                        /**
                         * @description Where your value comes from.
                         * @enum {string}
                         */
                        source: "tenant" | "team" | "user" | "rollout" | "default";
                        default: unknown;
                        /**
                         * @description The value's kind, from the declaration's schema: the input to show. `json`: anything else (an object, a union); `schema` says what.
                         * @enum {string}
                         */
                        type: "boolean" | "number" | "string" | "enum" | "json";
                        /** @description `enum`: the values it takes. */
                        options?: (string | number)[];
                        /** @description `number`: the smallest it takes. */
                        min?: number;
                        /** @description `number`: the largest it takes. */
                        max?: number;
                        /** @description `number`: whole numbers only. */
                        integer?: boolean;
                        /** @description `string`: the most characters it takes. */
                        maxLength?: number;
                        /** @description The value's JSON Schema (draft 2020-12), generated from the declaration: patterns, exclusive bounds, an object's shape. What it can't express (a refinement) is still checked on PUT. */
                        schema: {
                            [key: string]: unknown;
                        };
                        /** @description You may set and remove its value for the tenant, a team or a principal (PUT and DELETE /v1/settings/{key}, every scope it takes): Access.manageSettings, not while impersonating. */
                        canEdit: boolean;
                        /** @description You may set your own value (PUT and DELETE /v1/settings/{key}/mine): its scopes include `user`. */
                        canSetMine: boolean;
                    };
                };
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    SettingsController_overrides_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                key: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** @example notes.publishDelay */
                            key: string;
                            /** @enum {string} */
                            scope: "tenant" | "team" | "user";
                            /** @description The team's id, the principal's key (`user:<id>`), or '' for the tenant. */
                            scopeId: string;
                            value: unknown;
                            rollout: number | null;
                            updatedBy: string;
                            /** Format: date-time */
                            updatedAt: string;
                        }[];
                    };
                };
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    AccountController_state_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description A pending deletion of this account, or null. */
                        deletion: {
                            /** Format: date-time */
                            requestedAt: string;
                            /**
                             * Format: date-time
                             * @description When the account is deleted, unless cancelled before.
                             */
                            scheduledFor: string;
                        } | null;
                        /** @description The latest version accepted of each kind. */
                        consents: {
                            /** @example terms */
                            kind: string;
                            /** @example 2026-01 */
                            version: string;
                            /** Format: date-time */
                            acceptedAt: string;
                        }[];
                    };
                };
            };
            /** @description Not signed in as a user. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    AccountController_export_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * @default json
                     * @enum {string}
                     */
                    format?: "csv" | "json" | "xlsx";
                };
            };
        };
        responses: {
            /** @description { id, status } */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not signed in as a user. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    AccountController_requestDeletion_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description Your current password: required when the account has one. */
                    password?: string;
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: date-time */
                        requestedAt: string;
                        /**
                         * Format: date-time
                         * @description When the account is deleted, unless cancelled before.
                         */
                        scheduledFor: string;
                    };
                };
            };
            /** @description The password is missing (validation_failed). */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not signed in as a user. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /**
             * @description The password is wrong; or `reauthentication_required`; or acting as another user.
             *
             *     `reauthentication_required`: no sign-in in the last REAUTHENTICATION_MAX_AGE_MINUTES: re-authenticate (POST /auth/reauthenticate, or sign in again: the problem lists `methods`) and retry. Or not allowed: your permissions, or acting as another user.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description More than 5 attempts from this address, or 10 for this account, in 15 minutes. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    AccountController_cancelDeletion_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not signed in as a user. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No deletion is pending. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    AccountController_consents_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** @example terms */
                            kind: string;
                            /** @example 2026-01 */
                            version: string;
                            /** Format: date-time */
                            acceptedAt: string;
                        }[];
                    };
                };
            };
            /** @description Not signed in as a user. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    AccountController_accept_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @example terms */
                    kind: string;
                    /** @example 2026-01 */
                    version: string;
                };
            };
        };
        responses: {
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @example terms */
                        kind: string;
                        /** @example 2026-01 */
                        version: string;
                        /** Format: date-time */
                        acceptedAt: string;
                    };
                };
            };
            /** @description Not signed in as a user. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    AccountDeletionLinkController_cancel_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description The `token` of the deletion mail's cancel link. */
                    token: string;
                };
            };
        };
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The link is invalid, expired or used, or the deletion was cancelled or carried out already: one answer for all. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description More than 10 attempts from this address in 15 minutes. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    SubscriptionsController_list_v1: {
        parameters: {
            query?: {
                limit?: number;
                /** @description `nextCursor` of the previous page (the same `sort`). */
                cursor?: string;
                /** @description Pages by number instead of cursor: 1 for the first, `limit` rows a page. Example: `page=3&limit=20&count=true`. */
                page?: number;
                /** @description true: add `total` (counted up to a cap; `totalCapped`). */
                count?: "true" | "false";
                lang?: string;
                /** @description Filter: subject = */
                subject?: string;
                /** @description Filter: subject in */
                "subject.in"?: string;
                /** @description Filter: recordId = */
                recordId?: string;
                /** @description Filter: createdAt gt */
                "createdAt.gt"?: string;
                /** @description Filter: createdAt gte */
                "createdAt.gte"?: string;
                /** @description Filter: createdAt lt */
                "createdAt.lt"?: string;
                /** @description Filter: createdAt lte */
                "createdAt.lte"?: string;
                /** @description Filter: createdAt between */
                "createdAt.between"?: string;
                /** @description Conditions in and/or groups, JSON: a condition { field, op, value } or a group { "and": [...] } / { "or": [...] }, 3 groups deep and 30 conditions at most. Example: {"or":[{"field":"subject","op":"eq","value":…},{…}]}. Fields and operators: subject (eq, in); recordId (eq); createdAt (gt, gte, lt, lte, between). */
                filter?: string;
                /** @description The order: fields comma-separated, - for descending; the newest first on ties. Example: -createdAt. Sortable: createdAt. */
                sort?: string;
                /** @description Only these fields in each item, comma-separated; id always comes. Example: subject,recordId. Fields: subject, recordId, createdAt. */
                fields?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** @example Note */
                            subject: string;
                            /** @example 0199a3f2-… */
                            recordId: string;
                            /** Format: date-time */
                            createdAt: string;
                        }[];
                        /** @description Pass it as `cursor` for the next page; null: no more (and with `page`). */
                        nextCursor: string | null;
                        /** @description With `page`: this page. */
                        page?: number;
                        /** @description With `page`: the next page; null: no more. */
                        nextPage?: number | null;
                        /** @description With `page` and `count=true`: ceil(total / limit). */
                        pageCount?: number;
                        /** @description With `count=true`: the rows matching the filters, all pages; the cap when totalCapped. */
                        total?: number;
                        /** @description true: there are more than `total` (show "10,000+"). */
                        totalCapped?: boolean;
                    };
                };
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    SubscriptionsController_remove_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                subject: string;
                recordId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description You were not watching it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    SearchController_search_v1: {
        parameters: {
            query: {
                q: string;
                /** @description Only this kind of record (`Note`); default: every kind. */
                subject?: string;
                limit?: number;
                lang?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            subject: string;
                            id: string;
                            title: string;
                            snippet: string | null;
                            score: number;
                            link: string | null;
                        }[];
                    };
                };
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    ListsController_describe_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The kind of record, as permissions name it (`Note`). */
                subject: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @example Note */
                        subject: string;
                        /** @description The fields the list may be filtered or sorted by, as this caller may read them: a field their permissions hide is not here; one they may read on some records only has no operators and is not sortable (still in `select`). */
                        fields: {
                            /**
                             * @description The name in the query: `?<name>.<operator>=`, `{ "field": <name> }` in `filter`, `sort=<name>`. Custom fields are `custom.<key>`.
                             * @example status
                             */
                            name: string;
                            /**
                             * @description How values are written: datetime ISO 8601 with an offset, date YYYY-MM-DD, enum one of `options`.
                             * @enum {string}
                             */
                            type: "string" | "uuid" | "datetime" | "date" | "number" | "boolean" | "enum";
                            /**
                             * @description The values an enum takes.
                             * @example [
                             *       "draft",
                             *       "published"
                             *     ]
                             */
                            options?: string[];
                            /**
                             * @description The operators it may be filtered with; empty: none.
                             * @example [
                             *       "eq",
                             *       "ne",
                             *       "in",
                             *       "notIn"
                             *     ]
                             */
                            operators: ("eq" | "ne" | "in" | "notIn" | "contains" | "notContains" | "startsWith" | "endsWith" | "gt" | "gte" | "lt" | "lte" | "between" | "isNull")[];
                            /**
                             * @description What the field's values are ids of, for a picker instead of a text box: `tag` (GET /v1/tags), `team` (GET /v1/access/teams), `principal` (a user's or an API client's key, `user:<id>` or `client:<id>`) or a record's subject (`Invoice`: GET its list). Absent for any other field.
                             * @example tag
                             */
                            ref?: string;
                            /** @description `sort` may name it. */
                            sortable: boolean;
                            /** @description A custom field of the caller's tenant (GET /v1/custom-fields). */
                            custom: boolean;
                            /** @description A custom field's label, as its administrators named it. */
                            label?: string;
                        }[];
                        /**
                         * @description What `fields=` may pick (id always comes).
                         * @example [
                         *       "title",
                         *       "status",
                         *       "custom.region"
                         *     ]
                         */
                        select: string[];
                        /** @description `q=` searches the text, and `sort=-rank` puts the best match first. False when the search reads a field this caller may not read on every record. */
                        search: boolean;
                        /** @description `deleted=true` lists the recycle bin for this caller (they may restore). */
                        recycleBin: boolean;
                        /**
                         * @description The order without `sort`: the newest first.
                         * @example -createdAt
                         */
                        defaultSort: string | null;
                        /** @description The list's limits, the same on every list. */
                        limits: {
                            /** @description Rows a page holds without `limit`. */
                            defaultLimit: number;
                            /** @description The largest `limit`. */
                            maxLimit: number;
                            /** @description No `page` starts past this row: narrow the filters, or page by cursor. */
                            maxOffset: number;
                            /** @description `count=true` counts up to this (then `totalCapped`). */
                            countCap: number;
                            /** @description Fields `sort` may name. */
                            maxSort: number;
                            /** @description Conditions in one `filter`. */
                            maxConditions: number;
                            /** @description Groups nested in one `filter`. */
                            maxDepth: number;
                            /** @description Values of one `in` or `notIn`. */
                            maxValues: number;
                        };
                        /** @description What the subject's records take, from their declaration (`<item>.record.ts`): a client shows a record's panels (comments, attachments, tags, revisions, PDF, approvals…) only where they are true. Whether the caller may use one on a record is the record's `can` (`?include=can`) and the routes' answers. */
                        capabilities: {
                            /** @description Tags on the records (`…/{id}/tags`) and the `tag` filter. */
                            tags: boolean;
                            /** @description Comments and @mentions (`…/{id}/comments`). */
                            comments: boolean;
                            /** @description Files on the records (`…/{id}/attachments`); what a file may be is `attachmentLimits`. */
                            attachments: boolean;
                            /** @description History, diff and restore (`…/{id}/revisions`). */
                            revisions: boolean;
                            /** @description A PDF of a record (`…/{id}/pdf`). False when this deployment has no Gotenberg (the routes answer 503). */
                            pdf: boolean;
                            /** @description Many records at once (`…/bulk`). */
                            bulk: boolean;
                            /** @description Watching a record (`…/{id}/watch`): its watchers are told of changes. */
                            watch: boolean;
                            /** @description `q=` on the list, and the records in GET /v1/search. */
                            search: boolean;
                            /** @description Exports and imports (POST /v1/data/exports, /v1/data/imports). */
                            transfer: boolean;
                            /** @description Custom fields (GET /v1/custom-fields?subject=…): `custom.<key>` in the list. */
                            custom: boolean;
                            /** @description Webhook events of its changes (`<item>.created`…). False with WEBHOOKS=off. */
                            events: boolean;
                            /** @description A human-readable number (`number`, `INV-2026-00042`). */
                            numbered: boolean;
                            /** @description An action on the records may need approval (GET /v1/approvals). */
                            approvals: boolean;
                        };
                        /** @description What a record's attachment may be, as the upload route enforces it; null when the subject takes no attachments. */
                        attachmentLimits: {
                            /**
                             * @description The largest file, in bytes (ATTACHMENT_MAX_MB × 1024²): larger is a 413 `payload_too_large`.
                             * @example 26214400
                             */
                            maxBytes: number;
                            /**
                             * @description The same, in MB (ATTACHMENT_MAX_MB).
                             * @example 25
                             */
                            maxMb: number;
                            /**
                             * @description The types a file may be (ATTACHMENT_ALLOWED_TYPES), recognized from its bytes: another is a 415 `unsupported_media_type`.
                             * @example [
                             *       "image/png",
                             *       "application/pdf",
                             *       "text/plain"
                             *     ]
                             */
                            types: string[];
                        } | null;
                    };
                };
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description You may not read the subject. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No list of that subject (not_found). */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    PeopleController_list_v1: {
        parameters: {
            query?: {
                /** @description Part of the name, any case (`%` and `_` are themselves). Absent: the first by name. */
                q?: string;
                limit?: number;
                lang?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /**
                             * @description The principal key, `user:<id>`: mention them with `@user:<id>`; the key comments (`author`) and revisions (`changedBy`) hold.
                             * @example user:0198c2a4-6f1e-7c3a-9d2b-5e8f1a2b3c4d
                             */
                            key: string;
                            /** @example Maya Patel */
                            name: string;
                        }[];
                    };
                };
            };
            /** @description `q` empty or longer than 100 characters, `limit` over 20. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No valid session or user token. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Your session acts in no tenant (tenant_required). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    AttachmentsController_download_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description To the file (a signed link). */
            302: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    AttachmentsController_remove_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not yours, and you may not change its record. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description An issued document (attachment_locked): it stays with its record. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    DocumentsController_status_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        /**
                         * @description What kind of document.
                         * @example note
                         */
                        source: string;
                        /** @example Note */
                        subject: string;
                        /** Format: uuid */
                        recordId: string;
                        /**
                         * @description The language it is written in.
                         * @example en
                         */
                        locale: string;
                        /**
                         * @description queued → rendering → completed, or failed (then `error`).
                         * @enum {string}
                         */
                        status: "queued" | "rendering" | "completed" | "failed";
                        /**
                         * Format: uuid
                         * @description Once completed: the PDF, an attachment of the record (GET /v1/attachments/{id}/download).
                         */
                        attachmentId: string | null;
                        /** @description Why it failed, written for people. */
                        error: string | null;
                        /** Format: date-time */
                        issuedAt: string | null;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: date-time */
                        updatedAt: string;
                    };
                };
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    TagsController_list_v1: {
        parameters: {
            query?: {
                limit?: number;
                /** @description `nextCursor` of the previous page (the same `sort`). */
                cursor?: string;
                /** @description Pages by number instead of cursor: 1 for the first, `limit` rows a page. Example: `page=3&limit=20&count=true`. */
                page?: number;
                /** @description true: add `total` (counted up to a cap; `totalCapped`). */
                count?: "true" | "false";
                lang?: string;
                /** @description Filter: subject = */
                subject?: string;
                /** @description Filter: subject in */
                "subject.in"?: string;
                /** @description Filter: name = */
                name?: string;
                /** @description Filter: name contains */
                "name.contains"?: string;
                /** @description Filter: name startsWith */
                "name.startsWith"?: string;
                /** @description Filter: createdAt gt */
                "createdAt.gt"?: string;
                /** @description Filter: createdAt gte */
                "createdAt.gte"?: string;
                /** @description Filter: createdAt lt */
                "createdAt.lt"?: string;
                /** @description Filter: createdAt lte */
                "createdAt.lte"?: string;
                /** @description Filter: createdAt between */
                "createdAt.between"?: string;
                /** @description Filter: updatedAt gt */
                "updatedAt.gt"?: string;
                /** @description Filter: updatedAt gte */
                "updatedAt.gte"?: string;
                /** @description Filter: updatedAt lt */
                "updatedAt.lt"?: string;
                /** @description Filter: updatedAt lte */
                "updatedAt.lte"?: string;
                /** @description Filter: updatedAt between */
                "updatedAt.between"?: string;
                /** @description Conditions in and/or groups, JSON: a condition { field, op, value } or a group { "and": [...] } / { "or": [...] }, 3 groups deep and 30 conditions at most. Example: {"or":[{"field":"subject","op":"eq","value":…},{…}]}. Fields and operators: subject (eq, in); name (eq, contains, startsWith); createdAt (gt, gte, lt, lte, between); updatedAt (gt, gte, lt, lte, between). */
                filter?: string;
                /** @description The order: fields comma-separated, - for descending; the newest first on ties. Example: -name. Sortable: name, createdAt, updatedAt. */
                sort?: string;
                /** @description Only these fields in each item, comma-separated; id always comes. Example: subject,name. Fields: id, subject, name, color, description, createdAt, updatedAt. */
                fields?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            id: string;
                            /**
                             * @description What it tags: a permission subject, `Note`.
                             * @example Note
                             */
                            subject: string;
                            /** @example Urgent */
                            name: string;
                            /** @description `#rrggbb`. */
                            color: string | null;
                            description: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: date-time */
                            updatedAt: string;
                        }[];
                        /** @description Pass it as `cursor` for the next page; null: no more (and with `page`). */
                        nextCursor: string | null;
                        /** @description With `page`: this page. */
                        page?: number;
                        /** @description With `page`: the next page; null: no more. */
                        nextPage?: number | null;
                        /** @description With `page` and `count=true`: ceil(total / limit). */
                        pageCount?: number;
                        /** @description With `count=true`: the rows matching the filters, all pages; the cap when totalCapped. */
                        total?: number;
                        /** @description true: there are more than `total` (show "10,000+"). */
                        totalCapped?: boolean;
                    };
                };
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    TagsController_create_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * @description A subject whose records take tags: `Note`.
                     * @example Note
                     */
                    subject: string;
                    /** @example Urgent */
                    name: string;
                    /** @example #3b82f6 */
                    color?: string;
                    description?: string;
                };
            };
        };
        responses: {
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        /**
                         * @description What it tags: a permission subject, `Note`.
                         * @example Note
                         */
                        subject: string;
                        /** @example Urgent */
                        name: string;
                        /** @description `#rrggbb`. */
                        color: string | null;
                        description: string | null;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: date-time */
                        updatedAt: string;
                    };
                };
            };
            /** @description A subject that takes no tags, a colour that is not #rrggbb, a name too long (validation_failed). */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The subject has a tag of this name. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    TagsController_remove_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    TagsController_update_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @example Urgent */
                    name?: string;
                    /** @example #3b82f6 */
                    color?: string | null;
                    description?: string | null;
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        /**
                         * @description What it tags: a permission subject, `Note`.
                         * @example Note
                         */
                        subject: string;
                        /** @example Urgent */
                        name: string;
                        /** @description `#rrggbb`. */
                        color: string | null;
                        description: string | null;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: date-time */
                        updatedAt: string;
                    };
                };
            };
            /** @description An invalid body (validation_failed). */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The subject has a tag of this name. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    ReportsController_list_v1: {
        parameters: {
            query?: {
                limit?: number;
                /** @description `nextCursor` of the previous page (the same `sort`). */
                cursor?: string;
                /** @description Pages by number instead of cursor: 1 for the first, `limit` rows a page. Example: `page=3&limit=20&count=true`. */
                page?: number;
                /** @description true: add `total` (counted up to a cap; `totalCapped`). */
                count?: "true" | "false";
                lang?: string;
                /** @description Filter: exporter = */
                exporter?: string;
                /** @description Filter: exporter in */
                "exporter.in"?: string;
                /** @description Filter: active = */
                active?: "true" | "false";
                /** @description Filter: name = */
                name?: string;
                /** @description Filter: name contains */
                "name.contains"?: string;
                /** @description Filter: nextRunAt gte */
                "nextRunAt.gte"?: string;
                /** @description Filter: nextRunAt lt */
                "nextRunAt.lt"?: string;
                /** @description Filter: nextRunAt between */
                "nextRunAt.between"?: string;
                /** @description Filter: createdAt gt */
                "createdAt.gt"?: string;
                /** @description Filter: createdAt gte */
                "createdAt.gte"?: string;
                /** @description Filter: createdAt lt */
                "createdAt.lt"?: string;
                /** @description Filter: createdAt lte */
                "createdAt.lte"?: string;
                /** @description Filter: createdAt between */
                "createdAt.between"?: string;
                /** @description Filter: updatedAt gt */
                "updatedAt.gt"?: string;
                /** @description Filter: updatedAt gte */
                "updatedAt.gte"?: string;
                /** @description Filter: updatedAt lt */
                "updatedAt.lt"?: string;
                /** @description Filter: updatedAt lte */
                "updatedAt.lte"?: string;
                /** @description Filter: updatedAt between */
                "updatedAt.between"?: string;
                /** @description Conditions in and/or groups, JSON: a condition { field, op, value } or a group { "and": [...] } / { "or": [...] }, 3 groups deep and 30 conditions at most. Example: {"or":[{"field":"exporter","op":"eq","value":…},{…}]}. Fields and operators: exporter (eq, in); active (eq); name (eq, contains); nextRunAt (gte, lt, between); createdAt (gt, gte, lt, lte, between); updatedAt (gt, gte, lt, lte, between). */
                filter?: string;
                /** @description The order: fields comma-separated, - for descending; the newest first on ties. Example: -name. Sortable: name, nextRunAt, createdAt, updatedAt. */
                sort?: string;
                /** @description Only these fields in each item, comma-separated; id always comes. Example: name,exporter. Fields: id, name, exporter, format, filters, timezone, schedule, recipients, active, lastRunAt, lastStatus, lastTransferId, nextRunAt, createdAt, updatedAt. */
                fields?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            id: string;
                            /** @example Weekly drafts */
                            name: string;
                            /** @example notes */
                            exporter: string;
                            /** @enum {string} */
                            format: "csv" | "json" | "xlsx";
                            filters: {
                                [key: string]: string;
                            };
                            /** @example Asia/Manila */
                            timezone: string;
                            /**
                             * @example {
                             *       "every": "weekly",
                             *       "weekday": 1,
                             *       "hour": 8
                             *     }
                             */
                            schedule: {
                                /** @enum {string} */
                                every: "daily";
                                /** @description 0-23, in `timezone`. */
                                hour: number;
                            } | {
                                /** @enum {string} */
                                every: "weekly";
                                /** @description 0 Sunday … 6 Saturday. */
                                weekday: number;
                                /** @description 0-23, in `timezone`. */
                                hour: number;
                            } | {
                                /** @enum {string} */
                                every: "monthly";
                                /** @description 1-28: every month has it. */
                                day: number;
                                /** @description 0-23, in `timezone`. */
                                hour: number;
                            };
                            recipients: string[];
                            active: boolean;
                            /** Format: date-time */
                            lastRunAt: string | null;
                            /** @enum {string|null} */
                            lastStatus: "completed" | "failed" | null;
                            /** @description The last run: `GET /v1/data/transfers/{id}`. */
                            lastTransferId: string | null;
                            /** Format: date-time */
                            nextRunAt: string;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: date-time */
                            updatedAt: string;
                        }[];
                        /** @description Pass it as `cursor` for the next page; null: no more (and with `page`). */
                        nextCursor: string | null;
                        /** @description With `page`: this page. */
                        page?: number;
                        /** @description With `page`: the next page; null: no more. */
                        nextPage?: number | null;
                        /** @description With `page` and `count=true`: ceil(total / limit). */
                        pageCount?: number;
                        /** @description With `count=true`: the rows matching the filters, all pages; the cap when totalCapped. */
                        total?: number;
                        /** @description true: there are more than `total` (show "10,000+"). */
                        totalCapped?: boolean;
                    };
                };
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    ReportsController_create_v1: {
        parameters: {
            query?: never;
            header?: {
                /**
                 * @description A unique key per operation (a UUID), 1 to 255 printable ASCII characters. Send the same key on every retry of the same request: it runs once, and retries get its response (with Idempotent-Replayed: true). Kept for 24 hours.
                 *
                 *     In Swagger UI, leave `generate` to send a new key on every Execute, or type your own key and Execute twice to see a retry replayed.
                 */
                "Idempotency-Key"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @example Weekly drafts */
                    name: string;
                    /**
                     * @description An export you may run (`GET /v1/data`).
                     * @example notes
                     */
                    exporter: string;
                    /**
                     * @default csv
                     * @enum {string}
                     */
                    format?: "csv" | "json" | "xlsx";
                    /**
                     * @description The list filters of that data, as on its list route: { "status": "draft" }.
                     * @default {}
                     */
                    filters?: {
                        [key: string]: string;
                    };
                    /**
                     * @description The schedule's hours and the file's dates. Default: your own time zone, else the server's (APP_TIMEZONE).
                     * @example Europe/Berlin
                     */
                    timezone?: string;
                    /**
                     * @example {
                     *       "every": "weekly",
                     *       "weekday": 1,
                     *       "hour": 8
                     *     }
                     */
                    schedule: {
                        /** @enum {string} */
                        every: "daily";
                        /** @description 0-23, in `timezone`. */
                        hour: number;
                    } | {
                        /** @enum {string} */
                        every: "weekly";
                        /** @description 0 Sunday … 6 Saturday. */
                        weekday: number;
                        /** @description 0-23, in `timezone`. */
                        hour: number;
                    } | {
                        /** @enum {string} */
                        every: "monthly";
                        /** @description 1-28: every month has it. */
                        day: number;
                        /** @description 0-23, in `timezone`. */
                        hour: number;
                    };
                    /** @description Up to 20 addresses. Default for a user: their own; required for an API client. */
                    recipients?: string[];
                    /** @default true */
                    active?: boolean;
                };
            };
        };
        responses: {
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        /** @example Weekly drafts */
                        name: string;
                        /** @example notes */
                        exporter: string;
                        /** @enum {string} */
                        format: "csv" | "json" | "xlsx";
                        filters: {
                            [key: string]: string;
                        };
                        /** @example Asia/Manila */
                        timezone: string;
                        /**
                         * @example {
                         *       "every": "weekly",
                         *       "weekday": 1,
                         *       "hour": 8
                         *     }
                         */
                        schedule: {
                            /** @enum {string} */
                            every: "daily";
                            /** @description 0-23, in `timezone`. */
                            hour: number;
                        } | {
                            /** @enum {string} */
                            every: "weekly";
                            /** @description 0 Sunday … 6 Saturday. */
                            weekday: number;
                            /** @description 0-23, in `timezone`. */
                            hour: number;
                        } | {
                            /** @enum {string} */
                            every: "monthly";
                            /** @description 1-28: every month has it. */
                            day: number;
                            /** @description 0-23, in `timezone`. */
                            hour: number;
                        };
                        recipients: string[];
                        active: boolean;
                        /** Format: date-time */
                        lastRunAt: string | null;
                        /** @enum {string|null} */
                        lastStatus: "completed" | "failed" | null;
                        /** @description The last run: `GET /v1/data/transfers/{id}`. */
                        lastTransferId: string | null;
                        /** Format: date-time */
                        nextRunAt: string;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: date-time */
                        updatedAt: string;
                    };
                };
            };
            /** @description An export you may not run (`exporter`), filters it refuses (`filters.<field>`), an unknown time zone, a schedule out of range, more than 20 recipients (validation_failed). */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Its filters use a field your permissions hide (field_forbidden, naming it). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    ReportsController_get_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        /** @example Weekly drafts */
                        name: string;
                        /** @example notes */
                        exporter: string;
                        /** @enum {string} */
                        format: "csv" | "json" | "xlsx";
                        filters: {
                            [key: string]: string;
                        };
                        /** @example Asia/Manila */
                        timezone: string;
                        /**
                         * @example {
                         *       "every": "weekly",
                         *       "weekday": 1,
                         *       "hour": 8
                         *     }
                         */
                        schedule: {
                            /** @enum {string} */
                            every: "daily";
                            /** @description 0-23, in `timezone`. */
                            hour: number;
                        } | {
                            /** @enum {string} */
                            every: "weekly";
                            /** @description 0 Sunday … 6 Saturday. */
                            weekday: number;
                            /** @description 0-23, in `timezone`. */
                            hour: number;
                        } | {
                            /** @enum {string} */
                            every: "monthly";
                            /** @description 1-28: every month has it. */
                            day: number;
                            /** @description 0-23, in `timezone`. */
                            hour: number;
                        };
                        recipients: string[];
                        active: boolean;
                        /** Format: date-time */
                        lastRunAt: string | null;
                        /** @enum {string|null} */
                        lastStatus: "completed" | "failed" | null;
                        /** @description The last run: `GET /v1/data/transfers/{id}`. */
                        lastTransferId: string | null;
                        /** Format: date-time */
                        nextRunAt: string;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: date-time */
                        updatedAt: string;
                    };
                };
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    ReportsController_remove_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    ReportsController_update_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @example Weekly drafts */
                    name?: string;
                    /**
                     * @description An export you may run (`GET /v1/data`).
                     * @example notes
                     */
                    exporter?: string;
                    /** @enum {string} */
                    format?: "csv" | "json" | "xlsx";
                    filters?: {
                        [key: string]: string;
                    };
                    /** @example Europe/Berlin */
                    timezone?: string;
                    /**
                     * @example {
                     *       "every": "weekly",
                     *       "weekday": 1,
                     *       "hour": 8
                     *     }
                     */
                    schedule?: {
                        /** @enum {string} */
                        every: "daily";
                        /** @description 0-23, in `timezone`. */
                        hour: number;
                    } | {
                        /** @enum {string} */
                        every: "weekly";
                        /** @description 0 Sunday … 6 Saturday. */
                        weekday: number;
                        /** @description 0-23, in `timezone`. */
                        hour: number;
                    } | {
                        /** @enum {string} */
                        every: "monthly";
                        /** @description 1-28: every month has it. */
                        day: number;
                        /** @description 0-23, in `timezone`. */
                        hour: number;
                    };
                    /** @description Up to 20 addresses. */
                    recipients?: string[];
                    active?: boolean;
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        /** @example Weekly drafts */
                        name: string;
                        /** @example notes */
                        exporter: string;
                        /** @enum {string} */
                        format: "csv" | "json" | "xlsx";
                        filters: {
                            [key: string]: string;
                        };
                        /** @example Asia/Manila */
                        timezone: string;
                        /**
                         * @example {
                         *       "every": "weekly",
                         *       "weekday": 1,
                         *       "hour": 8
                         *     }
                         */
                        schedule: {
                            /** @enum {string} */
                            every: "daily";
                            /** @description 0-23, in `timezone`. */
                            hour: number;
                        } | {
                            /** @enum {string} */
                            every: "weekly";
                            /** @description 0 Sunday … 6 Saturday. */
                            weekday: number;
                            /** @description 0-23, in `timezone`. */
                            hour: number;
                        } | {
                            /** @enum {string} */
                            every: "monthly";
                            /** @description 1-28: every month has it. */
                            day: number;
                            /** @description 0-23, in `timezone`. */
                            hour: number;
                        };
                        recipients: string[];
                        active: boolean;
                        /** Format: date-time */
                        lastRunAt: string | null;
                        /** @enum {string|null} */
                        lastStatus: "completed" | "failed" | null;
                        /** @description The last run: `GET /v1/data/transfers/{id}`. */
                        lastTransferId: string | null;
                        /** Format: date-time */
                        nextRunAt: string;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: date-time */
                        updatedAt: string;
                    };
                };
            };
            /** @description An export you may not run (`exporter`), filters it refuses (`filters.<field>`), an unknown time zone, a schedule out of range, more than 20 recipients (validation_failed). */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Its filters use a field your permissions hide (field_forbidden, naming it). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    ReportsController_run_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description The transfer: `GET /v1/data/transfers/{id}`. */
                        id: string;
                        /** @enum {string} */
                        status: "queued";
                    };
                };
            };
            /** @description You may no longer run its export (validation_failed). */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Its filters use a field your permissions hide (field_forbidden, naming it). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    UsageController_clientUsage_v1: {
        parameters: {
            query?: {
                /** @description The first UTC day (yyyy-mm-dd), included; default: 29 days before `to`. */
                from?: string;
                /** @description The last UTC day, included; default: today. */
                to?: string;
            };
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: date */
                        from: string;
                        /** Format: date */
                        to: string;
                        /** @description Every day of the range, oldest first, today with its live count. */
                        days: {
                            /** Format: date */
                            day: string;
                            total: number;
                            /** @description Requests per route: `<METHOD> <pattern>`, as `GET /v1/notes/{id}`. */
                            routes: {
                                [key: string]: number;
                            };
                        }[];
                        total: number;
                    };
                };
            };
            /** @description A range that ends before it starts, or is longer than 400 days. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description feature_off: API_CLIENTS=off in this deployment. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    UsageController_ownUsage_v1: {
        parameters: {
            query?: {
                /** @description The first UTC day (yyyy-mm-dd), included; default: 29 days before `to`. */
                from?: string;
                /** @description The last UTC day, included; default: today. */
                to?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: date */
                        from: string;
                        /** Format: date */
                        to: string;
                        /** @description Every day of the range, oldest first, today with its live count. */
                        days: {
                            /** Format: date */
                            day: string;
                            total: number;
                            /** @description Requests per route: `<METHOD> <pattern>`, as `GET /v1/notes/{id}`. */
                            routes: {
                                [key: string]: number;
                            };
                        }[];
                        total: number;
                    };
                };
            };
            /** @description A range that ends before it starts, or is longer than 400 days. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Only API clients have usage: a user gets a 403. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    MailEventsController_handle_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                provider: string;
            };
            cookie?: never;
        };
        /** @description The provider’s notification, as it sends it. */
        requestBody: {
            content: {
                "application/json": string;
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {boolean} */
                        received: true;
                        /** @enum {string} */
                        kind: "events" | "handshake" | "ignored";
                        events: number;
                    };
                };
            };
            /** @description Not the provider’s format (sns_malformed). */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The signature does not verify (sns_signature_invalid), or the certificate or subscribe URL is not an SNS host (sns_certificate_refused, sns_subscribe_url_refused). */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The topic is not in SES_SNS_TOPIC_ARNS (sns_topic_not_allowed). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No such provider. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The signing certificate could not be fetched (sns_certificate_unavailable): the provider retries. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    SuppressionsController_list_v1: {
        parameters: {
            query?: {
                limit?: number;
                /** @description `nextCursor` of the previous page (the same `sort`). */
                cursor?: string;
                /** @description Pages by number instead of cursor: 1 for the first, `limit` rows a page. Example: `page=3&limit=20&count=true`. */
                page?: number;
                /** @description true: add `total` (counted up to a cap; `totalCapped`). */
                count?: "true" | "false";
                lang?: string;
                /** @description Filter: address = */
                address?: string;
                /** @description Filter: address contains */
                "address.contains"?: string;
                /** @description Filter: address endsWith */
                "address.endsWith"?: string;
                /** @description Filter: reason = */
                reason?: "hard_bounce" | "soft_bounce" | "complaint" | "manual";
                /** @description Filter: reason in */
                "reason.in"?: string;
                /** @description Filter: reason notIn */
                "reason.notIn"?: string;
                /** @description Filter: source = */
                source?: string;
                /** @description Filter: source in */
                "source.in"?: string;
                /** @description Filter: suppressedAt gte */
                "suppressedAt.gte"?: string;
                /** @description Filter: suppressedAt lt */
                "suppressedAt.lt"?: string;
                /** @description Filter: suppressedAt between */
                "suppressedAt.between"?: string;
                /** @description Filter: suppressedAt isNull */
                "suppressedAt.isNull"?: "true" | "false";
                /** @description Filter: lastSeenAt gte */
                "lastSeenAt.gte"?: string;
                /** @description Filter: lastSeenAt lt */
                "lastSeenAt.lt"?: string;
                /** @description Filter: lastSeenAt between */
                "lastSeenAt.between"?: string;
                /** @description Filter: createdAt gt */
                "createdAt.gt"?: string;
                /** @description Filter: createdAt gte */
                "createdAt.gte"?: string;
                /** @description Filter: createdAt lt */
                "createdAt.lt"?: string;
                /** @description Filter: createdAt lte */
                "createdAt.lte"?: string;
                /** @description Filter: createdAt between */
                "createdAt.between"?: string;
                /** @description Filter: updatedAt gt */
                "updatedAt.gt"?: string;
                /** @description Filter: updatedAt gte */
                "updatedAt.gte"?: string;
                /** @description Filter: updatedAt lt */
                "updatedAt.lt"?: string;
                /** @description Filter: updatedAt lte */
                "updatedAt.lte"?: string;
                /** @description Filter: updatedAt between */
                "updatedAt.between"?: string;
                /** @description Conditions in and/or groups, JSON: a condition { field, op, value } or a group { "and": [...] } / { "or": [...] }, 3 groups deep and 30 conditions at most. Example: {"or":[{"field":"address","op":"eq","value":…},{…}]}. Fields and operators: address (eq, contains, endsWith); reason (eq, in, notIn); source (eq, in); suppressedAt (gte, lt, between, isNull); lastSeenAt (gte, lt, between); createdAt (gt, gte, lt, lte, between); updatedAt (gt, gte, lt, lte, between). */
                filter?: string;
                /** @description The order: fields comma-separated, - for descending; the newest first on ties. Example: -address. Sortable: address, suppressedAt, lastSeenAt, createdAt, updatedAt. */
                sort?: string;
                /** @description Only these fields in each item, comma-separated; id always comes. Example: address,reason. Fields: id, address, reason, source, note, lastDetail, events, softBounces, firstSeenAt, lastSeenAt, suppressedAt, skipped, lastSkippedAt, createdBy, createdAt, updatedAt. */
                fields?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            id: string;
                            /** @example ada@example.com */
                            address: string;
                            /**
                             * @description `hard_bounce` (no such mailbox), `soft_bounce` (refused MAIL_SOFT_BOUNCE_THRESHOLD times in a row), `complaint` (reported as spam), `manual`.
                             * @enum {string}
                             */
                            reason: "hard_bounce" | "soft_bounce" | "complaint" | "manual";
                            /** @description The provider that reported it (`ses`), or `manual`. */
                            source: string;
                            note: string | null;
                            /** @description The provider’s last word: a bounce sub-type, a diagnostic code. */
                            lastDetail: string | null;
                            /** @description Bounces and complaints reported for it. */
                            events: number;
                            /** @description Transient bounces in a row. */
                            softBounces: number;
                            /** Format: date-time */
                            firstSeenAt: string;
                            /** Format: date-time */
                            lastSeenAt: string;
                            /**
                             * Format: date-time
                             * @description Null: only watched (soft bounces under the threshold); set: mail is not sent to it.
                             */
                            suppressedAt: string | null;
                            /** @description Mails not sent to it since. */
                            skipped: number;
                            /** Format: date-time */
                            lastSkippedAt: string | null;
                            createdBy: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: date-time */
                            updatedAt: string;
                        }[];
                        /** @description Pass it as `cursor` for the next page; null: no more (and with `page`). */
                        nextCursor: string | null;
                        /** @description With `page`: this page. */
                        page?: number;
                        /** @description With `page`: the next page; null: no more. */
                        nextPage?: number | null;
                        /** @description With `page` and `count=true`: ceil(total / limit). */
                        pageCount?: number;
                        /** @description With `count=true`: the rows matching the filters, all pages; the cap when totalCapped. */
                        total?: number;
                        /** @description true: there are more than `total` (show "10,000+"). */
                        totalCapped?: boolean;
                    };
                };
            };
            /** @description No valid session or token. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /**
             * @description operator_required: the caller does not act in the operator tenant.
             *
             *     Not allowed by your permissions.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    SuppressionsController_create_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * Format: email
                     * @example ada@example.com
                     */
                    address: string;
                    note?: string;
                };
            };
        };
        responses: {
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        /** @example ada@example.com */
                        address: string;
                        /**
                         * @description `hard_bounce` (no such mailbox), `soft_bounce` (refused MAIL_SOFT_BOUNCE_THRESHOLD times in a row), `complaint` (reported as spam), `manual`.
                         * @enum {string}
                         */
                        reason: "hard_bounce" | "soft_bounce" | "complaint" | "manual";
                        /** @description The provider that reported it (`ses`), or `manual`. */
                        source: string;
                        note: string | null;
                        /** @description The provider’s last word: a bounce sub-type, a diagnostic code. */
                        lastDetail: string | null;
                        /** @description Bounces and complaints reported for it. */
                        events: number;
                        /** @description Transient bounces in a row. */
                        softBounces: number;
                        /** Format: date-time */
                        firstSeenAt: string;
                        /** Format: date-time */
                        lastSeenAt: string;
                        /**
                         * Format: date-time
                         * @description Null: only watched (soft bounces under the threshold); set: mail is not sent to it.
                         */
                        suppressedAt: string | null;
                        /** @description Mails not sent to it since. */
                        skipped: number;
                        /** Format: date-time */
                        lastSkippedAt: string | null;
                        createdBy: string | null;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: date-time */
                        updatedAt: string;
                    };
                };
            };
            /** @description Not an email address. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No valid session or token. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /**
             * @description operator_required: the caller does not act in the operator tenant.
             *
             *     Not allowed by your permissions.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The address is listed already. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    SuppressionsController_findOne_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        /** @example ada@example.com */
                        address: string;
                        /**
                         * @description `hard_bounce` (no such mailbox), `soft_bounce` (refused MAIL_SOFT_BOUNCE_THRESHOLD times in a row), `complaint` (reported as spam), `manual`.
                         * @enum {string}
                         */
                        reason: "hard_bounce" | "soft_bounce" | "complaint" | "manual";
                        /** @description The provider that reported it (`ses`), or `manual`. */
                        source: string;
                        note: string | null;
                        /** @description The provider’s last word: a bounce sub-type, a diagnostic code. */
                        lastDetail: string | null;
                        /** @description Bounces and complaints reported for it. */
                        events: number;
                        /** @description Transient bounces in a row. */
                        softBounces: number;
                        /** Format: date-time */
                        firstSeenAt: string;
                        /** Format: date-time */
                        lastSeenAt: string;
                        /**
                         * Format: date-time
                         * @description Null: only watched (soft bounces under the threshold); set: mail is not sent to it.
                         */
                        suppressedAt: string | null;
                        /** @description Mails not sent to it since. */
                        skipped: number;
                        /** Format: date-time */
                        lastSkippedAt: string | null;
                        createdBy: string | null;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: date-time */
                        updatedAt: string;
                    };
                };
            };
            /** @description No valid session or token. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /**
             * @description operator_required: the caller does not act in the operator tenant.
             *
             *     Not allowed by your permissions.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    SuppressionsController_remove_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No valid session or token. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /**
             * @description operator_required: the caller does not act in the operator tenant.
             *
             *     Not allowed by your permissions.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    ApprovalDelegationsController_list_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** Format: uuid */
                            id: string;
                            /** Format: uuid */
                            fromUserId: string;
                            fromName: string;
                            /** Format: uuid */
                            toUserId: string;
                            toName: string;
                            /** Format: date-time */
                            startsAt: string;
                            /** Format: date-time */
                            endsAt: string;
                            subject: string | null;
                            /** @description Whether it applies now. */
                            active: boolean;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: date-time */
                            updatedAt: string;
                        }[];
                    };
                };
            };
            /** @description No valid session or user token. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    ApprovalDelegationsController_create_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    toUserId: string;
                    /** Format: date-time */
                    startsAt: string;
                    /** Format: date-time */
                    endsAt: string;
                    /** @description Only requests of this subject (`Note`); all when left out. */
                    subject?: string;
                };
            };
        };
        responses: {
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        /** Format: uuid */
                        fromUserId: string;
                        fromName: string;
                        /** Format: uuid */
                        toUserId: string;
                        toName: string;
                        /** Format: date-time */
                        startsAt: string;
                        /** Format: date-time */
                        endsAt: string;
                        subject: string | null;
                        /** @description Whether it applies now. */
                        active: boolean;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: date-time */
                        updatedAt: string;
                    };
                };
            };
            /** @description Yourself, an unknown or inactive user, or a period that ends before it starts (validation_failed). */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No valid session or user token. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    ApprovalDelegationsController_remove_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No valid session or user token. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not a delegation you gave. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    ApprovalPoliciesController_types_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        approverRules: {
                            type: string;
                            label: string;
                            /** @description The JSON Schema of its parameters. */
                            params: {
                                [key: string]: unknown;
                            };
                        }[];
                        modes: {
                            type: string;
                            label: string;
                            /** @description The JSON Schema of its parameters. */
                            params: {
                                [key: string]: unknown;
                            };
                        }[];
                        conditions: {
                            type: string;
                            label: string;
                            /** @description The JSON Schema of its parameters. */
                            params: {
                                [key: string]: unknown;
                            };
                        }[];
                    };
                };
            };
            /** @description No valid session or user token. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Changing approval policies needs Approval.managePolicies. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    ApprovalPoliciesController_list_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            key: string;
                            subject: string;
                            action: string;
                            label: string;
                            description: string | null;
                            /** @description 0: the code default, never changed. */
                            version: number;
                            /** @enum {string} */
                            source: "code" | "override";
                            policy: {
                                /** @default true */
                                enabled: boolean;
                                /** @description Approval is needed only when this condition holds: `{ "type": "payload", "path": "amount", "op": "gt", "value": 1000 }`, `all`/`any`/`not` of others, or a registered condition. */
                                when?: ({
                                    type: string;
                                } & {
                                    [key: string]: unknown;
                                }) | null;
                                stages: {
                                    /** @example Editor review */
                                    name: string;
                                    /** @description Approver rules (GET /v1/approvals/policy-types): every user any of them names is assigned when the stage starts. */
                                    approvers: ({
                                        type: string;
                                    } & {
                                        [key: string]: unknown;
                                    })[];
                                    /**
                                     * @description How the stage completes: `{ "type": "any" }` (the first decision), `{ "type": "all" }`, `{ "type": "quorum", "n": 2 }`, or a registered mode.
                                     * @default {
                                     *       "type": "any"
                                     *     }
                                     */
                                    mode: {
                                        type: string;
                                    } & {
                                        [key: string]: unknown;
                                    };
                                    /**
                                     * @description Remind the approvers who have not decided after this long.
                                     * @example 2d
                                     */
                                    remindAfter?: string;
                                    /**
                                     * @description The stage is overdue after this long: then `onOverdue`.
                                     * @example 2d
                                     */
                                    dueAfter?: string;
                                    /**
                                     * @description expire: the request expires; escalate: the `escalateTo` approvers are added.
                                     * @default expire
                                     * @enum {string}
                                     */
                                    onOverdue: "expire" | "escalate";
                                    /** @description With `onOverdue: escalate`: the approvers added. */
                                    escalateTo?: ({
                                        type: string;
                                    } & {
                                        [key: string]: unknown;
                                    })[];
                                    /**
                                     * @description After an escalation, the request expires after this long.
                                     * @example 2d
                                     */
                                    escalationDueAfter?: string;
                                }[];
                                /**
                                 * @default 30d
                                 * @example 2d
                                 */
                                resubmitWithin: string;
                            };
                            /** @description The code's default policy. */
                            default: {
                                /** @default true */
                                enabled: boolean;
                                /** @description Approval is needed only when this condition holds: `{ "type": "payload", "path": "amount", "op": "gt", "value": 1000 }`, `all`/`any`/`not` of others, or a registered condition. */
                                when?: ({
                                    type: string;
                                } & {
                                    [key: string]: unknown;
                                }) | null;
                                stages: {
                                    /** @example Editor review */
                                    name: string;
                                    /** @description Approver rules (GET /v1/approvals/policy-types): every user any of them names is assigned when the stage starts. */
                                    approvers: ({
                                        type: string;
                                    } & {
                                        [key: string]: unknown;
                                    })[];
                                    /**
                                     * @description How the stage completes: `{ "type": "any" }` (the first decision), `{ "type": "all" }`, `{ "type": "quorum", "n": 2 }`, or a registered mode.
                                     * @default {
                                     *       "type": "any"
                                     *     }
                                     */
                                    mode: {
                                        type: string;
                                    } & {
                                        [key: string]: unknown;
                                    };
                                    /**
                                     * @description Remind the approvers who have not decided after this long.
                                     * @example 2d
                                     */
                                    remindAfter?: string;
                                    /**
                                     * @description The stage is overdue after this long: then `onOverdue`.
                                     * @example 2d
                                     */
                                    dueAfter?: string;
                                    /**
                                     * @description expire: the request expires; escalate: the `escalateTo` approvers are added.
                                     * @default expire
                                     * @enum {string}
                                     */
                                    onOverdue: "expire" | "escalate";
                                    /** @description With `onOverdue: escalate`: the approvers added. */
                                    escalateTo?: ({
                                        type: string;
                                    } & {
                                        [key: string]: unknown;
                                    })[];
                                    /**
                                     * @description After an escalation, the request expires after this long.
                                     * @example 2d
                                     */
                                    escalationDueAfter?: string;
                                }[];
                                /**
                                 * @default 30d
                                 * @example 2d
                                 */
                                resubmitWithin: string;
                            };
                            /** @description The setting that switches approval on (GET /v1/settings). */
                            setting: string | null;
                            /** @description The JSON Schema of the requests' payload. */
                            payloadSchema: {
                                [key: string]: unknown;
                            };
                        }[];
                    };
                };
            };
            /** @description No valid session or user token. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Changing approval policies needs Approval.managePolicies. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    ApprovalPoliciesController_get_v1: {
        parameters: {
            query?: never;
            header?: {
                /** @description The ETag you have: 304 and no body when it is still current. */
                "If-None-Match"?: string;
            };
            path: {
                key: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        key: string;
                        subject: string;
                        action: string;
                        label: string;
                        description: string | null;
                        /** @description 0: the code default, never changed. */
                        version: number;
                        /** @enum {string} */
                        source: "code" | "override";
                        policy: {
                            /** @default true */
                            enabled: boolean;
                            /** @description Approval is needed only when this condition holds: `{ "type": "payload", "path": "amount", "op": "gt", "value": 1000 }`, `all`/`any`/`not` of others, or a registered condition. */
                            when?: ({
                                type: string;
                            } & {
                                [key: string]: unknown;
                            }) | null;
                            stages: {
                                /** @example Editor review */
                                name: string;
                                /** @description Approver rules (GET /v1/approvals/policy-types): every user any of them names is assigned when the stage starts. */
                                approvers: ({
                                    type: string;
                                } & {
                                    [key: string]: unknown;
                                })[];
                                /**
                                 * @description How the stage completes: `{ "type": "any" }` (the first decision), `{ "type": "all" }`, `{ "type": "quorum", "n": 2 }`, or a registered mode.
                                 * @default {
                                 *       "type": "any"
                                 *     }
                                 */
                                mode: {
                                    type: string;
                                } & {
                                    [key: string]: unknown;
                                };
                                /**
                                 * @description Remind the approvers who have not decided after this long.
                                 * @example 2d
                                 */
                                remindAfter?: string;
                                /**
                                 * @description The stage is overdue after this long: then `onOverdue`.
                                 * @example 2d
                                 */
                                dueAfter?: string;
                                /**
                                 * @description expire: the request expires; escalate: the `escalateTo` approvers are added.
                                 * @default expire
                                 * @enum {string}
                                 */
                                onOverdue: "expire" | "escalate";
                                /** @description With `onOverdue: escalate`: the approvers added. */
                                escalateTo?: ({
                                    type: string;
                                } & {
                                    [key: string]: unknown;
                                })[];
                                /**
                                 * @description After an escalation, the request expires after this long.
                                 * @example 2d
                                 */
                                escalationDueAfter?: string;
                            }[];
                            /**
                             * @default 30d
                             * @example 2d
                             */
                            resubmitWithin: string;
                        };
                        /** @description The code's default policy. */
                        default: {
                            /** @default true */
                            enabled: boolean;
                            /** @description Approval is needed only when this condition holds: `{ "type": "payload", "path": "amount", "op": "gt", "value": 1000 }`, `all`/`any`/`not` of others, or a registered condition. */
                            when?: ({
                                type: string;
                            } & {
                                [key: string]: unknown;
                            }) | null;
                            stages: {
                                /** @example Editor review */
                                name: string;
                                /** @description Approver rules (GET /v1/approvals/policy-types): every user any of them names is assigned when the stage starts. */
                                approvers: ({
                                    type: string;
                                } & {
                                    [key: string]: unknown;
                                })[];
                                /**
                                 * @description How the stage completes: `{ "type": "any" }` (the first decision), `{ "type": "all" }`, `{ "type": "quorum", "n": 2 }`, or a registered mode.
                                 * @default {
                                 *       "type": "any"
                                 *     }
                                 */
                                mode: {
                                    type: string;
                                } & {
                                    [key: string]: unknown;
                                };
                                /**
                                 * @description Remind the approvers who have not decided after this long.
                                 * @example 2d
                                 */
                                remindAfter?: string;
                                /**
                                 * @description The stage is overdue after this long: then `onOverdue`.
                                 * @example 2d
                                 */
                                dueAfter?: string;
                                /**
                                 * @description expire: the request expires; escalate: the `escalateTo` approvers are added.
                                 * @default expire
                                 * @enum {string}
                                 */
                                onOverdue: "expire" | "escalate";
                                /** @description With `onOverdue: escalate`: the approvers added. */
                                escalateTo?: ({
                                    type: string;
                                } & {
                                    [key: string]: unknown;
                                })[];
                                /**
                                 * @description After an escalation, the request expires after this long.
                                 * @example 2d
                                 */
                                escalationDueAfter?: string;
                            }[];
                            /**
                             * @default 30d
                             * @example 2d
                             */
                            resubmitWithin: string;
                        };
                        /** @description The setting that switches approval on (GET /v1/settings). */
                        setting: string | null;
                        /** @description The JSON Schema of the requests' payload. */
                        payloadSchema: {
                            [key: string]: unknown;
                        };
                    };
                };
            };
            /** @description No valid session or user token. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Changing approval policies needs Approval.managePolicies. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No approvable action has this key. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    ApprovalPoliciesController_set_v1: {
        parameters: {
            query?: never;
            header?: {
                /** @description The ETag the record had when you read it: the write is refused with 412 if it changed since (optimistic concurrency). Leave it out to write regardless; `*` means the same. */
                "If-Match"?: string;
            };
            path: {
                key: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @default true */
                    enabled?: boolean;
                    /** @description Approval is needed only when this condition holds: `{ "type": "payload", "path": "amount", "op": "gt", "value": 1000 }`, `all`/`any`/`not` of others, or a registered condition. */
                    when?: ({
                        type: string;
                    } & {
                        [key: string]: unknown;
                    }) | null;
                    stages: {
                        /** @example Editor review */
                        name: string;
                        /** @description Approver rules (GET /v1/approvals/policy-types): every user any of them names is assigned when the stage starts. */
                        approvers: ({
                            type: string;
                        } & {
                            [key: string]: unknown;
                        })[];
                        /**
                         * @description How the stage completes: `{ "type": "any" }` (the first decision), `{ "type": "all" }`, `{ "type": "quorum", "n": 2 }`, or a registered mode.
                         * @default {
                         *       "type": "any"
                         *     }
                         */
                        mode?: {
                            type: string;
                        } & {
                            [key: string]: unknown;
                        };
                        /**
                         * @description Remind the approvers who have not decided after this long.
                         * @example 2d
                         */
                        remindAfter?: string;
                        /**
                         * @description The stage is overdue after this long: then `onOverdue`.
                         * @example 2d
                         */
                        dueAfter?: string;
                        /**
                         * @description expire: the request expires; escalate: the `escalateTo` approvers are added.
                         * @default expire
                         * @enum {string}
                         */
                        onOverdue?: "expire" | "escalate";
                        /** @description With `onOverdue: escalate`: the approvers added. */
                        escalateTo?: ({
                            type: string;
                        } & {
                            [key: string]: unknown;
                        })[];
                        /**
                         * @description After an escalation, the request expires after this long.
                         * @example 2d
                         */
                        escalationDueAfter?: string;
                    }[];
                    /**
                     * @default 30d
                     * @example 2d
                     */
                    resubmitWithin?: string;
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        key: string;
                        subject: string;
                        action: string;
                        label: string;
                        description: string | null;
                        /** @description 0: the code default, never changed. */
                        version: number;
                        /** @enum {string} */
                        source: "code" | "override";
                        policy: {
                            /** @default true */
                            enabled: boolean;
                            /** @description Approval is needed only when this condition holds: `{ "type": "payload", "path": "amount", "op": "gt", "value": 1000 }`, `all`/`any`/`not` of others, or a registered condition. */
                            when?: ({
                                type: string;
                            } & {
                                [key: string]: unknown;
                            }) | null;
                            stages: {
                                /** @example Editor review */
                                name: string;
                                /** @description Approver rules (GET /v1/approvals/policy-types): every user any of them names is assigned when the stage starts. */
                                approvers: ({
                                    type: string;
                                } & {
                                    [key: string]: unknown;
                                })[];
                                /**
                                 * @description How the stage completes: `{ "type": "any" }` (the first decision), `{ "type": "all" }`, `{ "type": "quorum", "n": 2 }`, or a registered mode.
                                 * @default {
                                 *       "type": "any"
                                 *     }
                                 */
                                mode: {
                                    type: string;
                                } & {
                                    [key: string]: unknown;
                                };
                                /**
                                 * @description Remind the approvers who have not decided after this long.
                                 * @example 2d
                                 */
                                remindAfter?: string;
                                /**
                                 * @description The stage is overdue after this long: then `onOverdue`.
                                 * @example 2d
                                 */
                                dueAfter?: string;
                                /**
                                 * @description expire: the request expires; escalate: the `escalateTo` approvers are added.
                                 * @default expire
                                 * @enum {string}
                                 */
                                onOverdue: "expire" | "escalate";
                                /** @description With `onOverdue: escalate`: the approvers added. */
                                escalateTo?: ({
                                    type: string;
                                } & {
                                    [key: string]: unknown;
                                })[];
                                /**
                                 * @description After an escalation, the request expires after this long.
                                 * @example 2d
                                 */
                                escalationDueAfter?: string;
                            }[];
                            /**
                             * @default 30d
                             * @example 2d
                             */
                            resubmitWithin: string;
                        };
                        /** @description The code's default policy. */
                        default: {
                            /** @default true */
                            enabled: boolean;
                            /** @description Approval is needed only when this condition holds: `{ "type": "payload", "path": "amount", "op": "gt", "value": 1000 }`, `all`/`any`/`not` of others, or a registered condition. */
                            when?: ({
                                type: string;
                            } & {
                                [key: string]: unknown;
                            }) | null;
                            stages: {
                                /** @example Editor review */
                                name: string;
                                /** @description Approver rules (GET /v1/approvals/policy-types): every user any of them names is assigned when the stage starts. */
                                approvers: ({
                                    type: string;
                                } & {
                                    [key: string]: unknown;
                                })[];
                                /**
                                 * @description How the stage completes: `{ "type": "any" }` (the first decision), `{ "type": "all" }`, `{ "type": "quorum", "n": 2 }`, or a registered mode.
                                 * @default {
                                 *       "type": "any"
                                 *     }
                                 */
                                mode: {
                                    type: string;
                                } & {
                                    [key: string]: unknown;
                                };
                                /**
                                 * @description Remind the approvers who have not decided after this long.
                                 * @example 2d
                                 */
                                remindAfter?: string;
                                /**
                                 * @description The stage is overdue after this long: then `onOverdue`.
                                 * @example 2d
                                 */
                                dueAfter?: string;
                                /**
                                 * @description expire: the request expires; escalate: the `escalateTo` approvers are added.
                                 * @default expire
                                 * @enum {string}
                                 */
                                onOverdue: "expire" | "escalate";
                                /** @description With `onOverdue: escalate`: the approvers added. */
                                escalateTo?: ({
                                    type: string;
                                } & {
                                    [key: string]: unknown;
                                })[];
                                /**
                                 * @description After an escalation, the request expires after this long.
                                 * @example 2d
                                 */
                                escalationDueAfter?: string;
                            }[];
                            /**
                             * @default 30d
                             * @example 2d
                             */
                            resubmitWithin: string;
                        };
                        /** @description The setting that switches approval on (GET /v1/settings). */
                        setting: string | null;
                        /** @description The JSON Schema of the requests' payload. */
                        payloadSchema: {
                            [key: string]: unknown;
                        };
                    };
                };
            };
            /** @description An unknown type, or parameters its schema refuses (validation_failed, each error naming its path: `stages.0.approvers.1.role`). */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No valid session or user token. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Changing approval policies needs Approval.managePolicies. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No approvable action has this key. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description It changed since you read it (precondition_failed). */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    ApprovalPoliciesController_reset_v1: {
        parameters: {
            query?: never;
            header?: {
                /** @description The ETag the record had when you read it: the write is refused with 412 if it changed since (optimistic concurrency). Leave it out to write regardless; `*` means the same. */
                "If-Match"?: string;
            };
            path: {
                key: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        key: string;
                        subject: string;
                        action: string;
                        label: string;
                        description: string | null;
                        /** @description 0: the code default, never changed. */
                        version: number;
                        /** @enum {string} */
                        source: "code" | "override";
                        policy: {
                            /** @default true */
                            enabled: boolean;
                            /** @description Approval is needed only when this condition holds: `{ "type": "payload", "path": "amount", "op": "gt", "value": 1000 }`, `all`/`any`/`not` of others, or a registered condition. */
                            when?: ({
                                type: string;
                            } & {
                                [key: string]: unknown;
                            }) | null;
                            stages: {
                                /** @example Editor review */
                                name: string;
                                /** @description Approver rules (GET /v1/approvals/policy-types): every user any of them names is assigned when the stage starts. */
                                approvers: ({
                                    type: string;
                                } & {
                                    [key: string]: unknown;
                                })[];
                                /**
                                 * @description How the stage completes: `{ "type": "any" }` (the first decision), `{ "type": "all" }`, `{ "type": "quorum", "n": 2 }`, or a registered mode.
                                 * @default {
                                 *       "type": "any"
                                 *     }
                                 */
                                mode: {
                                    type: string;
                                } & {
                                    [key: string]: unknown;
                                };
                                /**
                                 * @description Remind the approvers who have not decided after this long.
                                 * @example 2d
                                 */
                                remindAfter?: string;
                                /**
                                 * @description The stage is overdue after this long: then `onOverdue`.
                                 * @example 2d
                                 */
                                dueAfter?: string;
                                /**
                                 * @description expire: the request expires; escalate: the `escalateTo` approvers are added.
                                 * @default expire
                                 * @enum {string}
                                 */
                                onOverdue: "expire" | "escalate";
                                /** @description With `onOverdue: escalate`: the approvers added. */
                                escalateTo?: ({
                                    type: string;
                                } & {
                                    [key: string]: unknown;
                                })[];
                                /**
                                 * @description After an escalation, the request expires after this long.
                                 * @example 2d
                                 */
                                escalationDueAfter?: string;
                            }[];
                            /**
                             * @default 30d
                             * @example 2d
                             */
                            resubmitWithin: string;
                        };
                        /** @description The code's default policy. */
                        default: {
                            /** @default true */
                            enabled: boolean;
                            /** @description Approval is needed only when this condition holds: `{ "type": "payload", "path": "amount", "op": "gt", "value": 1000 }`, `all`/`any`/`not` of others, or a registered condition. */
                            when?: ({
                                type: string;
                            } & {
                                [key: string]: unknown;
                            }) | null;
                            stages: {
                                /** @example Editor review */
                                name: string;
                                /** @description Approver rules (GET /v1/approvals/policy-types): every user any of them names is assigned when the stage starts. */
                                approvers: ({
                                    type: string;
                                } & {
                                    [key: string]: unknown;
                                })[];
                                /**
                                 * @description How the stage completes: `{ "type": "any" }` (the first decision), `{ "type": "all" }`, `{ "type": "quorum", "n": 2 }`, or a registered mode.
                                 * @default {
                                 *       "type": "any"
                                 *     }
                                 */
                                mode: {
                                    type: string;
                                } & {
                                    [key: string]: unknown;
                                };
                                /**
                                 * @description Remind the approvers who have not decided after this long.
                                 * @example 2d
                                 */
                                remindAfter?: string;
                                /**
                                 * @description The stage is overdue after this long: then `onOverdue`.
                                 * @example 2d
                                 */
                                dueAfter?: string;
                                /**
                                 * @description expire: the request expires; escalate: the `escalateTo` approvers are added.
                                 * @default expire
                                 * @enum {string}
                                 */
                                onOverdue: "expire" | "escalate";
                                /** @description With `onOverdue: escalate`: the approvers added. */
                                escalateTo?: ({
                                    type: string;
                                } & {
                                    [key: string]: unknown;
                                })[];
                                /**
                                 * @description After an escalation, the request expires after this long.
                                 * @example 2d
                                 */
                                escalationDueAfter?: string;
                            }[];
                            /**
                             * @default 30d
                             * @example 2d
                             */
                            resubmitWithin: string;
                        };
                        /** @description The setting that switches approval on (GET /v1/settings). */
                        setting: string | null;
                        /** @description The JSON Schema of the requests' payload. */
                        payloadSchema: {
                            [key: string]: unknown;
                        };
                    };
                };
            };
            /** @description No valid session or user token. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Changing approval policies needs Approval.managePolicies. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No approvable action has this key. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    ApprovalsController_list_v1: {
        parameters: {
            query?: {
                limit?: string;
                /** @description `nextCursor` of the previous page (the same `sort`). */
                cursor?: string;
                /** @description Pages by number instead of cursor: 1 for the first, `limit` rows a page. Example: `page=3&limit=20&count=true`. */
                page?: string;
                /** @description true: add `total` (counted up to a cap; `totalCapped`). */
                count?: string;
                /** @description The language of the answer. */
                lang?: string;
                /** @description Filter: assignedToMe = */
                assignedToMe?: string;
                /** @description Filter: requestedByMe = */
                requestedByMe?: string;
                /** @description Filter: status = */
                status?: string;
                /** @description Filter: status in */
                "status.in"?: string;
                /** @description Filter: status notIn */
                "status.notIn"?: string;
                /** @description Filter: subject = */
                subject?: string;
                /** @description Filter: subject in */
                "subject.in"?: string;
                /** @description Filter: action = */
                action?: string;
                /** @description Filter: action in */
                "action.in"?: string;
                /** @description Filter: recordId = */
                recordId?: string;
                /** @description Filter: requester = */
                requester?: string;
                /** @description Filter: dueAt lt */
                "dueAt.lt"?: string;
                /** @description Filter: dueAt lte */
                "dueAt.lte"?: string;
                /** @description Filter: dueAt gte */
                "dueAt.gte"?: string;
                /** @description Filter: dueAt isNull */
                "dueAt.isNull"?: string;
                /** @description Filter: createdAt gt */
                "createdAt.gt"?: string;
                /** @description Filter: createdAt gte */
                "createdAt.gte"?: string;
                /** @description Filter: createdAt lt */
                "createdAt.lt"?: string;
                /** @description Filter: createdAt lte */
                "createdAt.lte"?: string;
                /** @description Filter: createdAt between */
                "createdAt.between"?: string;
                /** @description Filter: updatedAt gt */
                "updatedAt.gt"?: string;
                /** @description Filter: updatedAt gte */
                "updatedAt.gte"?: string;
                /** @description Filter: updatedAt lt */
                "updatedAt.lt"?: string;
                /** @description Filter: updatedAt lte */
                "updatedAt.lte"?: string;
                /** @description Filter: updatedAt between */
                "updatedAt.between"?: string;
                /** @description Conditions in and/or groups, JSON: a condition { field, op, value } or a group { "and": [...] } / { "or": [...] }, 3 groups deep and 30 conditions at most. Example: {"or":[{"field":"assignedToMe","op":"eq","value":…},{…}]}. Fields and operators: assignedToMe (eq); requestedByMe (eq); status (eq, in, notIn); subject (eq, in); action (eq, in); recordId (eq); requester (eq); dueAt (lt, lte, gte, isNull); createdAt (gt, gte, lt, lte, between); updatedAt (gt, gte, lt, lte, between). */
                filter?: string;
                /** @description The order: fields comma-separated, - for descending; the newest first on ties. Example: -dueAt. Sortable: dueAt, createdAt, updatedAt. */
                sort?: string;
                /** @description Only these fields in each item, comma-separated; id always comes. Example: key,subject. Fields: id, key, subject, recordId, action, status, requester, requesterName, title, link, payload, policyVersion, round, currentStage, stageCount, stageName, dueAt, comment, outcomeReason, endedAt, createdAt, updatedAt. */
                fields?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** Format: uuid */
                            id: string;
                            /** @description The action: `<subject>.<action>`, `Note.publish`. */
                            key: string;
                            /** @example Note */
                            subject: string;
                            recordId: string;
                            /** @example publish */
                            action: string;
                            /** @enum {string} */
                            status: "pending" | "approved" | "rejected" | "changes_requested" | "cancelled" | "expired" | "failed";
                            /** @description `user:<id>` or `client:<id>`. */
                            requester: string;
                            requesterName: string;
                            /** @description What the record is called. */
                            title: string;
                            /** @description The record in the web app. */
                            link: string | null;
                            /** @description The proposed change; its schema is the action's `payloadSchema` (GET /v1/approvals/policies). */
                            payload: {
                                [key: string]: unknown;
                            };
                            /** @description The policy version it runs under (0: the code's default). */
                            policyVersion: number;
                            /** @description Resubmissions so far. */
                            round: number;
                            currentStage: number;
                            stageCount: number;
                            stageName: string;
                            /**
                             * Format: date-time
                             * @description The current stage's deadline.
                             */
                            dueAt: string | null;
                            /** @description The requester's note. */
                            comment: string | null;
                            /** @description Why it ended without a decision: `overdue`, `not_resubmitted`, `no_approvers`. */
                            outcomeReason: string | null;
                            /** Format: date-time */
                            endedAt: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: date-time */
                            updatedAt: string;
                        }[];
                        /** @description Pass it as `cursor` for the next page; null: no more (and with `page`). */
                        nextCursor: string | null;
                        /** @description With `page`: this page. */
                        page?: number;
                        /** @description With `page`: the next page; null: no more. */
                        nextPage?: number | null;
                        /** @description With `page` and `count=true`: ceil(total / limit). */
                        pageCount?: number;
                        /** @description With `count=true`: the rows matching the filters, all pages; the cap when totalCapped. */
                        total?: number;
                        /** @description true: there are more than `total` (show "10,000+"). */
                        totalCapped?: boolean;
                    };
                };
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    ApprovalsController_get_v1: {
        parameters: {
            query?: never;
            header?: {
                /** @description The ETag you have: 304 and no body when it is still current. */
                "If-None-Match"?: string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        /** @description The action: `<subject>.<action>`, `Note.publish`. */
                        key: string;
                        /** @example Note */
                        subject: string;
                        recordId: string;
                        /** @example publish */
                        action: string;
                        /** @enum {string} */
                        status: "pending" | "approved" | "rejected" | "changes_requested" | "cancelled" | "expired" | "failed";
                        /** @description `user:<id>` or `client:<id>`. */
                        requester: string;
                        requesterName: string;
                        /** @description What the record is called. */
                        title: string;
                        /** @description The record in the web app. */
                        link: string | null;
                        /** @description The proposed change; its schema is the action's `payloadSchema` (GET /v1/approvals/policies). */
                        payload: {
                            [key: string]: unknown;
                        };
                        /** @description The policy version it runs under (0: the code's default). */
                        policyVersion: number;
                        /** @description Resubmissions so far. */
                        round: number;
                        currentStage: number;
                        stageCount: number;
                        stageName: string;
                        /**
                         * Format: date-time
                         * @description The current stage's deadline.
                         */
                        dueAt: string | null;
                        /** @description The requester's note. */
                        comment: string | null;
                        /** @description Why it ended without a decision: `overdue`, `not_resubmitted`, `no_approvers`. */
                        outcomeReason: string | null;
                        /** Format: date-time */
                        endedAt: string | null;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: date-time */
                        updatedAt: string;
                        /** @description The policy's stages, as they stand in the current round. */
                        stages: {
                            index: number;
                            name: string;
                            mode: {
                                [key: string]: unknown;
                            };
                            /** @enum {string} */
                            state: "waiting" | "active" | "approved" | "rejected" | "changes_requested" | "closed";
                        }[];
                        /** @description Every assignment of every round, oldest first. */
                        assignments: {
                            /** Format: uuid */
                            id: string;
                            round: number;
                            stage: number;
                            /** Format: uuid */
                            approverId: string;
                            approverName: string;
                            /** @enum {string} */
                            status: "pending" | "approved" | "rejected" | "changes_requested" | "closed";
                            comment: string | null;
                            /** Format: date-time */
                            decidedAt: string | null;
                            /** Format: uuid */
                            decidedBy: string | null;
                            decidedByName: string | null;
                            /**
                             * Format: uuid
                             * @description Set when a delegate decided for the approver.
                             */
                            onBehalfOf: string | null;
                            escalated: boolean;
                        }[];
                        timeline: {
                            /** Format: uuid */
                            id: string;
                            /** @example stage_started */
                            type: string;
                            /** @description Who did it: `user:<id>`, `client:<id>`, or the system (`system:approvals`: the workflow's timers; `system:<job>`: a job that ended it). Null only on events recorded before the system principal. */
                            actor: string | null;
                            actorName: string | null;
                            round: number;
                            stage: number | null;
                            details: {
                                [key: string]: unknown;
                            } | null;
                            /** Format: date-time */
                            createdAt: string;
                        }[];
                        /** @description What you may do with it now. */
                        can: {
                            decide: boolean;
                            cancel: boolean;
                            resubmit: boolean;
                        };
                    };
                };
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    ApprovalsController_approve_v1: {
        parameters: {
            query?: never;
            header?: {
                /** @description The ETag the record had when you read it: the write is refused with 412 if it changed since (optimistic concurrency). Leave it out to write regardless; `*` means the same. */
                "If-Match"?: string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    comment?: string;
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        /** @description The action: `<subject>.<action>`, `Note.publish`. */
                        key: string;
                        /** @example Note */
                        subject: string;
                        recordId: string;
                        /** @example publish */
                        action: string;
                        /** @enum {string} */
                        status: "pending" | "approved" | "rejected" | "changes_requested" | "cancelled" | "expired" | "failed";
                        /** @description `user:<id>` or `client:<id>`. */
                        requester: string;
                        requesterName: string;
                        /** @description What the record is called. */
                        title: string;
                        /** @description The record in the web app. */
                        link: string | null;
                        /** @description The proposed change; its schema is the action's `payloadSchema` (GET /v1/approvals/policies). */
                        payload: {
                            [key: string]: unknown;
                        };
                        /** @description The policy version it runs under (0: the code's default). */
                        policyVersion: number;
                        /** @description Resubmissions so far. */
                        round: number;
                        currentStage: number;
                        stageCount: number;
                        stageName: string;
                        /**
                         * Format: date-time
                         * @description The current stage's deadline.
                         */
                        dueAt: string | null;
                        /** @description The requester's note. */
                        comment: string | null;
                        /** @description Why it ended without a decision: `overdue`, `not_resubmitted`, `no_approvers`. */
                        outcomeReason: string | null;
                        /** Format: date-time */
                        endedAt: string | null;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: date-time */
                        updatedAt: string;
                        /** @description The policy's stages, as they stand in the current round. */
                        stages: {
                            index: number;
                            name: string;
                            mode: {
                                [key: string]: unknown;
                            };
                            /** @enum {string} */
                            state: "waiting" | "active" | "approved" | "rejected" | "changes_requested" | "closed";
                        }[];
                        /** @description Every assignment of every round, oldest first. */
                        assignments: {
                            /** Format: uuid */
                            id: string;
                            round: number;
                            stage: number;
                            /** Format: uuid */
                            approverId: string;
                            approverName: string;
                            /** @enum {string} */
                            status: "pending" | "approved" | "rejected" | "changes_requested" | "closed";
                            comment: string | null;
                            /** Format: date-time */
                            decidedAt: string | null;
                            /** Format: uuid */
                            decidedBy: string | null;
                            decidedByName: string | null;
                            /**
                             * Format: uuid
                             * @description Set when a delegate decided for the approver.
                             */
                            onBehalfOf: string | null;
                            escalated: boolean;
                        }[];
                        timeline: {
                            /** Format: uuid */
                            id: string;
                            /** @example stage_started */
                            type: string;
                            /** @description Who did it: `user:<id>`, `client:<id>`, or the system (`system:approvals`: the workflow's timers; `system:<job>`: a job that ended it). Null only on events recorded before the system principal. */
                            actor: string | null;
                            actorName: string | null;
                            round: number;
                            stage: number | null;
                            details: {
                                [key: string]: unknown;
                            } | null;
                            /** Format: date-time */
                            createdAt: string;
                        }[];
                        /** @description What you may do with it now. */
                        can: {
                            decide: boolean;
                            cancel: boolean;
                            resubmit: boolean;
                        };
                    };
                };
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not an approver of the current stage, nor standing in for one (approval_not_assignee), or your own request (approval_self_approval). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No such request that you may read. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The stage was decided by someone else, or you decided otherwise (approval_already_decided); the request has ended (approval_closed). */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The request changed since you read it (precondition_failed). */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    ApprovalsController_reject_v1: {
        parameters: {
            query?: never;
            header?: {
                /** @description The ETag the record had when you read it: the write is refused with 412 if it changed since (optimistic concurrency). Leave it out to write regardless; `*` means the same. */
                "If-Match"?: string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    comment: string;
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        /** @description The action: `<subject>.<action>`, `Note.publish`. */
                        key: string;
                        /** @example Note */
                        subject: string;
                        recordId: string;
                        /** @example publish */
                        action: string;
                        /** @enum {string} */
                        status: "pending" | "approved" | "rejected" | "changes_requested" | "cancelled" | "expired" | "failed";
                        /** @description `user:<id>` or `client:<id>`. */
                        requester: string;
                        requesterName: string;
                        /** @description What the record is called. */
                        title: string;
                        /** @description The record in the web app. */
                        link: string | null;
                        /** @description The proposed change; its schema is the action's `payloadSchema` (GET /v1/approvals/policies). */
                        payload: {
                            [key: string]: unknown;
                        };
                        /** @description The policy version it runs under (0: the code's default). */
                        policyVersion: number;
                        /** @description Resubmissions so far. */
                        round: number;
                        currentStage: number;
                        stageCount: number;
                        stageName: string;
                        /**
                         * Format: date-time
                         * @description The current stage's deadline.
                         */
                        dueAt: string | null;
                        /** @description The requester's note. */
                        comment: string | null;
                        /** @description Why it ended without a decision: `overdue`, `not_resubmitted`, `no_approvers`. */
                        outcomeReason: string | null;
                        /** Format: date-time */
                        endedAt: string | null;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: date-time */
                        updatedAt: string;
                        /** @description The policy's stages, as they stand in the current round. */
                        stages: {
                            index: number;
                            name: string;
                            mode: {
                                [key: string]: unknown;
                            };
                            /** @enum {string} */
                            state: "waiting" | "active" | "approved" | "rejected" | "changes_requested" | "closed";
                        }[];
                        /** @description Every assignment of every round, oldest first. */
                        assignments: {
                            /** Format: uuid */
                            id: string;
                            round: number;
                            stage: number;
                            /** Format: uuid */
                            approverId: string;
                            approverName: string;
                            /** @enum {string} */
                            status: "pending" | "approved" | "rejected" | "changes_requested" | "closed";
                            comment: string | null;
                            /** Format: date-time */
                            decidedAt: string | null;
                            /** Format: uuid */
                            decidedBy: string | null;
                            decidedByName: string | null;
                            /**
                             * Format: uuid
                             * @description Set when a delegate decided for the approver.
                             */
                            onBehalfOf: string | null;
                            escalated: boolean;
                        }[];
                        timeline: {
                            /** Format: uuid */
                            id: string;
                            /** @example stage_started */
                            type: string;
                            /** @description Who did it: `user:<id>`, `client:<id>`, or the system (`system:approvals`: the workflow's timers; `system:<job>`: a job that ended it). Null only on events recorded before the system principal. */
                            actor: string | null;
                            actorName: string | null;
                            round: number;
                            stage: number | null;
                            details: {
                                [key: string]: unknown;
                            } | null;
                            /** Format: date-time */
                            createdAt: string;
                        }[];
                        /** @description What you may do with it now. */
                        can: {
                            decide: boolean;
                            cancel: boolean;
                            resubmit: boolean;
                        };
                    };
                };
            };
            /** @description No comment (validation_failed). */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not an approver of the current stage, nor standing in for one (approval_not_assignee), or your own request (approval_self_approval). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No such request that you may read. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The stage was decided by someone else, or you decided otherwise (approval_already_decided); the request has ended (approval_closed). */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The request changed since you read it (precondition_failed). */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    ApprovalsController_requestChanges_v1: {
        parameters: {
            query?: never;
            header?: {
                /** @description The ETag the record had when you read it: the write is refused with 412 if it changed since (optimistic concurrency). Leave it out to write regardless; `*` means the same. */
                "If-Match"?: string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    comment: string;
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        /** @description The action: `<subject>.<action>`, `Note.publish`. */
                        key: string;
                        /** @example Note */
                        subject: string;
                        recordId: string;
                        /** @example publish */
                        action: string;
                        /** @enum {string} */
                        status: "pending" | "approved" | "rejected" | "changes_requested" | "cancelled" | "expired" | "failed";
                        /** @description `user:<id>` or `client:<id>`. */
                        requester: string;
                        requesterName: string;
                        /** @description What the record is called. */
                        title: string;
                        /** @description The record in the web app. */
                        link: string | null;
                        /** @description The proposed change; its schema is the action's `payloadSchema` (GET /v1/approvals/policies). */
                        payload: {
                            [key: string]: unknown;
                        };
                        /** @description The policy version it runs under (0: the code's default). */
                        policyVersion: number;
                        /** @description Resubmissions so far. */
                        round: number;
                        currentStage: number;
                        stageCount: number;
                        stageName: string;
                        /**
                         * Format: date-time
                         * @description The current stage's deadline.
                         */
                        dueAt: string | null;
                        /** @description The requester's note. */
                        comment: string | null;
                        /** @description Why it ended without a decision: `overdue`, `not_resubmitted`, `no_approvers`. */
                        outcomeReason: string | null;
                        /** Format: date-time */
                        endedAt: string | null;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: date-time */
                        updatedAt: string;
                        /** @description The policy's stages, as they stand in the current round. */
                        stages: {
                            index: number;
                            name: string;
                            mode: {
                                [key: string]: unknown;
                            };
                            /** @enum {string} */
                            state: "waiting" | "active" | "approved" | "rejected" | "changes_requested" | "closed";
                        }[];
                        /** @description Every assignment of every round, oldest first. */
                        assignments: {
                            /** Format: uuid */
                            id: string;
                            round: number;
                            stage: number;
                            /** Format: uuid */
                            approverId: string;
                            approverName: string;
                            /** @enum {string} */
                            status: "pending" | "approved" | "rejected" | "changes_requested" | "closed";
                            comment: string | null;
                            /** Format: date-time */
                            decidedAt: string | null;
                            /** Format: uuid */
                            decidedBy: string | null;
                            decidedByName: string | null;
                            /**
                             * Format: uuid
                             * @description Set when a delegate decided for the approver.
                             */
                            onBehalfOf: string | null;
                            escalated: boolean;
                        }[];
                        timeline: {
                            /** Format: uuid */
                            id: string;
                            /** @example stage_started */
                            type: string;
                            /** @description Who did it: `user:<id>`, `client:<id>`, or the system (`system:approvals`: the workflow's timers; `system:<job>`: a job that ended it). Null only on events recorded before the system principal. */
                            actor: string | null;
                            actorName: string | null;
                            round: number;
                            stage: number | null;
                            details: {
                                [key: string]: unknown;
                            } | null;
                            /** Format: date-time */
                            createdAt: string;
                        }[];
                        /** @description What you may do with it now. */
                        can: {
                            decide: boolean;
                            cancel: boolean;
                            resubmit: boolean;
                        };
                    };
                };
            };
            /** @description No comment (validation_failed). */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not an approver of the current stage, nor standing in for one (approval_not_assignee), or your own request (approval_self_approval). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No such request that you may read. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The stage was decided by someone else, or you decided otherwise (approval_already_decided); the request has ended (approval_closed). */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The request changed since you read it (precondition_failed). */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    ApprovalsController_cancel_v1: {
        parameters: {
            query?: never;
            header?: {
                /** @description The ETag the record had when you read it: the write is refused with 412 if it changed since (optimistic concurrency). Leave it out to write regardless; `*` means the same. */
                "If-Match"?: string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    reason?: string;
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        /** @description The action: `<subject>.<action>`, `Note.publish`. */
                        key: string;
                        /** @example Note */
                        subject: string;
                        recordId: string;
                        /** @example publish */
                        action: string;
                        /** @enum {string} */
                        status: "pending" | "approved" | "rejected" | "changes_requested" | "cancelled" | "expired" | "failed";
                        /** @description `user:<id>` or `client:<id>`. */
                        requester: string;
                        requesterName: string;
                        /** @description What the record is called. */
                        title: string;
                        /** @description The record in the web app. */
                        link: string | null;
                        /** @description The proposed change; its schema is the action's `payloadSchema` (GET /v1/approvals/policies). */
                        payload: {
                            [key: string]: unknown;
                        };
                        /** @description The policy version it runs under (0: the code's default). */
                        policyVersion: number;
                        /** @description Resubmissions so far. */
                        round: number;
                        currentStage: number;
                        stageCount: number;
                        stageName: string;
                        /**
                         * Format: date-time
                         * @description The current stage's deadline.
                         */
                        dueAt: string | null;
                        /** @description The requester's note. */
                        comment: string | null;
                        /** @description Why it ended without a decision: `overdue`, `not_resubmitted`, `no_approvers`. */
                        outcomeReason: string | null;
                        /** Format: date-time */
                        endedAt: string | null;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: date-time */
                        updatedAt: string;
                        /** @description The policy's stages, as they stand in the current round. */
                        stages: {
                            index: number;
                            name: string;
                            mode: {
                                [key: string]: unknown;
                            };
                            /** @enum {string} */
                            state: "waiting" | "active" | "approved" | "rejected" | "changes_requested" | "closed";
                        }[];
                        /** @description Every assignment of every round, oldest first. */
                        assignments: {
                            /** Format: uuid */
                            id: string;
                            round: number;
                            stage: number;
                            /** Format: uuid */
                            approverId: string;
                            approverName: string;
                            /** @enum {string} */
                            status: "pending" | "approved" | "rejected" | "changes_requested" | "closed";
                            comment: string | null;
                            /** Format: date-time */
                            decidedAt: string | null;
                            /** Format: uuid */
                            decidedBy: string | null;
                            decidedByName: string | null;
                            /**
                             * Format: uuid
                             * @description Set when a delegate decided for the approver.
                             */
                            onBehalfOf: string | null;
                            escalated: boolean;
                        }[];
                        timeline: {
                            /** Format: uuid */
                            id: string;
                            /** @example stage_started */
                            type: string;
                            /** @description Who did it: `user:<id>`, `client:<id>`, or the system (`system:approvals`: the workflow's timers; `system:<job>`: a job that ended it). Null only on events recorded before the system principal. */
                            actor: string | null;
                            actorName: string | null;
                            round: number;
                            stage: number | null;
                            details: {
                                [key: string]: unknown;
                            } | null;
                            /** Format: date-time */
                            createdAt: string;
                        }[];
                        /** @description What you may do with it now. */
                        can: {
                            decide: boolean;
                            cancel: boolean;
                            resubmit: boolean;
                        };
                    };
                };
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Neither the requester nor allowed to cancel it. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description It has ended (approval_closed). */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description precondition_failed. */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    ApprovalsController_abandon_v1: {
        parameters: {
            query?: never;
            header?: {
                /** @description The ETag the record had when you read it: the write is refused with 412 if it changed since (optimistic concurrency). Leave it out to write regardless; `*` means the same. */
                "If-Match"?: string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    reason?: string;
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        /** @description The action: `<subject>.<action>`, `Note.publish`. */
                        key: string;
                        /** @example Note */
                        subject: string;
                        recordId: string;
                        /** @example publish */
                        action: string;
                        /** @enum {string} */
                        status: "pending" | "approved" | "rejected" | "changes_requested" | "cancelled" | "expired" | "failed";
                        /** @description `user:<id>` or `client:<id>`. */
                        requester: string;
                        requesterName: string;
                        /** @description What the record is called. */
                        title: string;
                        /** @description The record in the web app. */
                        link: string | null;
                        /** @description The proposed change; its schema is the action's `payloadSchema` (GET /v1/approvals/policies). */
                        payload: {
                            [key: string]: unknown;
                        };
                        /** @description The policy version it runs under (0: the code's default). */
                        policyVersion: number;
                        /** @description Resubmissions so far. */
                        round: number;
                        currentStage: number;
                        stageCount: number;
                        stageName: string;
                        /**
                         * Format: date-time
                         * @description The current stage's deadline.
                         */
                        dueAt: string | null;
                        /** @description The requester's note. */
                        comment: string | null;
                        /** @description Why it ended without a decision: `overdue`, `not_resubmitted`, `no_approvers`. */
                        outcomeReason: string | null;
                        /** Format: date-time */
                        endedAt: string | null;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: date-time */
                        updatedAt: string;
                        /** @description The policy's stages, as they stand in the current round. */
                        stages: {
                            index: number;
                            name: string;
                            mode: {
                                [key: string]: unknown;
                            };
                            /** @enum {string} */
                            state: "waiting" | "active" | "approved" | "rejected" | "changes_requested" | "closed";
                        }[];
                        /** @description Every assignment of every round, oldest first. */
                        assignments: {
                            /** Format: uuid */
                            id: string;
                            round: number;
                            stage: number;
                            /** Format: uuid */
                            approverId: string;
                            approverName: string;
                            /** @enum {string} */
                            status: "pending" | "approved" | "rejected" | "changes_requested" | "closed";
                            comment: string | null;
                            /** Format: date-time */
                            decidedAt: string | null;
                            /** Format: uuid */
                            decidedBy: string | null;
                            decidedByName: string | null;
                            /**
                             * Format: uuid
                             * @description Set when a delegate decided for the approver.
                             */
                            onBehalfOf: string | null;
                            escalated: boolean;
                        }[];
                        timeline: {
                            /** Format: uuid */
                            id: string;
                            /** @example stage_started */
                            type: string;
                            /** @description Who did it: `user:<id>`, `client:<id>`, or the system (`system:approvals`: the workflow's timers; `system:<job>`: a job that ended it). Null only on events recorded before the system principal. */
                            actor: string | null;
                            actorName: string | null;
                            round: number;
                            stage: number | null;
                            details: {
                                [key: string]: unknown;
                            } | null;
                            /** Format: date-time */
                            createdAt: string;
                        }[];
                        /** @description What you may do with it now. */
                        can: {
                            decide: boolean;
                            cancel: boolean;
                            resubmit: boolean;
                        };
                    };
                };
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed to manage approvals, or impersonating. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not approved, applied already, or its workflow still runs or retries (approval_not_stuck). */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description precondition_failed. */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    ApprovalsController_resubmit_v1: {
        parameters: {
            query?: never;
            header?: {
                /** @description The ETag the record had when you read it: the write is refused with 412 if it changed since (optimistic concurrency). Leave it out to write regardless; `*` means the same. */
                "If-Match"?: string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description A new proposed change; checked by the action's schema. */
                    payload?: {
                        [key: string]: unknown;
                    };
                    comment?: string;
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        /** @description The action: `<subject>.<action>`, `Note.publish`. */
                        key: string;
                        /** @example Note */
                        subject: string;
                        recordId: string;
                        /** @example publish */
                        action: string;
                        /** @enum {string} */
                        status: "pending" | "approved" | "rejected" | "changes_requested" | "cancelled" | "expired" | "failed";
                        /** @description `user:<id>` or `client:<id>`. */
                        requester: string;
                        requesterName: string;
                        /** @description What the record is called. */
                        title: string;
                        /** @description The record in the web app. */
                        link: string | null;
                        /** @description The proposed change; its schema is the action's `payloadSchema` (GET /v1/approvals/policies). */
                        payload: {
                            [key: string]: unknown;
                        };
                        /** @description The policy version it runs under (0: the code's default). */
                        policyVersion: number;
                        /** @description Resubmissions so far. */
                        round: number;
                        currentStage: number;
                        stageCount: number;
                        stageName: string;
                        /**
                         * Format: date-time
                         * @description The current stage's deadline.
                         */
                        dueAt: string | null;
                        /** @description The requester's note. */
                        comment: string | null;
                        /** @description Why it ended without a decision: `overdue`, `not_resubmitted`, `no_approvers`. */
                        outcomeReason: string | null;
                        /** Format: date-time */
                        endedAt: string | null;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: date-time */
                        updatedAt: string;
                        /** @description The policy's stages, as they stand in the current round. */
                        stages: {
                            index: number;
                            name: string;
                            mode: {
                                [key: string]: unknown;
                            };
                            /** @enum {string} */
                            state: "waiting" | "active" | "approved" | "rejected" | "changes_requested" | "closed";
                        }[];
                        /** @description Every assignment of every round, oldest first. */
                        assignments: {
                            /** Format: uuid */
                            id: string;
                            round: number;
                            stage: number;
                            /** Format: uuid */
                            approverId: string;
                            approverName: string;
                            /** @enum {string} */
                            status: "pending" | "approved" | "rejected" | "changes_requested" | "closed";
                            comment: string | null;
                            /** Format: date-time */
                            decidedAt: string | null;
                            /** Format: uuid */
                            decidedBy: string | null;
                            decidedByName: string | null;
                            /**
                             * Format: uuid
                             * @description Set when a delegate decided for the approver.
                             */
                            onBehalfOf: string | null;
                            escalated: boolean;
                        }[];
                        timeline: {
                            /** Format: uuid */
                            id: string;
                            /** @example stage_started */
                            type: string;
                            /** @description Who did it: `user:<id>`, `client:<id>`, or the system (`system:approvals`: the workflow's timers; `system:<job>`: a job that ended it). Null only on events recorded before the system principal. */
                            actor: string | null;
                            actorName: string | null;
                            round: number;
                            stage: number | null;
                            details: {
                                [key: string]: unknown;
                            } | null;
                            /** Format: date-time */
                            createdAt: string;
                        }[];
                        /** @description What you may do with it now. */
                        can: {
                            decide: boolean;
                            cancel: boolean;
                            resubmit: boolean;
                        };
                    };
                };
            };
            /** @description The payload fails the action’s schema. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not the requester. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not sent back for changes (approval_not_changes_requested). */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description precondition_failed. */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description A stage would find no approver (approval_no_approvers). */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    MoneyController_ratesOn_v1: {
        parameters: {
            query?: {
                /** @description A day (yyyy-mm-dd): the rates of the newest working day on or before it. Default: today (UTC). */
                date?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description Whose rates: `ecb`. */
                        source: string;
                        /** @description The currency the rates are quoted against: EUR. */
                        base: string;
                        /**
                         * Format: date
                         * @description The day of these rates.
                         */
                        day: string;
                        /** @description Units of each currency per one `base`, as decimal strings: { "USD": "1.1652" }. */
                        rates: {
                            [key: string]: string;
                        };
                    };
                };
            };
            /** @description A malformed date. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No valid credentials. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description `rates_unavailable`: no rates on or before that day. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    MoneyController_convert_v1: {
        parameters: {
            query: {
                /** @description The amount to convert, in major units: "12.34". */
                amount: string;
                /** @description The amount’s currency. */
                currency: string;
                /** @description The currency to convert to. */
                to: string;
                /** @description A day (yyyy-mm-dd): the rates of the newest working day on or before it. Default: today (UTC). */
                date?: string;
                /** @description How a result between two minor units is rounded: half-up (ties away from zero, the default), half-even (banker’s), half-down, up, down, ceiling, floor. */
                rounding?: "half-up" | "half-even" | "half-down" | "up" | "down" | "ceiling" | "floor";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description The amount asked for. */
                        from: components["schemas"]["Money"];
                        /** @description The converted amount, rounded once to the target’s minor unit. */
                        amount: components["schemas"]["Money"];
                        /** @description Target units per source unit, to 10 decimals (half-up), to show and store. The amount is computed from the exact legs, not from it. */
                        rate: string;
                        /**
                         * Format: date
                         * @description The day of the rates used: the newest with both currencies on or before `date`.
                         */
                        rateDate: string;
                        /** @description Whose rates: `ecb` (`identity` for the same currency). */
                        source: string;
                        /** @description The currency both legs are quoted against. */
                        base: string;
                        /** @description Units of the source and the target currency per one `base` (1 for the base). */
                        legs: {
                            from: string;
                            to: string;
                        };
                        rounding: string;
                    };
                };
            };
            /** @description An unknown currency, a malformed amount, or more decimals than the currency has. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No valid credentials. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description `rate_unavailable`: no rate for a currency on or before that day (the ECB doesn’t publish it, or none was fetched yet). */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    AuthController_methods_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {boolean} */
                        password: true;
                        signUp: boolean;
                        magicLink: boolean;
                        /** @description Sign in with a passkey: POST /auth/passkeys/sign-in/options, then /auth/passkeys/sign-in. */
                        passkeys: boolean;
                        /** @description Start with GET /auth/oidc/{provider}/login. */
                        providers: string[];
                        /** @description Bot protection on sign-in (and its two-factor step), sign-up, the magic-link request and forgot password: send the widget's token in `X-Captcha-Token`, always, or when a 403 `captcha_required` asks for one. null: off. */
                        captcha: {
                            /** @description `turnstile`; `stub` outside production. */
                            provider: string;
                            /** @description Render the widget with it (null: the stub). */
                            siteKey: string | null;
                            /** @enum {string} */
                            mode: "always" | "after-failures";
                        } | null;
                    };
                };
            };
        };
    };
    AuthController_signIn_v1: {
        parameters: {
            query?: never;
            header?: {
                /** @description The challenge token (Cloudflare Turnstile, widget action `sign-in`), when GET /auth/methods lists a captcha: always, or once a 403 `captcha_required` asked for one. */
                "X-Captcha-Token"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @example admin@example.com */
                    email: string;
                    password: string;
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        signedIn: boolean;
                        /** @description true: send a code to POST /auth/mfa/verify to finish signing in. */
                        mfaRequired: boolean;
                        redirectTo?: string;
                    };
                };
            };
            /** @description Invalid email or password. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description `captcha_required`: solve the challenge (the problem names `provider`, `siteKey` and `action`) and send its token in `X-Captcha-Token`. `captcha_invalid`: the token was refused (`reason`: `invalid`, `duplicate`, `hostname`, `action`); render the widget again. Provider down: 503 `captcha_unavailable` (fail-closed), or 429 `rate_limited` past the fail-open allowance. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description More than 5 attempts for this email from this IP in 15 minutes. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    AuthController_signUp_v1: {
        parameters: {
            query?: never;
            header?: {
                /** @description The challenge token (Cloudflare Turnstile, widget action `sign-up`), when GET /auth/methods lists a captcha: always, or once a 403 `captcha_required` asked for one. */
                "X-Captcha-Token"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @example ada@example.com */
                    email: string;
                    name: string;
                    password: string;
                    /** @example de */
                    locale?: string;
                    /** @example Europe/Berlin */
                    timezone?: string;
                };
            };
        };
        responses: {
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {string} */
                        kind: "user";
                        id: string;
                        email: string;
                        name: string;
                        emailVerified: boolean;
                        locale: string | null;
                        timezone: string | null;
                        /** @description The tenant this session or token acts in (GET /auth/tenants, POST /auth/tenant); null: none (no membership yet). */
                        tenantId: string | null;
                        /** @description Set while an administrator acts as this user. */
                        impersonator?: {
                            id: string;
                            email: string;
                        };
                    };
                };
            };
            /** @description `password_breached`: the password is in known data breaches. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description `captcha_required`: solve the challenge (the problem names `provider`, `siteKey` and `action`) and send its token in `X-Captcha-Token`. `captcha_invalid`: the token was refused (`reason`: `invalid`, `duplicate`, `hostname`, `action`); render the widget again. Provider down: 503 `captcha_unavailable` (fail-closed), or 429 `rate_limited` past the fail-open allowance. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description An account with this email exists. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    AuthController_completeMfa_v1: {
        parameters: {
            query?: never;
            header?: {
                /** @description The challenge token (Cloudflare Turnstile, widget action `sign-in`), when GET /auth/methods lists a captcha: always, or once a 403 `captcha_required` asked for one. */
                "X-Captcha-Token"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    code?: string;
                    recoveryCode?: string;
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        signedIn: boolean;
                        /** @description true: send a code to POST /auth/mfa/verify to finish signing in. */
                        mfaRequired: boolean;
                        redirectTo?: string;
                    };
                };
            };
            /** @description No pending sign-in, or a wrong code. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description `captcha_required`: solve the challenge (the problem names `provider`, `siteKey` and `action`) and send its token in `X-Captcha-Token`. `captcha_invalid`: the token was refused (`reason`: `invalid`, `duplicate`, `hostname`, `action`); render the widget again. Provider down: 503 `captcha_unavailable` (fail-closed), or 429 `rate_limited` past the fail-open allowance. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    AuthController_signOut_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    AuthController_me_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        user: {
                            /** @enum {string} */
                            kind: "user";
                            id: string;
                            email: string;
                            name: string;
                            emailVerified: boolean;
                            locale: string | null;
                            timezone: string | null;
                            /** @description The tenant this session or token acts in (GET /auth/tenants, POST /auth/tenant); null: none (no membership yet). */
                            tenantId: string | null;
                            /** @description Set while an administrator acts as this user. */
                            impersonator?: {
                                id: string;
                                email: string;
                            };
                        };
                        /** @description The tenant this session or token acts in; null: none. */
                        tenant: {
                            id: string;
                            slug: string;
                            name: string;
                        } | null;
                        mfaEnabled: boolean;
                        /** @description true: this tenant requires two-factor (auth.requireMfa) and you have none: set it up (POST /auth/mfa/enroll, then /confirm); until then other routes answer 403 `mfa_enrollment_required`. */
                        mfaEnrollmentRequired: boolean;
                        authentication: {
                            /** @enum {string} */
                            via: "session" | "token";
                            /**
                             * @description How this session or token was signed in.
                             * @enum {string|null}
                             */
                            method: "password" | "magic-link" | "oidc" | "sso" | "passkey" | "impersonation" | null;
                            provider: string | null;
                            /** @description A second factor was verified. */
                            mfa: boolean;
                            /** Format: date-time */
                            authenticatedAt: string | null;
                            /**
                             * Format: date-time
                             * @description Until when the sensitive routes accept it without a re-authentication (POST /auth/reauthenticate); past, or null, they want one now.
                             */
                            recentUntil: string | null;
                        } | null;
                        /** @description Every action of the permission catalog as "Subject.action": true when any of the user's permissions allows it, on some records at least. */
                        can: {
                            [key: string]: boolean;
                        };
                    };
                };
            };
            /** @description Not signed in. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    AuthController_updateProfile_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    name?: string;
                    /**
                     * @description null: the request's language.
                     * @example de
                     */
                    locale?: string | null;
                    /**
                     * @description null: the app's time zone.
                     * @example Europe/Berlin
                     */
                    timezone?: string | null;
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {string} */
                        kind: "user";
                        id: string;
                        email: string;
                        name: string;
                        emailVerified: boolean;
                        locale: string | null;
                        timezone: string | null;
                        /** @description The tenant this session or token acts in (GET /auth/tenants, POST /auth/tenant); null: none (no membership yet). */
                        tenantId: string | null;
                        /** @description Set while an administrator acts as this user. */
                        impersonator?: {
                            id: string;
                            email: string;
                        };
                    };
                };
            };
            /** @description A language this API doesn't speak, or an unknown time zone. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    AuthController_stopImpersonating_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description feature_off: IMPERSONATION=off in this deployment. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not impersonating anyone. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    PasswordController_forgot_v1: {
        parameters: {
            query?: never;
            header?: {
                /** @description The challenge token (Cloudflare Turnstile, widget action `forgot-password`), when GET /auth/methods lists a captcha: always, or once a 403 `captcha_required` asked for one. */
                "X-Captcha-Token"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @example ada@example.com */
                    email: string;
                };
            };
        };
        responses: {
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {boolean} */
                        accepted: true;
                    };
                };
            };
            /** @description `captcha_required`: solve the challenge (the problem names `provider`, `siteKey` and `action`) and send its token in `X-Captcha-Token`. `captcha_invalid`: the token was refused (`reason`: `invalid`, `duplicate`, `hostname`, `action`); render the widget again. Provider down: 503 `captcha_unavailable` (fail-closed), or 429 `rate_limited` past the fail-open allowance. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    PasswordController_reset_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    token: string;
                    password: string;
                };
            };
        };
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unknown, used or expired link; or `password_breached`: the password is in known data breaches (the link still works). */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    PasswordController_change_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description Required when the account has a password. */
                    currentPassword?: string;
                    newPassword: string;
                };
            };
        };
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description `password_breached`: the new password is in known data breaches. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /**
             * @description Wrong current password, or an administrator acting as you.
             *
             *     `reauthentication_required`: no sign-in in the last REAUTHENTICATION_MAX_AGE_MINUTES: re-authenticate (POST /auth/reauthenticate, or sign in again: the problem lists `methods`) and retry. Or not allowed: your permissions, or acting as another user.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    EmailController_verify_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    token: string;
                    /** @description The account's password, when it was chosen before the address was proved (a sign-up): required then. */
                    password?: string;
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        email: string;
                        /** @enum {boolean} */
                        emailVerified: true;
                    };
                };
            };
            /** @description Unknown, used or expired link, or the address changed since. `password_required`: the account signed up with a password, send it (a wrong one is 403 `forbidden`; the link stays usable either way). */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    EmailController_resend_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {boolean} */
                        accepted: true;
                    };
                };
            };
        };
    };
    SessionsController_list_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            id: string;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: date-time */
                            lastActiveAt: string;
                            userAgent: string | null;
                            /** @description A readable summary of the user agent ("Chrome on macOS"); null when none was recorded. */
                            device: string | null;
                            /**
                             * @description How it was signed in (`impersonation`: an administrator acting as you); null: before this was recorded.
                             * @enum {string|null}
                             */
                            method: "password" | "magic-link" | "oidc" | "sso" | "passkey" | "impersonation" | null;
                            /** @description The provider (`google`) of an `oidc` sign-in. */
                            provider: string | null;
                            /** @description A second factor was verified. */
                            mfa: boolean;
                            /**
                             * Format: date-time
                             * @description The sign-in, or the last re-authentication.
                             */
                            authenticatedAt: string | null;
                            current: boolean;
                        }[];
                    };
                };
            };
        };
    };
    SessionsController_revoke_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    SessionsController_signOutEverywhere_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    MfaController_status_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        enabled: boolean;
                        remainingRecoveryCodes: number;
                    };
                };
            };
        };
    };
    MfaController_disable_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description `reauthentication_required`: no sign-in in the last REAUTHENTICATION_MAX_AGE_MINUTES: re-authenticate (POST /auth/reauthenticate, or sign in again: the problem lists `methods`) and retry. Or not allowed: your permissions, or acting as another user. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    MfaController_enroll_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description Base32, for typing into the app by hand. */
                        secret: string;
                        /** @description otpauth:// URI: show it as a QR code. */
                        uri: string;
                    };
                };
            };
            /** @description `reauthentication_required`: no sign-in in the last REAUTHENTICATION_MAX_AGE_MINUTES: re-authenticate (POST /auth/reauthenticate, or sign in again: the problem lists `methods`) and retry. Or not allowed: your permissions, or acting as another user. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description feature_off: AUTH_MFA=off in this deployment. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Two-factor is already on: turn it off first. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    MfaController_confirm_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    code: string;
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description Shown once: each one signs in once in place of a code. */
                        recoveryCodes: string[];
                    };
                };
            };
            /** @description feature_off: AUTH_MFA=off in this deployment. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    MfaController_recoveryCodes_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description Shown once: each one signs in once in place of a code. */
                        recoveryCodes: string[];
                    };
                };
            };
            /** @description `reauthentication_required`: no sign-in in the last REAUTHENTICATION_MAX_AGE_MINUTES: re-authenticate (POST /auth/reauthenticate, or sign in again: the problem lists `methods`) and retry. Or not allowed: your permissions, or acting as another user. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    MagicLinkController_request_v1: {
        parameters: {
            query?: never;
            header?: {
                /** @description The challenge token (Cloudflare Turnstile, widget action `magic-link`), when GET /auth/methods lists a captcha: always, or once a 403 `captcha_required` asked for one. */
                "X-Captcha-Token"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @example ada@example.com */
                    email: string;
                    /** @example /inbox */
                    redirectTo?: string;
                };
            };
        };
        responses: {
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {boolean} */
                        accepted: true;
                    };
                };
            };
            /** @description `captcha_required`: solve the challenge (the problem names `provider`, `siteKey` and `action`) and send its token in `X-Captcha-Token`. `captcha_invalid`: the token was refused (`reason`: `invalid`, `duplicate`, `hostname`, `action`); render the widget again. Provider down: 503 `captcha_unavailable` (fail-closed), or 429 `rate_limited` past the fail-open allowance. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    MagicLinkController_consume_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    token: string;
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        signedIn: boolean;
                        /** @description true: send a code to POST /auth/mfa/verify to finish signing in. */
                        mfaRequired: boolean;
                        redirectTo?: string;
                    };
                };
            };
            /** @description Unknown, used or expired link, or another browser. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    OidcController_login_v1: {
        parameters: {
            query?: {
                /** @description A path of the web app to land on (one leading `/`, printable ASCII, no `\`); anything else is ignored. */
                redirectTo?: string;
                /** @description `true`: connect the provider to the signed-in account. */
                link?: string;
                /** @description `true`: re-authenticate the signed-in user through the provider (step-up), with a fresh login there. */
                reauthenticate?: string;
            };
            header?: never;
            path: {
                provider: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description To the provider; or, linking from a stale session, to the web app with `?error=reauthentication_required`. */
            302: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    OidcController_callback_v1: {
        parameters: {
            query?: {
                code?: string;
                state?: string;
                error?: string;
                iss?: string;
            };
            header?: never;
            path: {
                provider: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description To the web app; a refused step-up (`reauthenticate=true`) with `?error=reauthentication_failed`. */
            302: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    OidcController_identities_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            provider: string;
                            email: string | null;
                            /** Format: date-time */
                            createdAt: string;
                        }[];
                    };
                };
            };
        };
    };
    OidcController_unlink_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                provider: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description `reauthentication_required`: no sign-in in the last REAUTHENTICATION_MAX_AGE_MINUTES: re-authenticate (POST /auth/reauthenticate, or sign in again: the problem lists `methods`) and retry. Or not allowed: your permissions, or acting as another user. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description `last_sign_in_method`: it is your only way to sign in (no password, passkey or other provider): set a password or register a passkey first. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    TokensController_issue_v1: {
        parameters: {
            query?: never;
            header?: {
                /** @description The challenge token (Cloudflare Turnstile, widget action `sign-in`), when GET /auth/methods lists a captcha: always, or once a 403 `captcha_required` asked for one. */
                "X-Captcha-Token"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @example ada@example.com */
                    email: string;
                    password: string;
                    /** @description With two-factor on: a code from the app. */
                    code?: string;
                    recoveryCode?: string;
                    /**
                     * Format: uuid
                     * @description The tenant the tokens act in (one of GET /auth/tenants); left out: the last one chosen. To act in another, sign in again with it.
                     */
                    tenantId?: string;
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description A JWT: `Authorization: Bearer …`. */
                        accessToken: string;
                        /** @description Single use: POST /auth/token/refresh. */
                        refreshToken: string;
                        /** @description Seconds until the access token expires. */
                        expiresIn: number;
                    };
                };
            };
            /** @description Invalid credentials, or a second factor is required or wrong. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description `captcha_required`: solve the challenge (the problem names `provider`, `siteKey` and `action`) and send its token in `X-Captcha-Token`. `captcha_invalid`: the token was refused (`reason`: `invalid`, `duplicate`, `hostname`, `action`); render the widget again. Provider down: 503 `captcha_unavailable` (fail-closed), or 429 `rate_limited` past the fail-open allowance. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    TokensController_refresh_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    refreshToken: string;
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description A JWT: `Authorization: Bearer …`. */
                        accessToken: string;
                        /** @description Single use: POST /auth/token/refresh. */
                        refreshToken: string;
                        /** @description Seconds until the access token expires. */
                        expiresIn: number;
                    };
                };
            };
            /** @description Unknown, expired or reused refresh token. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    TokensController_revoke_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    refreshToken: string;
                };
            };
        };
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    ReauthenticationController_status_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description How you can re-authenticate. In place, with POST /auth/reauthenticate: `password`; `totp` (a code alone, for an account without a password); `passkey` (an assertion from POST /auth/passkeys/reauthentication/options). By signing in again, which counts as well: `magic-link` (POST /auth/magic-link), `oidc:<provider>` (GET /auth/oidc/{provider}/login?reauthenticate=true: the provider is asked to authenticate you again). */
                        methods: string[];
                        /** @description In place, a code (or a recoveryCode) goes with the password (and with a passkey from a token client). */
                        mfaRequired: boolean;
                        /**
                         * Format: date-time
                         * @description When you last signed in or re-authenticated here; null: unknown.
                         */
                        authenticatedAt: string | null;
                        /**
                         * Format: date-time
                         * @description Until when the sensitive routes accept it (REAUTHENTICATION_MAX_AGE_MINUTES, the default window: a route may ask for a shorter one); past, or null (unknown, or acting as another user), they want a re-authentication.
                         */
                        recentUntil: string | null;
                        /** @description The default window, in seconds. */
                        maxAge: number;
                    };
                };
            };
        };
    };
    ReauthenticationController_reauthenticate_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description Required when the account has a password, unless a passkey is sent. */
                    password?: string;
                    /** @description With two-factor on: a code from the app (or a recoveryCode). Not with a passkey from a session (it verified you); a token client sends one with its passkey too. */
                    code?: string;
                    recoveryCode?: string;
                    /** @description Instead of the password: the assertion of one of your passkeys, made from the options of POST /auth/passkeys/reauthentication/options (user verification required). */
                    passkey?: {
                        id: string;
                        rawId: string;
                        /** @enum {string} */
                        type: "public-key";
                        response: {
                            clientDataJSON: string;
                            authenticatorData: string;
                            signature: string;
                            userHandle?: string;
                        };
                        /**
                         * @description `clientExtensionResults` of the credential, usually `{}`.
                         * @default {}
                         */
                        clientExtensionResults?: {
                            [key: string]: unknown;
                        };
                        /** @enum {string} */
                        authenticatorAttachment?: "platform" | "cross-platform";
                    };
                    /** @description A token client: your current refresh token, revoked (its whole family) once the new tokens are issued. Unknown: ignored. */
                    refreshToken?: string;
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: date-time */
                        authenticatedAt: string;
                        /** Format: date-time */
                        recentUntil: string;
                        /** @description A token client's new tokens: use them from now on. The old family keeps its time; it was revoked when the request sent its refreshToken, else revoke it (POST /auth/token/revoke). */
                        tokens?: {
                            accessToken: string;
                            refreshToken: string;
                            expiresIn: number;
                        };
                    };
                };
            };
            /** @description The password or the code is missing (validation_failed). */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description `reauthentication_failed`: a wrong password or code; or acting as another user. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description `reauthentication_unavailable`: no password and no two-factor: sign in again with one of `methods`. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description More than 5 attempts from this address, or 10 for this account, in 15 minutes. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    PasskeysController_list_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            id: string;
                            name: string;
                            /**
                             * @description `multiDevice`: a synced passkey (iCloud Keychain, Google Password Manager…); `singleDevice`: bound to one authenticator (a security key).
                             * @enum {string}
                             */
                            deviceType: "singleDevice" | "multiDevice";
                            /** @description Synced to the user's other devices now. */
                            backedUp: boolean;
                            /** @description How the browser reaches it: `internal`, `hybrid`, `usb`, `nfc`, `ble`. */
                            transports: string[];
                            /** Format: date-time */
                            lastUsedAt: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: date-time */
                            updatedAt: string;
                        }[];
                    };
                };
            };
        };
    };
    PasskeysController_register_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description What you call it: "MacBook", "YubiKey". */
                    name: string;
                    response: {
                        id: string;
                        rawId: string;
                        /** @enum {string} */
                        type: "public-key";
                        response: {
                            clientDataJSON: string;
                            attestationObject: string;
                            transports?: string[];
                            authenticatorData?: string;
                            publicKey?: string;
                            publicKeyAlgorithm?: number;
                        };
                        /**
                         * @description `clientExtensionResults` of the credential, usually `{}`.
                         * @default {}
                         */
                        clientExtensionResults?: {
                            [key: string]: unknown;
                        };
                        /** @enum {string} */
                        authenticatorAttachment?: "platform" | "cross-platform";
                    };
                };
            };
        };
        responses: {
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        name: string;
                        /**
                         * @description `multiDevice`: a synced passkey (iCloud Keychain, Google Password Manager…); `singleDevice`: bound to one authenticator (a security key).
                         * @enum {string}
                         */
                        deviceType: "singleDevice" | "multiDevice";
                        /** @description Synced to the user's other devices now. */
                        backedUp: boolean;
                        /** @description How the browser reaches it: `internal`, `hybrid`, `usb`, `nfc`, `ble`. */
                        transports: string[];
                        /** Format: date-time */
                        lastUsedAt: string | null;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: date-time */
                        updatedAt: string;
                    };
                };
            };
            /** @description `passkey_invalid` with `reason`: the challenge is unknown, used or expired (`challenge`), was made for another session or origin, the response is not for this site, or the authenticator did not verify its user (`user-verification`). */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description `reauthentication_required`: no sign-in in the last REAUTHENTICATION_MAX_AGE_MINUTES: re-authenticate (POST /auth/reauthenticate, or sign in again: the problem lists `methods`) and retry. Or not allowed: your permissions, or acting as another user. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description `passkey_registered`: this credential is registered already. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    PasskeysController_registrationOptions_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        rp: {
                            id?: string;
                            name: string;
                        };
                        user: {
                            id: string;
                            name: string;
                            displayName: string;
                        };
                        challenge: string;
                        pubKeyCredParams: {
                            /** @enum {string} */
                            type: "public-key";
                            alg: number;
                        }[];
                        timeout?: number;
                        excludeCredentials?: {
                            id: string;
                            /** @enum {string} */
                            type: "public-key";
                            transports?: string[];
                        }[];
                        authenticatorSelection?: {
                            authenticatorAttachment?: string;
                            residentKey?: string;
                            requireResidentKey?: boolean;
                            userVerification?: string;
                        };
                        attestation?: string;
                        extensions?: {
                            [key: string]: unknown;
                        };
                        hints?: string[];
                    };
                };
            };
            /** @description `reauthentication_required`: no sign-in in the last REAUTHENTICATION_MAX_AGE_MINUTES: re-authenticate (POST /auth/reauthenticate, or sign in again: the problem lists `methods`) and retry. Or not allowed: your permissions, or acting as another user. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Passkeys are off (PASSKEYS=off). */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    PasskeysController_remove_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description `reauthentication_required`: no sign-in in the last REAUTHENTICATION_MAX_AGE_MINUTES: re-authenticate (POST /auth/reauthenticate, or sign in again: the problem lists `methods`) and retry. Or not allowed: your permissions, or acting as another user. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description `last_sign_in_method`: it is your only way to sign in. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    PasskeysController_rename_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    name: string;
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        name: string;
                        /**
                         * @description `multiDevice`: a synced passkey (iCloud Keychain, Google Password Manager…); `singleDevice`: bound to one authenticator (a security key).
                         * @enum {string}
                         */
                        deviceType: "singleDevice" | "multiDevice";
                        /** @description Synced to the user's other devices now. */
                        backedUp: boolean;
                        /** @description How the browser reaches it: `internal`, `hybrid`, `usb`, `nfc`, `ble`. */
                        transports: string[];
                        /** Format: date-time */
                        lastUsedAt: string | null;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: date-time */
                        updatedAt: string;
                    };
                };
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    PasskeysController_signInOptions_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * @description The account whose passkeys to offer. Without it, the browser offers the passkeys it has for this site (usernameless; `useBrowserAutofill`).
                     * @example ada@example.com
                     */
                    email?: string;
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        challenge: string;
                        timeout?: number;
                        rpId?: string;
                        allowCredentials?: {
                            id: string;
                            /** @enum {string} */
                            type: "public-key";
                            transports?: string[];
                        }[];
                        userVerification?: string;
                        extensions?: {
                            [key: string]: unknown;
                        };
                        hints?: string[];
                    };
                };
            };
            /** @description Passkeys are off (PASSKEYS=off). */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description More than 30 passkey sign-in requests (options and answers) from this address in 15 minutes. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    PasskeysController_signIn_v1: {
        parameters: {
            query?: never;
            header?: {
                /** @description The challenge token (Cloudflare Turnstile, widget action `sign-in`), when GET /auth/methods lists a captcha: always, or once a 403 `captcha_required` asked for one. */
                "X-Captcha-Token"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    response: {
                        id: string;
                        rawId: string;
                        /** @enum {string} */
                        type: "public-key";
                        response: {
                            clientDataJSON: string;
                            authenticatorData: string;
                            signature: string;
                            userHandle?: string;
                        };
                        /**
                         * @description `clientExtensionResults` of the credential, usually `{}`.
                         * @default {}
                         */
                        clientExtensionResults?: {
                            [key: string]: unknown;
                        };
                        /** @enum {string} */
                        authenticatorAttachment?: "platform" | "cross-platform";
                    };
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        signedIn: boolean;
                        /** @description true: send a code to POST /auth/mfa/verify to finish signing in. */
                        mfaRequired: boolean;
                        redirectTo?: string;
                    };
                };
            };
            /** @description The challenge is unknown, used or expired; the credential is unknown; or the assertion does not verify. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description `captcha_required`: solve the challenge (the problem names `provider`, `siteKey` and `action`) and send its token in `X-Captcha-Token`. `captcha_invalid`: the token was refused (`reason`: `invalid`, `duplicate`, `hostname`, `action`); render the widget again. Provider down: 503 `captcha_unavailable` (fail-closed), or 429 `rate_limited` past the fail-open allowance. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description More than 10 attempts from this address in 15 minutes, or 30 passkey sign-in requests. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    PasskeysController_issueTokens_v1: {
        parameters: {
            query?: never;
            header?: {
                /** @description The challenge token (Cloudflare Turnstile, widget action `sign-in`), when GET /auth/methods lists a captcha: always, or once a 403 `captcha_required` asked for one. */
                "X-Captcha-Token"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    response: {
                        id: string;
                        rawId: string;
                        /** @enum {string} */
                        type: "public-key";
                        response: {
                            clientDataJSON: string;
                            authenticatorData: string;
                            signature: string;
                            userHandle?: string;
                        };
                        /**
                         * @description `clientExtensionResults` of the credential, usually `{}`.
                         * @default {}
                         */
                        clientExtensionResults?: {
                            [key: string]: unknown;
                        };
                        /** @enum {string} */
                        authenticatorAttachment?: "platform" | "cross-platform";
                    };
                    /** @description With two-factor on: a code from the app (or a recoveryCode). */
                    code?: string;
                    recoveryCode?: string;
                    /**
                     * Format: uuid
                     * @description The tenant the tokens act in (one of GET /auth/tenants); left out: the last one chosen. To act in another, sign in again with it.
                     */
                    tenantId?: string;
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description A JWT: `Authorization: Bearer …`. */
                        accessToken: string;
                        /** @description Single use: POST /auth/token/refresh. */
                        refreshToken: string;
                        expiresIn: number;
                    };
                };
            };
            /** @description The assertion was refused, or a second factor is required or wrong (`mfa_required`). */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description `captcha_required`: solve the challenge (the problem names `provider`, `siteKey` and `action`) and send its token in `X-Captcha-Token`. `captcha_invalid`: the token was refused (`reason`: `invalid`, `duplicate`, `hostname`, `action`); render the widget again. Provider down: 503 `captcha_unavailable` (fail-closed), or 429 `rate_limited` past the fail-open allowance. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description More than 10 attempts from this address in 15 minutes, or 30 passkey sign-in requests. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    PasskeysController_reauthenticationOptions_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        challenge: string;
                        timeout?: number;
                        rpId?: string;
                        allowCredentials?: {
                            id: string;
                            /** @enum {string} */
                            type: "public-key";
                            transports?: string[];
                        }[];
                        userVerification?: string;
                        extensions?: {
                            [key: string]: unknown;
                        };
                        hints?: string[];
                    };
                };
            };
            /** @description Passkeys are off (PASSKEYS=off). */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    AccessController_catalog_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        subjects: {
                            /** @example Note */
                            subject: string;
                            label: string;
                            /** @description The fields a permission may grant one by one. */
                            fields: {
                                field: string;
                                label: string;
                                /** @description Redacted in the audit log and revisions. */
                                sensitive: boolean;
                            }[];
                            actions: {
                                /** @example read */
                                action: string;
                                label: string;
                                conditions: {
                                    key: string;
                                    label: string;
                                    description: string;
                                    /** @description The parameter the condition takes, if any. */
                                    input: {
                                        name: string;
                                        label: string;
                                        /** @enum {string} */
                                        type: "text" | "cents";
                                    } | null;
                                }[];
                            }[];
                        }[];
                        systemJobs: {
                            key: string;
                            /** @description `system:<key>`: the actor of its audit entries. */
                            actor: string;
                            label: string;
                            description: string;
                            permissions: {
                                subject: string;
                                action: string;
                                conditions: {
                                    /** @example mine */
                                    key: string;
                                    params?: {
                                        [key: string]: unknown;
                                    };
                                }[];
                                fields: string[] | null;
                            }[];
                        }[];
                    };
                };
            };
            /** @description No session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    AccessController_roles_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** Format: uuid */
                            id: string;
                            /** Format: uuid */
                            tenantId: string;
                            /** @description The code's name of a built-in or seeded role (`administrator`, `editor`); null for roles made through the API. */
                            key: string | null;
                            name: string;
                            description: string;
                            /** @description Built in: never edited nor deleted. */
                            system: boolean;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: date-time */
                            updatedAt: string;
                            permissions: {
                                subject: string;
                                action: string;
                                conditions: {
                                    /** @example mine */
                                    key: string;
                                    params?: {
                                        [key: string]: unknown;
                                    };
                                }[];
                                /** @description Only these restrictable fields; absent: all of them. */
                                fields?: string[];
                            }[];
                            /** @description The users who hold it. */
                            members: number;
                        }[];
                    };
                };
            };
            /** @description No session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    AccessController_createRole_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    name: string;
                    description?: string;
                    permissions: {
                        /** @example Note */
                        subject: string;
                        /** @example read */
                        action: string;
                        conditions: {
                            /** @example mine */
                            key: string;
                            params?: {
                                [key: string]: unknown;
                            };
                        }[];
                        /** @description Only these restrictable fields of the subject (GET /access/catalog); [] for none of them; leave out for all. */
                        fields?: string[];
                    }[];
                };
            };
        };
        responses: {
            /** @description The new role id. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                    };
                };
            };
            /** @description No session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description A role with this name exists. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    AccessController_role_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        /** Format: uuid */
                        tenantId: string;
                        /** @description The code's name of a built-in or seeded role (`administrator`, `editor`); null for roles made through the API. */
                        key: string | null;
                        name: string;
                        description: string;
                        /** @description Built in: never edited nor deleted. */
                        system: boolean;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: date-time */
                        updatedAt: string;
                        permissions: {
                            subject: string;
                            action: string;
                            conditions: {
                                /** @example mine */
                                key: string;
                                params?: {
                                    [key: string]: unknown;
                                };
                            }[];
                            /** @description Only these restrictable fields; absent: all of them. */
                            fields?: string[];
                        }[];
                        /** @description The users who hold it. */
                        members: number;
                    };
                };
            };
            /** @description No session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    AccessController_deleteRole_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The built-in Administrator role. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    AccessController_updateRole_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    name: string;
                    description?: string;
                    permissions: {
                        /** @example Note */
                        subject: string;
                        /** @example read */
                        action: string;
                        conditions: {
                            /** @example mine */
                            key: string;
                            params?: {
                                [key: string]: unknown;
                            };
                        }[];
                        /** @description Only these restrictable fields of the subject (GET /access/catalog); [] for none of them; leave out for all. */
                        fields?: string[];
                    }[];
                };
            };
        };
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The built-in Administrator role. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    AccessController_users_v1: {
        parameters: {
            query?: {
                limit?: number;
                /** @description `nextCursor` of the previous page (the same `sort`). */
                cursor?: string;
                /** @description Pages by number instead of cursor: 1 for the first, `limit` rows a page. Example: `page=3&limit=20&count=true`. */
                page?: number;
                /** @description true: add `total` (counted up to a cap; `totalCapped`). */
                count?: "true" | "false";
                lang?: string;
                /** @description Filter: email = */
                email?: string;
                /** @description Filter: email contains */
                "email.contains"?: string;
                /** @description Filter: email startsWith */
                "email.startsWith"?: string;
                /** @description Filter: email endsWith */
                "email.endsWith"?: string;
                /** @description Filter: name contains */
                "name.contains"?: string;
                /** @description Filter: name startsWith */
                "name.startsWith"?: string;
                /** @description Filter: active = */
                active?: "true" | "false";
                /** @description Filter: emailVerified = */
                emailVerified?: "true" | "false";
                /** @description Filter: teamId = */
                teamId?: string;
                /** @description Filter: teamId in */
                "teamId.in"?: string;
                /** @description Filter: createdAt gt */
                "createdAt.gt"?: string;
                /** @description Filter: createdAt gte */
                "createdAt.gte"?: string;
                /** @description Filter: createdAt lt */
                "createdAt.lt"?: string;
                /** @description Filter: createdAt lte */
                "createdAt.lte"?: string;
                /** @description Filter: createdAt between */
                "createdAt.between"?: string;
                /** @description Filter: updatedAt gt */
                "updatedAt.gt"?: string;
                /** @description Filter: updatedAt gte */
                "updatedAt.gte"?: string;
                /** @description Filter: updatedAt lt */
                "updatedAt.lt"?: string;
                /** @description Filter: updatedAt lte */
                "updatedAt.lte"?: string;
                /** @description Filter: updatedAt between */
                "updatedAt.between"?: string;
                /** @description Conditions in and/or groups, JSON: a condition { field, op, value } or a group { "and": [...] } / { "or": [...] }, 3 groups deep and 30 conditions at most. Example: {"or":[{"field":"email","op":"eq","value":…},{…}]}. Fields and operators: email (eq, contains, startsWith, endsWith); name (contains, startsWith); active (eq); emailVerified (eq); teamId (eq, in); createdAt (gt, gte, lt, lte, between); updatedAt (gt, gte, lt, lte, between). */
                filter?: string;
                /** @description The order: fields comma-separated, - for descending; the newest first on ties. Example: -email. Sortable: email, name, createdAt, updatedAt. */
                sort?: string;
                /** @description Only these fields in each item, comma-separated; id always comes. Example: kind,email. Fields: id, kind, email, name, emailVerified, locale, timezone, active, hasPassword, createdAt, updatedAt, roleIds, roles, teamIds. */
                fields?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** Format: uuid */
                            id: string;
                            /** @enum {string} */
                            kind: "user";
                            email: string;
                            name: string;
                            emailVerified: boolean;
                            /** @description The language they chose, or null. */
                            locale: string | null;
                            /** @description Their IANA time zone, or null (APP_TIMEZONE). */
                            timezone: string | null;
                            /** @description The membership in this tenant and the account, together. */
                            active: boolean;
                            /** @description false: invited, or signs in only with a provider. */
                            hasPassword: boolean;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: date-time */
                            updatedAt: string;
                            roleIds: string[];
                            roles: {
                                /** Format: uuid */
                                roleId: string;
                                /**
                                 * Format: date-time
                                 * @description When the grant ends; null: never.
                                 */
                                expiresAt: string | null;
                            }[];
                            teamIds: string[];
                        }[];
                        /** @description Pass it as `cursor` for the next page; null: no more (and with `page`). */
                        nextCursor: string | null;
                        /** @description With `page`: this page. */
                        page?: number;
                        /** @description With `page`: the next page; null: no more. */
                        nextPage?: number | null;
                        /** @description With `page` and `count=true`: ceil(total / limit). */
                        pageCount?: number;
                        /** @description With `count=true`: the rows matching the filters, all pages; the cap when totalCapped. */
                        total?: number;
                        /** @description true: there are more than `total` (show "10,000+"). */
                        totalCapped?: boolean;
                    };
                };
            };
            /** @description No session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    AccessController_createUser_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: email */
                    email: string;
                    /** @description The name a new account starts with; its owner changes it. */
                    name?: string;
                    /** @default [] */
                    roleIds?: string[];
                    /** @description When each grant ends, by role id (temporary access); the others never do. */
                    roleExpiresAt?: {
                        [key: string]: string;
                    };
                    /** @description The teams the user belongs to. */
                    teamIds?: string[];
                };
            };
        };
        responses: {
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        email: string;
                        /** Format: date-time */
                        expiresAt: string;
                    };
                };
            };
            /** @description No session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description `reauthentication_required`: no sign-in in the last REAUTHENTICATION_MAX_AGE_MINUTES: re-authenticate (POST /auth/reauthenticate, or sign in again: the problem lists `methods`) and retry. Or not allowed: your permissions, or acting as another user. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    AccessController_user_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        /** @enum {string} */
                        kind: "user";
                        email: string;
                        name: string;
                        emailVerified: boolean;
                        /** @description The language they chose, or null. */
                        locale: string | null;
                        /** @description Their IANA time zone, or null (APP_TIMEZONE). */
                        timezone: string | null;
                        /** @description The membership in this tenant and the account, together. */
                        active: boolean;
                        /** @description false: invited, or signs in only with a provider. */
                        hasPassword: boolean;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: date-time */
                        updatedAt: string;
                        roleIds: string[];
                        roles: {
                            /** Format: uuid */
                            roleId: string;
                            /**
                             * Format: date-time
                             * @description When the grant ends; null: never.
                             */
                            expiresAt: string | null;
                        }[];
                        teamIds: string[];
                    };
                };
            };
            /** @description No session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not a member of this tenant. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    AccessController_updateUser_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description The membership in this tenant, not the account. */
                    active?: boolean;
                    roleIds?: string[];
                    /** @description When each grant ends, by role id (temporary access); the others never do. */
                    roleExpiresAt?: {
                        [key: string]: string;
                    };
                    teamIds?: string[];
                };
            };
        };
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description `reauthentication_required`: no sign-in in the last REAUTHENTICATION_MAX_AGE_MINUTES: re-authenticate (POST /auth/reauthenticate, or sign in again: the problem lists `methods`) and retry. Or not allowed: your permissions, or acting as another user. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Deactivating yourself, or removing the last administrator. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    AccessController_invitations_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** Format: uuid */
                            id: string;
                            email: string;
                            /** Format: date-time */
                            expiresAt: string;
                            name: string | null;
                            roleIds: string[];
                            /** @description When each grant ends once accepted, by role id; the others never do. */
                            roleExpiresAt: {
                                [key: string]: string;
                            };
                            teamIds: string[];
                            invitedBy: string;
                            expired: boolean;
                            /** Format: date-time */
                            createdAt: string;
                        }[];
                    };
                };
            };
            /** @description No session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    AccessController_resendInvitation_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        email: string;
                        /** Format: date-time */
                        expiresAt: string;
                    };
                };
            };
            /** @description No session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description `reauthentication_required`: no sign-in in the last REAUTHENTICATION_MAX_AGE_MINUTES: re-authenticate (POST /auth/reauthenticate, or sign in again: the problem lists `methods`) and retry. Or not allowed: your permissions, or acting as another user. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No pending invitation of this id. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    AccessController_revokeInvitation_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    AccessController_impersonate_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description `reauthentication_required`: no sign-in in the last REAUTHENTICATION_MAX_AGE_MINUTES: re-authenticate (POST /auth/reauthenticate, or sign in again: the problem lists `methods`) and retry. Or not allowed: your permissions, or acting as another user. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description feature_off: IMPERSONATION=off in this deployment. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Yourself, or already impersonating. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    AccessController_principalsList_v1: {
        parameters: {
            query?: {
                limit?: number;
                /** @description `nextCursor` of the previous page (the same `sort`). */
                cursor?: string;
                /** @description Pages by number instead of cursor: 1 for the first, `limit` rows a page. Example: `page=3&limit=20&count=true`. */
                page?: number;
                /** @description true: add `total` (counted up to a cap; `totalCapped`). */
                count?: "true" | "false";
                lang?: string;
                /** @description Filter: q = */
                q?: string;
                /** @description Filter: kind = */
                kind?: "user" | "client";
                /** @description Filter: active = */
                active?: "true" | "false";
                /** @description Filter: label contains */
                "label.contains"?: string;
                /** @description Filter: label startsWith */
                "label.startsWith"?: string;
                /** @description Conditions in and/or groups, JSON: a condition { field, op, value } or a group { "and": [...] } / { "or": [...] }, 3 groups deep and 30 conditions at most. Example: {"or":[{"field":"q","op":"eq","value":…},{…}]}. Fields and operators: q (eq); kind (eq); active (eq); label (contains, startsWith). */
                filter?: string;
                /** @description The order: fields comma-separated, - for descending; the newest first on ties. Example: -label. Sortable: label. */
                sort?: string;
                /** @description Only these fields in each item, comma-separated; id always comes. Example: key,kind. Fields: id, key, kind, label, email, active. */
                fields?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** Format: uuid */
                            id: string;
                            /**
                             * @description The principal's key: `user:<id>` or `client:<id>`, as `scopeId` of a setting's user scope and `actor` filters take it.
                             * @example user:0190a1b2-0000-7000-8000-000000000000
                             */
                            key: string;
                            /** @enum {string} */
                            kind: "user" | "client";
                            /** @description The user's name, or the client's. */
                            label: string;
                            /** @description A user's address; null for a client. */
                            email: string | null;
                            /** @description A user: the membership in this tenant and the account; a client: not revoked. */
                            active: boolean;
                        }[];
                        /** @description Pass it as `cursor` for the next page; null: no more (and with `page`). */
                        nextCursor: string | null;
                        /** @description With `page`: this page. */
                        page?: number;
                        /** @description With `page`: the next page; null: no more. */
                        nextPage?: number | null;
                        /** @description With `page` and `count=true`: ceil(total / limit). */
                        pageCount?: number;
                        /** @description With `count=true`: the rows matching the filters, all pages; the cap when totalCapped. */
                        total?: number;
                        /** @description true: there are more than `total` (show "10,000+"). */
                        totalCapped?: boolean;
                    };
                };
            };
            /** @description No session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    AccessController_apiClients_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** Format: uuid */
                            id: string;
                            name: string;
                            active: boolean;
                            /** @description Requests a UTC day (GET /v1/access/clients/{id}/usage); null: none. */
                            dailyQuota: number | null;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: date-time */
                            updatedAt: string;
                            /** @description Never the keys themselves, nor their hashes. */
                            keys: {
                                /** Format: uuid */
                                id: string;
                                /** @description The key's public id: the middle of <prefix>_<id>_<secret>. */
                                keyId: string;
                                /** Format: date-time */
                                createdAt: string;
                                /** Format: date-time */
                                expiresAt: string | null;
                                /** Format: date-time */
                                revokedAt: string | null;
                                /**
                                 * Format: date-time
                                 * @description Recorded at most once a minute.
                                 */
                                lastUsedAt: string | null;
                            }[];
                            roles: {
                                /** Format: uuid */
                                roleId: string;
                                /** Format: date-time */
                                expiresAt: string | null;
                            }[];
                        }[];
                    };
                };
            };
            /** @description No session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description feature_off: API_CLIENTS=off in this deployment. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    AccessController_createClient_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    name: string;
                    /** @description Requests a UTC day; past it, 429 quota_exceeded until midnight UTC. null: no quota. */
                    dailyQuota?: number | null;
                    /**
                     * @description Roles on top of what every client may do (clientPermissions).
                     * @default []
                     */
                    roleIds?: string[];
                    /** @description When each grant ends, by role id (temporary access); the others never do. */
                    roleExpiresAt?: {
                        [key: string]: string;
                    };
                    /**
                     * Format: date-time
                     * @description When the first key stops working; leave out for never.
                     */
                    keyExpiresAt?: string;
                };
            };
        };
        responses: {
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        name: string;
                        active: boolean;
                        /** @description Requests a UTC day (GET /v1/access/clients/{id}/usage); null: none. */
                        dailyQuota: number | null;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: date-time */
                        updatedAt: string;
                        /** @description Never the keys themselves, nor their hashes. */
                        keys: {
                            /** Format: uuid */
                            id: string;
                            /** @description The key's public id: the middle of <prefix>_<id>_<secret>. */
                            keyId: string;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: date-time */
                            expiresAt: string | null;
                            /** Format: date-time */
                            revokedAt: string | null;
                            /**
                             * Format: date-time
                             * @description Recorded at most once a minute.
                             */
                            lastUsedAt: string | null;
                        }[];
                        roles: {
                            /** Format: uuid */
                            roleId: string;
                            /** Format: date-time */
                            expiresAt: string | null;
                        }[];
                        /** @description The API key: `Authorization: Bearer <key>`. Shown this once. */
                        key: string;
                    };
                };
            };
            /** @description No session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description `reauthentication_required`: no sign-in in the last REAUTHENTICATION_MAX_AGE_MINUTES: re-authenticate (POST /auth/reauthenticate, or sign in again: the problem lists `methods`) and retry. Or not allowed: your permissions, or acting as another user. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description feature_off: API_CLIENTS=off in this deployment. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description An API client with this name exists. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    AccessController_apiClient_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        name: string;
                        active: boolean;
                        /** @description Requests a UTC day (GET /v1/access/clients/{id}/usage); null: none. */
                        dailyQuota: number | null;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: date-time */
                        updatedAt: string;
                        /** @description Never the keys themselves, nor their hashes. */
                        keys: {
                            /** Format: uuid */
                            id: string;
                            /** @description The key's public id: the middle of <prefix>_<id>_<secret>. */
                            keyId: string;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: date-time */
                            expiresAt: string | null;
                            /** Format: date-time */
                            revokedAt: string | null;
                            /**
                             * Format: date-time
                             * @description Recorded at most once a minute.
                             */
                            lastUsedAt: string | null;
                        }[];
                        roles: {
                            /** Format: uuid */
                            roleId: string;
                            /** Format: date-time */
                            expiresAt: string | null;
                        }[];
                    };
                };
            };
            /** @description No session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description feature_off: API_CLIENTS=off in this deployment. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    AccessController_deleteClient_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description feature_off: API_CLIENTS=off in this deployment. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    AccessController_updateClient_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description false: every key is refused from the next request. */
                    active?: boolean;
                    /** @description Requests a UTC day; past it, 429 quota_exceeded until midnight UTC. null: no quota. */
                    dailyQuota?: number | null;
                    roleIds?: string[];
                    /** @description When each grant ends, by role id (temporary access); the others never do. */
                    roleExpiresAt?: {
                        [key: string]: string;
                    };
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        name: string;
                        active: boolean;
                        /** @description Requests a UTC day (GET /v1/access/clients/{id}/usage); null: none. */
                        dailyQuota: number | null;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: date-time */
                        updatedAt: string;
                        /** @description Never the keys themselves, nor their hashes. */
                        keys: {
                            /** Format: uuid */
                            id: string;
                            /** @description The key's public id: the middle of <prefix>_<id>_<secret>. */
                            keyId: string;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: date-time */
                            expiresAt: string | null;
                            /** Format: date-time */
                            revokedAt: string | null;
                            /**
                             * Format: date-time
                             * @description Recorded at most once a minute.
                             */
                            lastUsedAt: string | null;
                        }[];
                        roles: {
                            /** Format: uuid */
                            roleId: string;
                            /** Format: date-time */
                            expiresAt: string | null;
                        }[];
                    };
                };
            };
            /** @description No session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description `reauthentication_required`: no sign-in in the last REAUTHENTICATION_MAX_AGE_MINUTES: re-authenticate (POST /auth/reauthenticate, or sign in again: the problem lists `methods`) and retry. Or not allowed: your permissions, or acting as another user. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description feature_off: API_CLIENTS=off in this deployment. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    AccessController_rotateClient_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * @description How long the current keys keep working, so the system can switch: 0 stops them now.
                     * @default 0
                     */
                    graceSeconds?: number;
                    /**
                     * Format: date-time
                     * @description When the new key stops working.
                     */
                    expiresAt?: string;
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        name: string;
                        active: boolean;
                        /** @description Requests a UTC day (GET /v1/access/clients/{id}/usage); null: none. */
                        dailyQuota: number | null;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: date-time */
                        updatedAt: string;
                        /** @description Never the keys themselves, nor their hashes. */
                        keys: {
                            /** Format: uuid */
                            id: string;
                            /** @description The key's public id: the middle of <prefix>_<id>_<secret>. */
                            keyId: string;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: date-time */
                            expiresAt: string | null;
                            /** Format: date-time */
                            revokedAt: string | null;
                            /**
                             * Format: date-time
                             * @description Recorded at most once a minute.
                             */
                            lastUsedAt: string | null;
                        }[];
                        roles: {
                            /** Format: uuid */
                            roleId: string;
                            /** Format: date-time */
                            expiresAt: string | null;
                        }[];
                        /** @description The API key: `Authorization: Bearer <key>`. Shown this once. */
                        key: string;
                    };
                };
            };
            /** @description No session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description `reauthentication_required`: no sign-in in the last REAUTHENTICATION_MAX_AGE_MINUTES: re-authenticate (POST /auth/reauthenticate, or sign in again: the problem lists `methods`) and retry. Or not allowed: your permissions, or acting as another user. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description feature_off: API_CLIENTS=off in this deployment. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    AccessController_revokeKey_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                keyId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description feature_off: API_CLIENTS=off in this deployment. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    AccessController_auditLog_v1: {
        parameters: {
            query?: {
                limit?: number;
                /** @description `nextCursor` of the previous page (the same `sort`). */
                cursor?: string;
                /** @description Pages by number instead of cursor: 1 for the first, `limit` rows a page. Example: `page=3&limit=20&count=true`. */
                page?: number;
                /** @description true: add `total` (counted up to a cap; `totalCapped`). */
                count?: "true" | "false";
                lang?: string;
                /** @description Filter: action = */
                action?: string;
                /** @description Filter: action in */
                "action.in"?: string;
                /** @description Filter: action notIn */
                "action.notIn"?: string;
                /** @description Filter: action startsWith */
                "action.startsWith"?: string;
                /** @description Filter: actor = */
                actor?: string;
                /** @description Filter: actor in */
                "actor.in"?: string;
                /** @description Filter: targetType = */
                targetType?: string;
                /** @description Filter: targetType in */
                "targetType.in"?: string;
                /** @description Filter: targetType isNull */
                "targetType.isNull"?: "true" | "false";
                /** @description Filter: targetId = */
                targetId?: string;
                /** @description Filter: at gt */
                "at.gt"?: string;
                /** @description Filter: at gte */
                "at.gte"?: string;
                /** @description Filter: at lt */
                "at.lt"?: string;
                /** @description Filter: at lte */
                "at.lte"?: string;
                /** @description Filter: at between */
                "at.between"?: string;
                /** @description Conditions in and/or groups, JSON: a condition { field, op, value } or a group { "and": [...] } / { "or": [...] }, 3 groups deep and 30 conditions at most. Example: {"or":[{"field":"action","op":"eq","value":…},{…}]}. Fields and operators: action (eq, in, notIn, startsWith); actor (eq, in); targetType (eq, in, isNull); targetId (eq); at (gt, gte, lt, lte, between). */
                filter?: string;
                /** @description The order: fields comma-separated, - for descending; the newest first on ties. Example: -action. Sortable: action, at. */
                sort?: string;
                /** @description Only these fields in each item, comma-separated; id always comes. Example: at,actor. Fields: id, at, actor, actorLabel, action, targetType, targetId, details, ip. */
                fields?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** Format: uuid */
                            id: string;
                            /** Format: uuid */
                            tenantId: string | null;
                            /** Format: date-time */
                            at: string;
                            /** @description `user:<id>`, `client:<id>`, `system:<key>` or `anonymous`. */
                            actor: string;
                            actorLabel: string;
                            /** @example note.created */
                            action: string;
                            targetType: string | null;
                            targetId: string | null;
                            details: {
                                [key: string]: unknown;
                            } | null;
                            ip: string | null;
                        }[];
                        /** @description Pass it as `cursor` for the next page; null: no more (and with `page`). */
                        nextCursor: string | null;
                        /** @description With `page`: this page. */
                        page?: number;
                        /** @description With `page`: the next page; null: no more. */
                        nextPage?: number | null;
                        /** @description With `page` and `count=true`: ceil(total / limit). */
                        pageCount?: number;
                        /** @description With `count=true`: the rows matching the filters, all pages; the cap when totalCapped. */
                        total?: number;
                        /** @description true: there are more than `total` (show "10,000+"). */
                        totalCapped?: boolean;
                    };
                };
            };
            /** @description No session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    TeamsController_list_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** Format: uuid */
                            id: string;
                            name: string;
                            /** Format: uuid */
                            parentId: string | null;
                            /** @description 0 for a top-level team. */
                            depth: number;
                            members: number;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: date-time */
                            updatedAt: string;
                        }[];
                    };
                };
            };
        };
    };
    TeamsController_create_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    name: string;
                    /**
                     * Format: uuid
                     * @description Leave out for a top-level team.
                     */
                    parentId?: string | null;
                };
            };
        };
        responses: {
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        name: string;
                        /** Format: uuid */
                        parentId: string | null;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: date-time */
                        updatedAt: string;
                    };
                };
            };
        };
    };
    TeamsController_remove_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description It still has teams under it, or members. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    TeamsController_update_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    name?: string;
                    /**
                     * Format: uuid
                     * @description Moves the team, with every team under it; null: to the top.
                     */
                    parentId?: string | null;
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        name: string;
                        /** Format: uuid */
                        parentId: string | null;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: date-time */
                        updatedAt: string;
                    };
                };
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    TenantSwitchController_tenants_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** Format: uuid */
                            id: string;
                            slug: string;
                            name: string;
                            /** @description The tenant this session or token acts in. */
                            current: boolean;
                        }[];
                    };
                };
            };
        };
    };
    TenantSwitchController_switch_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * Format: uuid
                     * @description One of GET /auth/tenants.
                     */
                    tenantId: string;
                };
            };
        };
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not one of your tenants. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    TenantSwitchController_acceptInvitation_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    token: string;
                    /** @description A new address: the password its account starts with. */
                    password?: string;
                    name?: string;
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        tenantId: string;
                        accountCreated: boolean;
                    };
                };
            };
            /** @description `invitation_invalid`, `password_required`, `password_breached`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    TenantsController_list_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** Format: uuid */
                            id: string;
                            slug: string;
                            name: string;
                            active: boolean;
                            operator: boolean;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: date-time */
                            updatedAt: string;
                        }[];
                    };
                };
            };
            /** @description operator_required: the caller does not act in the operator tenant. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    TenantsController_create_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    name: string;
                    /** @description A short handle: lowercase letters, digits and dashes (`acme`). */
                    slug: string;
                    /**
                     * Format: email
                     * @description Its first administrator: an account at this address (made, and invited to choose a password, when there is none).
                     */
                    administratorEmail: string;
                };
            };
        };
        responses: {
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        slug: string;
                        name: string;
                        active: boolean;
                        operator: boolean;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: date-time */
                        updatedAt: string;
                    };
                };
            };
            /** @description operator_required: the caller does not act in the operator tenant. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description `tenant_slug_taken`; `single_tenant`: the deployment has its one tenant (TENANCY=single). */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    NotesController_list_v1: {
        parameters: {
            query?: {
                /** @description `can`: each record says what you may do with it now (`can.update`, `can.delete`, `can.restore`), as its routes would decide: a false is the 403 they would answer. Left out, the records carry no `can`. */
                include?: string;
                limit?: string;
                /** @description `nextCursor` of the previous page (the same `sort`). */
                cursor?: string;
                /** @description Pages by number instead of cursor: 1 for the first, `limit` rows a page. Example: `page=3&limit=20&count=true`. */
                page?: string;
                /** @description true: add `total` (counted up to a cap; `totalCapped`). */
                count?: string;
                /** @description The language of the answer. */
                lang?: string;
                /** @description Filter: q = */
                q?: string;
                /** @description Filter: tag = */
                tag?: string;
                /** @description Filter: tag in */
                "tag.in"?: string;
                /** @description Filter: number = */
                number?: string;
                /** @description Filter: number startsWith */
                "number.startsWith"?: string;
                /** @description Filter: status = */
                status?: string;
                /** @description Filter: status ne */
                "status.ne"?: string;
                /** @description Filter: status in */
                "status.in"?: string;
                /** @description Filter: status notIn */
                "status.notIn"?: string;
                /** @description Filter: title contains */
                "title.contains"?: string;
                /** @description Filter: title notContains */
                "title.notContains"?: string;
                /** @description Filter: title startsWith */
                "title.startsWith"?: string;
                /** @description Filter: title endsWith */
                "title.endsWith"?: string;
                /** @description Filter: ownerId = */
                ownerId?: string;
                /** @description Filter: teamId = */
                teamId?: string;
                /** @description Filter: teamId in */
                "teamId.in"?: string;
                /** @description Filter: teamId isNull */
                "teamId.isNull"?: string;
                /** @description Filter: createdAt gt */
                "createdAt.gt"?: string;
                /** @description Filter: createdAt gte */
                "createdAt.gte"?: string;
                /** @description Filter: createdAt lt */
                "createdAt.lt"?: string;
                /** @description Filter: createdAt lte */
                "createdAt.lte"?: string;
                /** @description Filter: createdAt between */
                "createdAt.between"?: string;
                /** @description Filter: updatedAt gt */
                "updatedAt.gt"?: string;
                /** @description Filter: updatedAt gte */
                "updatedAt.gte"?: string;
                /** @description Filter: updatedAt lt */
                "updatedAt.lt"?: string;
                /** @description Filter: updatedAt lte */
                "updatedAt.lte"?: string;
                /** @description Filter: updatedAt between */
                "updatedAt.between"?: string;
                /** @description Filter: publishedAt gt */
                "publishedAt.gt"?: string;
                /** @description Filter: publishedAt gte */
                "publishedAt.gte"?: string;
                /** @description Filter: publishedAt lt */
                "publishedAt.lt"?: string;
                /** @description Filter: publishedAt lte */
                "publishedAt.lte"?: string;
                /** @description Filter: publishedAt between */
                "publishedAt.between"?: string;
                /** @description Filter: publishedAt isNull */
                "publishedAt.isNull"?: string;
                /** @description Conditions in and/or groups, JSON: a condition { field, op, value } or a group { "and": [...] } / { "or": [...] }, 3 groups deep and 30 conditions at most. Example: {"or":[{"field":"q","op":"eq","value":…},{…}]}. Fields and operators: q (eq); tag (eq, in); number (eq, startsWith); status (eq, ne, in, notIn); title (contains, notContains, startsWith, endsWith); ownerId (eq); teamId (eq, in, isNull); createdAt (gt, gte, lt, lte, between); updatedAt (gt, gte, lt, lte, between); publishedAt (gt, gte, lt, lte, between, isNull). */
                filter?: string;
                /** @description The order: fields comma-separated, - for descending; the newest first on ties. Example: -rank. Sortable: rank, number, status, title, createdAt, updatedAt, publishedAt. */
                sort?: string;
                /** @description true: the recycle bin (deleted records), for those who may restore them. */
                deleted?: string;
                /** @description Only these fields in each item, comma-separated; id always comes. Example: number,ownerId. Fields: id, number, ownerId, teamId, title, body, status, custom, createdAt, updatedAt, deletedAt, deletedBy, publishedAt, tags. */
                fields?: string;
                /** @description Custom fields (GET /v1/custom-fields?subject=Note) filter, sort and select like the fields above: `custom.region=eu`, `custom.amount.gte=10`, in `filter` and `sort` as `custom.<key>`, `fields=custom.region`. */
                "custom.<key>[.<op>]"?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            id: string;
                            /** @description The number people quote: NOTE-<year>-<n>, given on create. */
                            number: string | null;
                            /** @description Who wrote it: `user:<id>` or `client:<id>`. */
                            ownerId: string;
                            /**
                             * Format: uuid
                             * @description The author's team.
                             */
                            teamId: string | null;
                            title: string;
                            /** @description Left out when your permissions don't include the note's text. */
                            body?: string;
                            /** @enum {string} */
                            status: "draft" | "published";
                            /** @description Custom field values by key; left out when your permissions don't include them. */
                            custom?: {
                                [key: string]: unknown;
                            };
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: date-time */
                            updatedAt: string;
                            /**
                             * Format: date-time
                             * @description Set while the note is in the recycle bin (`?deleted=true`).
                             */
                            deletedAt: string | null;
                            /** @description Who deleted it: `user:<id>` or `client:<id>`. */
                            deletedBy: string | null;
                            /** Format: date-time */
                            publishedAt: string | null;
                            /** @description Its tags, by name (PUT /v1/notes/{id}/tags sets them). */
                            tags: {
                                id: string;
                                name: string;
                                color: string | null;
                            }[];
                            /** @description What you may do with it now, as its routes would decide by your permissions and their conditions. Only with `?include=can`; not part of the ETag. */
                            can?: {
                                /** @description PATCH would be allowed. */
                                update: boolean;
                                /** @description DELETE would be allowed. */
                                delete: boolean;
                                /** @description It is in the recycle bin and POST …/{id}/restore would be allowed. */
                                restore: boolean;
                            };
                        }[];
                        /** @description Pass it as `cursor` for the next page; null: no more (and with `page`). */
                        nextCursor: string | null;
                        /** @description With `page`: this page. */
                        page?: number;
                        /** @description With `page`: the next page; null: no more. */
                        nextPage?: number | null;
                        /** @description With `page` and `count=true`: ceil(total / limit). */
                        pageCount?: number;
                        /** @description With `count=true`: the rows matching the filters, all pages; the cap when totalCapped. */
                        total?: number;
                        /** @description true: there are more than `total` (show "10,000+"). */
                        totalCapped?: boolean;
                    };
                };
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    NotesController_create_v1: {
        parameters: {
            query?: never;
            header?: {
                /**
                 * @description A unique key per operation (a UUID), 1 to 255 printable ASCII characters. Send the same key on every retry of the same request: it runs once, and retries get its response (with Idempotent-Replayed: true). Kept for 24 hours.
                 *
                 *     In Swagger UI, leave `generate` to send a new key on every Execute, or type your own key and Execute twice to see a retry replayed.
                 */
                "Idempotency-Key"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @example Hello */
                    title: string;
                    /** @example My first note. */
                    body: string;
                    /**
                     * @description Custom field values by key (GET /custom-fields?subject=…). On an update, only the keys sent change; null removes one.
                     * @example {
                     *       "region": "eu"
                     *     }
                     */
                    custom?: {
                        [key: string]: unknown;
                    };
                };
            };
        };
        responses: {
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        /** @description The number people quote: NOTE-<year>-<n>, given on create. */
                        number: string | null;
                        /** @description Who wrote it: `user:<id>` or `client:<id>`. */
                        ownerId: string;
                        /**
                         * Format: uuid
                         * @description The author's team.
                         */
                        teamId: string | null;
                        title: string;
                        /** @description Left out when your permissions don't include the note's text. */
                        body?: string;
                        /** @enum {string} */
                        status: "draft" | "published";
                        /** @description Custom field values by key; left out when your permissions don't include them. */
                        custom?: {
                            [key: string]: unknown;
                        };
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: date-time */
                        updatedAt: string;
                        /**
                         * Format: date-time
                         * @description Set while the note is in the recycle bin (`?deleted=true`).
                         */
                        deletedAt: string | null;
                        /** @description Who deleted it: `user:<id>` or `client:<id>`. */
                        deletedBy: string | null;
                        /** Format: date-time */
                        publishedAt: string | null;
                        /** @description Its tags, by name (PUT /v1/notes/{id}/tags sets them). */
                        tags: {
                            id: string;
                            name: string;
                            color: string | null;
                        }[];
                        /** @description What you may do with it now, as its routes would decide by your permissions and their conditions. Only with `?include=can`; not part of the ETag. */
                        can?: {
                            /** @description PATCH would be allowed. */
                            update: boolean;
                            /** @description DELETE would be allowed. */
                            delete: boolean;
                            /** @description It is in the recycle bin and POST …/{id}/restore would be allowed. */
                            restore: boolean;
                        };
                    };
                };
            };
            /** @description The body fails the schema, or the Idempotency-Key is missing. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description A request with this Idempotency-Key is still running. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description This Idempotency-Key was used for a different request. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    NotesController_get_v1: {
        parameters: {
            query?: {
                /** @description `can`: each record says what you may do with it now (`can.update`, `can.delete`, `can.restore`), as its routes would decide: a false is the 403 they would answer. Left out, the records carry no `can`. */
                include?: string;
            };
            header?: {
                /** @description The ETag you have: 304 and no body when it is still current. */
                "If-None-Match"?: string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        /** @description The number people quote: NOTE-<year>-<n>, given on create. */
                        number: string | null;
                        /** @description Who wrote it: `user:<id>` or `client:<id>`. */
                        ownerId: string;
                        /**
                         * Format: uuid
                         * @description The author's team.
                         */
                        teamId: string | null;
                        title: string;
                        /** @description Left out when your permissions don't include the note's text. */
                        body?: string;
                        /** @enum {string} */
                        status: "draft" | "published";
                        /** @description Custom field values by key; left out when your permissions don't include them. */
                        custom?: {
                            [key: string]: unknown;
                        };
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: date-time */
                        updatedAt: string;
                        /**
                         * Format: date-time
                         * @description Set while the note is in the recycle bin (`?deleted=true`).
                         */
                        deletedAt: string | null;
                        /** @description Who deleted it: `user:<id>` or `client:<id>`. */
                        deletedBy: string | null;
                        /** Format: date-time */
                        publishedAt: string | null;
                        /** @description Its tags, by name (PUT /v1/notes/{id}/tags sets them). */
                        tags: {
                            id: string;
                            name: string;
                            color: string | null;
                        }[];
                        /** @description What you may do with it now, as its routes would decide by your permissions and their conditions. Only with `?include=can`; not part of the ETag. */
                        can?: {
                            /** @description PATCH would be allowed. */
                            update: boolean;
                            /** @description DELETE would be allowed. */
                            delete: boolean;
                            /** @description It is in the recycle bin and POST …/{id}/restore would be allowed. */
                            restore: boolean;
                        };
                    };
                };
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    NotesController_delete_v1: {
        parameters: {
            query?: never;
            header?: {
                /** @description The ETag the record had when you read it: the write is refused with 412 if it changed since (optimistic concurrency). Leave it out to write regardless; `*` means the same. */
                "If-Match"?: string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The note changed since you read it (precondition_failed). */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    NotesController_update_v1: {
        parameters: {
            query?: never;
            header?: {
                /** @description The ETag the record had when you read it: the write is refused with 412 if it changed since (optimistic concurrency). Leave it out to write regardless; `*` means the same. */
                "If-Match"?: string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @example Hello */
                    title?: string;
                    /** @example My first note. */
                    body?: string;
                    /**
                     * @description Custom field values by key (GET /custom-fields?subject=…). On an update, only the keys sent change; null removes one.
                     * @example {
                     *       "region": "eu"
                     *     }
                     */
                    custom?: {
                        [key: string]: unknown;
                    };
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        /** @description The number people quote: NOTE-<year>-<n>, given on create. */
                        number: string | null;
                        /** @description Who wrote it: `user:<id>` or `client:<id>`. */
                        ownerId: string;
                        /**
                         * Format: uuid
                         * @description The author's team.
                         */
                        teamId: string | null;
                        title: string;
                        /** @description Left out when your permissions don't include the note's text. */
                        body?: string;
                        /** @enum {string} */
                        status: "draft" | "published";
                        /** @description Custom field values by key; left out when your permissions don't include them. */
                        custom?: {
                            [key: string]: unknown;
                        };
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: date-time */
                        updatedAt: string;
                        /**
                         * Format: date-time
                         * @description Set while the note is in the recycle bin (`?deleted=true`).
                         */
                        deletedAt: string | null;
                        /** @description Who deleted it: `user:<id>` or `client:<id>`. */
                        deletedBy: string | null;
                        /** Format: date-time */
                        publishedAt: string | null;
                        /** @description Its tags, by name (PUT /v1/notes/{id}/tags sets them). */
                        tags: {
                            id: string;
                            name: string;
                            color: string | null;
                        }[];
                        /** @description What you may do with it now, as its routes would decide by your permissions and their conditions. Only with `?include=can`; not part of the ETag. */
                        can?: {
                            /** @description PATCH would be allowed. */
                            update: boolean;
                            /** @description DELETE would be allowed. */
                            delete: boolean;
                            /** @description It is in the recycle bin and POST …/{id}/restore would be allowed. */
                            restore: boolean;
                        };
                    };
                };
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The note changed since you read it (precondition_failed). */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    NotesController_restore_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        /** @description The number people quote: NOTE-<year>-<n>, given on create. */
                        number: string | null;
                        /** @description Who wrote it: `user:<id>` or `client:<id>`. */
                        ownerId: string;
                        /**
                         * Format: uuid
                         * @description The author's team.
                         */
                        teamId: string | null;
                        title: string;
                        /** @description Left out when your permissions don't include the note's text. */
                        body?: string;
                        /** @enum {string} */
                        status: "draft" | "published";
                        /** @description Custom field values by key; left out when your permissions don't include them. */
                        custom?: {
                            [key: string]: unknown;
                        };
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: date-time */
                        updatedAt: string;
                        /**
                         * Format: date-time
                         * @description Set while the note is in the recycle bin (`?deleted=true`).
                         */
                        deletedAt: string | null;
                        /** @description Who deleted it: `user:<id>` or `client:<id>`. */
                        deletedBy: string | null;
                        /** Format: date-time */
                        publishedAt: string | null;
                        /** @description Its tags, by name (PUT /v1/notes/{id}/tags sets them). */
                        tags: {
                            id: string;
                            name: string;
                            color: string | null;
                        }[];
                        /** @description What you may do with it now, as its routes would decide by your permissions and their conditions. Only with `?include=can`; not part of the ETag. */
                        can?: {
                            /** @description PATCH would be allowed. */
                            update: boolean;
                            /** @description DELETE would be allowed. */
                            delete: boolean;
                            /** @description It is in the recycle bin and POST …/{id}/restore would be allowed. */
                            restore: boolean;
                        };
                    };
                };
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not in the recycle bin (or purged). */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    ExampleSenderWebhookController_handle_v1: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    type: "note.publish-requested";
                    data: {
                        noteId: string;
                        /** Format: uuid */
                        tenantId: string;
                    };
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {boolean} */
                        received: true;
                        duplicate: boolean;
                    };
                };
            };
            /** @description Missing, invalid or stale signature. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unknown note: nothing recorded, so a retry is processed later. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    NoteCommentsController_list_v1: {
        parameters: {
            query?: {
                limit?: string;
                /** @description `nextCursor` of the previous page (the same `sort`). */
                cursor?: string;
                /** @description Pages by number instead of cursor: 1 for the first, `limit` rows a page. Example: `page=3&limit=20&count=true`. */
                page?: string;
                /** @description true: add `total` (counted up to a cap; `totalCapped`). */
                count?: string;
                /** @description The language of the answer. */
                lang?: string;
                /** @description Filter: author = */
                author?: string;
                /** @description Filter: author in */
                "author.in"?: string;
                /** @description Filter: createdAt gt */
                "createdAt.gt"?: string;
                /** @description Filter: createdAt gte */
                "createdAt.gte"?: string;
                /** @description Filter: createdAt lt */
                "createdAt.lt"?: string;
                /** @description Filter: createdAt lte */
                "createdAt.lte"?: string;
                /** @description Filter: createdAt between */
                "createdAt.between"?: string;
                /** @description Filter: updatedAt gt */
                "updatedAt.gt"?: string;
                /** @description Filter: updatedAt gte */
                "updatedAt.gte"?: string;
                /** @description Filter: updatedAt lt */
                "updatedAt.lt"?: string;
                /** @description Filter: updatedAt lte */
                "updatedAt.lte"?: string;
                /** @description Filter: updatedAt between */
                "updatedAt.between"?: string;
                /** @description Conditions in and/or groups, JSON: a condition { field, op, value } or a group { "and": [...] } / { "or": [...] }, 3 groups deep and 30 conditions at most. Example: {"or":[{"field":"author","op":"eq","value":…},{…}]}. Fields and operators: author (eq, in); createdAt (gt, gte, lt, lte, between); updatedAt (gt, gte, lt, lte, between). */
                filter?: string;
                /** @description The order: fields comma-separated, - for descending; the newest first on ties. Example: -createdAt. Sortable: createdAt, updatedAt. */
                sort?: string;
                /** @description Only these fields in each item, comma-separated; id always comes. Example: subject,recordId. Fields: id, subject, recordId, author, authorName, body, mentions, editedAt, createdAt, updatedAt. */
                fields?: string;
            };
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            id: string;
                            /** @example Note */
                            subject: string;
                            recordId: string;
                            /** @description Who wrote it: `user:<id>` or `client:<id>`; `anonymous` once their account was deleted. */
                            author: string;
                            /**
                             * @description The author's name, as every member of the tenant sees it (GET /v1/people); null once their account was deleted (`anonymous`), or for anyone the tenant never had.
                             * @example Maya Patel
                             */
                            authorName: string | null;
                            body: string;
                            /** @description The people mentioned (`@<email>` or `@user:<id>` in the body) who may read the record, as `user:<id>`. */
                            mentions: string[];
                            /** Format: date-time */
                            editedAt: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: date-time */
                            updatedAt: string;
                        }[];
                        /** @description Pass it as `cursor` for the next page; null: no more (and with `page`). */
                        nextCursor: string | null;
                        /** @description With `page`: this page. */
                        page?: number;
                        /** @description With `page`: the next page; null: no more. */
                        nextPage?: number | null;
                        /** @description With `page` and `count=true`: ceil(total / limit). */
                        pageCount?: number;
                        /** @description With `count=true`: the rows matching the filters, all pages; the cap when totalCapped. */
                        total?: number;
                        /** @description true: there are more than `total` (show "10,000+"). */
                        totalCapped?: boolean;
                    };
                };
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description You may not read the note. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No such note (or comment). */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    NoteCommentsController_add_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @example Looks good to me, @ada@example.com: can you check the numbers? */
                    body: string;
                };
            };
        };
        responses: {
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        /** @example Note */
                        subject: string;
                        recordId: string;
                        /** @description Who wrote it: `user:<id>` or `client:<id>`; `anonymous` once their account was deleted. */
                        author: string;
                        /**
                         * @description The author's name, as every member of the tenant sees it (GET /v1/people); null once their account was deleted (`anonymous`), or for anyone the tenant never had.
                         * @example Maya Patel
                         */
                        authorName: string | null;
                        body: string;
                        /** @description The people mentioned (`@<email>` or `@user:<id>` in the body) who may read the record, as `user:<id>`. */
                        mentions: string[];
                        /** Format: date-time */
                        editedAt: string | null;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: date-time */
                        updatedAt: string;
                    };
                };
            };
            /** @description An empty body, or longer than 10 000 characters. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description You may not read the note. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No such note (or comment). */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    NoteCommentsController_remove_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                commentId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description You may not read the note. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No such note (or comment). */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    NoteCommentsController_edit_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                commentId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @example Looks good to me, @ada@example.com: can you check the numbers? */
                    body: string;
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        /** @example Note */
                        subject: string;
                        recordId: string;
                        /** @description Who wrote it: `user:<id>` or `client:<id>`; `anonymous` once their account was deleted. */
                        author: string;
                        /**
                         * @description The author's name, as every member of the tenant sees it (GET /v1/people); null once their account was deleted (`anonymous`), or for anyone the tenant never had.
                         * @example Maya Patel
                         */
                        authorName: string | null;
                        body: string;
                        /** @description The people mentioned (`@<email>` or `@user:<id>` in the body) who may read the record, as `user:<id>`. */
                        mentions: string[];
                        /** Format: date-time */
                        editedAt: string | null;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: date-time */
                        updatedAt: string;
                    };
                };
            };
            /** @description An empty body, or longer than 10 000 characters. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description You may not read the note. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No such note (or comment). */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    NoteAttachmentsController_list_v1: {
        parameters: {
            query?: {
                limit?: number;
                /** @description `nextCursor` of the previous page (the same `sort`). */
                cursor?: string;
                /** @description Pages by number instead of cursor: 1 for the first, `limit` rows a page. Example: `page=3&limit=20&count=true`. */
                page?: number;
                /** @description true: add `total` (counted up to a cap; `totalCapped`). */
                count?: "true" | "false";
                lang?: string;
                /** @description Filter: name = */
                name?: string;
                /** @description Filter: name contains */
                "name.contains"?: string;
                /** @description Filter: contentType = */
                contentType?: string;
                /** @description Filter: contentType in */
                "contentType.in"?: string;
                /** @description Filter: contentType startsWith */
                "contentType.startsWith"?: string;
                /** @description Filter: size gte */
                "size.gte"?: number;
                /** @description Filter: size lte */
                "size.lte"?: number;
                /** @description Filter: createdAt gte */
                "createdAt.gte"?: string;
                /** @description Filter: createdAt lt */
                "createdAt.lt"?: string;
                /** @description Filter: createdAt between */
                "createdAt.between"?: string;
                /** @description Filter: updatedAt gte */
                "updatedAt.gte"?: string;
                /** @description Filter: updatedAt lt */
                "updatedAt.lt"?: string;
                /** @description Filter: updatedAt between */
                "updatedAt.between"?: string;
                /** @description Conditions in and/or groups, JSON: a condition { field, op, value } or a group { "and": [...] } / { "or": [...] }, 3 groups deep and 30 conditions at most. Example: {"or":[{"field":"name","op":"eq","value":…},{…}]}. Fields and operators: name (eq, contains); contentType (eq, in, startsWith); size (gte, lte); createdAt (gte, lt, between); updatedAt (gte, lt, between). */
                filter?: string;
                /** @description The order: fields comma-separated, - for descending; the newest first on ties. Example: -name. Sortable: name, size, createdAt, updatedAt. */
                sort?: string;
                /** @description Only these fields in each item, comma-separated; id always comes. Example: subject,recordId. Fields: id, subject, recordId, name, size, contentType, uploadedBy, locked, createdAt, updatedAt. */
                fields?: string;
            };
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** Format: uuid */
                            id: string;
                            /** @example Note */
                            subject: string;
                            /** Format: uuid */
                            recordId: string;
                            /** @example invoice.pdf */
                            name: string;
                            /** @description Bytes. */
                            size: number;
                            /**
                             * @description Detected from the file's bytes.
                             * @example application/pdf
                             */
                            contentType: string;
                            /**
                             * @description `user:<id>`, `client:<id>`, or `anonymized`.
                             * @example user:0199a3f2-…
                             */
                            uploadedBy: string;
                            /** @description An issued document (a generated PDF): it never changes and cannot be removed; it goes with its record. */
                            locked: boolean;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: date-time */
                            updatedAt: string;
                        }[];
                        /** @description Pass it as `cursor` for the next page; null: no more (and with `page`). */
                        nextCursor: string | null;
                        /** @description With `page`: this page. */
                        page?: number;
                        /** @description With `page`: the next page; null: no more. */
                        nextPage?: number | null;
                        /** @description With `page` and `count=true`: ceil(total / limit). */
                        pageCount?: number;
                        /** @description With `count=true`: the rows matching the filters, all pages; the cap when totalCapped. */
                        total?: number;
                        /** @description true: there are more than `total` (show "10,000+"). */
                        totalCapped?: boolean;
                    };
                };
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    NoteAttachmentsController_upload_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "multipart/form-data": {
                    /**
                     * Format: binary
                     * @description Required. Its type is read from its bytes and must be allowed (ATTACHMENT_ALLOWED_TYPES: images, PDF, Office, text, zip by default), its size at most ATTACHMENT_MAX_MB (25).
                     */
                    file?: string;
                };
            };
        };
        responses: {
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        /** @example Note */
                        subject: string;
                        /** Format: uuid */
                        recordId: string;
                        /** @example invoice.pdf */
                        name: string;
                        /** @description Bytes. */
                        size: number;
                        /**
                         * @description Detected from the file's bytes.
                         * @example application/pdf
                         */
                        contentType: string;
                        /**
                         * @description `user:<id>`, `client:<id>`, or `anonymized`.
                         * @example user:0199a3f2-…
                         */
                        uploadedBy: string;
                        /** @description An issued document (a generated PDF): it never changes and cannot be removed; it goes with its record. */
                        locked: boolean;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: date-time */
                        updatedAt: string;
                    };
                };
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description You may not change the note. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Larger than ATTACHMENT_MAX_MB (payload_too_large). */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description A type not allowed, or not the one declared (unsupported_media_type). */
            415: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    NoteTagsController_set_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description Every tag the record carries afterwards; [] removes all. */
                    tagIds: string[];
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            id: string;
                            name: string;
                            color: string | null;
                        }[];
                    };
                };
            };
            /** @description An id that is not a Note tag, named by its path (validation_failed). */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description You may not change the note. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No such note. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    NoteRevisionsController_list_v1: {
        parameters: {
            query?: {
                limit?: string;
                /** @description `nextCursor` of the previous page (the same `sort`). */
                cursor?: string;
                /** @description Pages by number instead of cursor: 1 for the first, `limit` rows a page. Example: `page=3&limit=20&count=true`. */
                page?: string;
                /** @description true: add `total` (counted up to a cap; `totalCapped`). */
                count?: string;
                /** @description The language of the answer. */
                lang?: string;
                /** @description Filter: number gte */
                "number.gte"?: string;
                /** @description Filter: number lte */
                "number.lte"?: string;
                /** @description Filter: number between */
                "number.between"?: string;
                /** @description Filter: changedBy = */
                changedBy?: string;
                /** @description Filter: changedBy in */
                "changedBy.in"?: string;
                /** @description Filter: createdAt gte */
                "createdAt.gte"?: string;
                /** @description Filter: createdAt lt */
                "createdAt.lt"?: string;
                /** @description Filter: createdAt between */
                "createdAt.between"?: string;
                /** @description Filter: updatedAt gte */
                "updatedAt.gte"?: string;
                /** @description Filter: updatedAt lt */
                "updatedAt.lt"?: string;
                /** @description Filter: updatedAt between */
                "updatedAt.between"?: string;
                /** @description Conditions in and/or groups, JSON: a condition { field, op, value } or a group { "and": [...] } / { "or": [...] }, 3 groups deep and 30 conditions at most. Example: {"or":[{"field":"number","op":"gte","value":…},{…}]}. Fields and operators: number (gte, lte, between); changedBy (eq, in); createdAt (gte, lt, between); updatedAt (gte, lt, between). */
                filter?: string;
                /** @description The order: fields comma-separated, - for descending; the newest first on ties. Example: -createdAt. Sortable: createdAt, updatedAt. */
                sort?: string;
                /** @description Only these fields in each item, comma-separated; id always comes. Example: subject,recordId. Fields: id, subject, recordId, number, snapshot, changes, restoredFrom, changedBy, changedByName, changedAt, createdAt, updatedAt. */
                fields?: string;
            };
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            id: string;
                            /** @example Note */
                            subject: string;
                            recordId: string;
                            /** @description 1 for the record's first state, then one more per change. */
                            number: number;
                            /** @description The record's changeable fields after the change (custom values in `custom`); fields your permissions don't include are left out. */
                            snapshot: {
                                [key: string]: unknown;
                            };
                            /**
                             * @description What changed, from → to (`custom.<key>` per custom value); null for the first revision.
                             * @example {
                             *       "title": {
                             *         "from": "Draft",
                             *         "to": "Plan"
                             *       }
                             *     }
                             */
                            changes: {
                                [key: string]: {
                                    from: unknown;
                                    to: unknown;
                                };
                            } | null;
                            /** @description The revision this change restored; null for an ordinary change. */
                            restoredFrom: number | null;
                            /** @description Who made the change: `user:<id>` or `client:<id>`; `anonymized` once their account was deleted; `unknown` for the state a record had before revisions were kept. */
                            changedBy: string;
                            /**
                             * @description The name of who made the change, as every member of the tenant sees it (GET /v1/people); null for `anonymized`, `unknown`, or anyone the tenant never had.
                             * @example Maya Patel
                             */
                            changedByName: string | null;
                            /** Format: date-time */
                            changedAt: string;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: date-time */
                            updatedAt: string;
                        }[];
                        /** @description Pass it as `cursor` for the next page; null: no more (and with `page`). */
                        nextCursor: string | null;
                        /** @description With `page`: this page. */
                        page?: number;
                        /** @description With `page`: the next page; null: no more. */
                        nextPage?: number | null;
                        /** @description With `page` and `count=true`: ceil(total / limit). */
                        pageCount?: number;
                        /** @description With `count=true`: the rows matching the filters, all pages; the cap when totalCapped. */
                        total?: number;
                        /** @description true: there are more than `total` (show "10,000+"). */
                        totalCapped?: boolean;
                    };
                };
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No such note (or you may not read it), or no such revision. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    NoteRevisionsController_get_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                number: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        /** @example Note */
                        subject: string;
                        recordId: string;
                        /** @description 1 for the record's first state, then one more per change. */
                        number: number;
                        /** @description The record's changeable fields after the change (custom values in `custom`); fields your permissions don't include are left out. */
                        snapshot: {
                            [key: string]: unknown;
                        };
                        /**
                         * @description What changed, from → to (`custom.<key>` per custom value); null for the first revision.
                         * @example {
                         *       "title": {
                         *         "from": "Draft",
                         *         "to": "Plan"
                         *       }
                         *     }
                         */
                        changes: {
                            [key: string]: {
                                from: unknown;
                                to: unknown;
                            };
                        } | null;
                        /** @description The revision this change restored; null for an ordinary change. */
                        restoredFrom: number | null;
                        /** @description Who made the change: `user:<id>` or `client:<id>`; `anonymized` once their account was deleted; `unknown` for the state a record had before revisions were kept. */
                        changedBy: string;
                        /**
                         * @description The name of who made the change, as every member of the tenant sees it (GET /v1/people); null for `anonymized`, `unknown`, or anyone the tenant never had.
                         * @example Maya Patel
                         */
                        changedByName: string | null;
                        /** Format: date-time */
                        changedAt: string;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: date-time */
                        updatedAt: string;
                    };
                };
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No such note (or you may not read it), or no such revision. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    NoteRevisionsController_diff_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                a: number;
                b: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description The older side (`a`). */
                        from: number;
                        /** @description The newer side (`b`). */
                        to: number;
                        /**
                         * @description The fields that differ, from `a`’s value to `b`’s (`custom.<key>` per custom value).
                         * @example {
                         *       "title": {
                         *         "from": "Draft",
                         *         "to": "Plan"
                         *       }
                         *     }
                         */
                        changes: {
                            [key: string]: {
                                from: unknown;
                                to: unknown;
                            };
                        };
                    };
                };
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No such note (or you may not read it), or no such revision. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    NoteRevisionsController_restore_v1: {
        parameters: {
            query?: never;
            header?: {
                /** @description The ETag the record had when you read it: the write is refused with 412 if it changed since (optimistic concurrency). Leave it out to write regardless; `*` means the same. */
                "If-Match"?: string;
            };
            path: {
                id: string;
                number: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        /** @description The number people quote: NOTE-<year>-<n>, given on create. */
                        number: string | null;
                        /** @description Who wrote it: `user:<id>` or `client:<id>`. */
                        ownerId: string;
                        /**
                         * Format: uuid
                         * @description The author's team.
                         */
                        teamId: string | null;
                        title: string;
                        /** @description Left out when your permissions don't include the note's text. */
                        body?: string;
                        /** @enum {string} */
                        status: "draft" | "published";
                        /** @description Custom field values by key; left out when your permissions don't include them. */
                        custom?: {
                            [key: string]: unknown;
                        };
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: date-time */
                        updatedAt: string;
                        /**
                         * Format: date-time
                         * @description Set while the note is in the recycle bin (`?deleted=true`).
                         */
                        deletedAt: string | null;
                        /** @description Who deleted it: `user:<id>` or `client:<id>`. */
                        deletedBy: string | null;
                        /** Format: date-time */
                        publishedAt: string | null;
                        /** @description Its tags, by name (PUT /v1/notes/{id}/tags sets them). */
                        tags: {
                            id: string;
                            name: string;
                            color: string | null;
                        }[];
                        /** @description What you may do with it now, as its routes would decide by your permissions and their conditions. Only with `?include=can`; not part of the ETag. */
                        can?: {
                            /** @description PATCH would be allowed. */
                            update: boolean;
                            /** @description DELETE would be allowed. */
                            delete: boolean;
                            /** @description It is in the recycle bin and POST …/{id}/restore would be allowed. */
                            restore: boolean;
                        };
                    };
                };
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description You may not change the note, or a field it would set (field_forbidden). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No such note (or you may not read it), or no such revision. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The note changed since you read it (precondition_failed). */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    NoteDocumentsController_pdf_v1: {
        parameters: {
            query?: never;
            header?: {
                /**
                 * @description A unique key per operation (a UUID), 1 to 255 printable ASCII characters. Send the same key on every retry of the same request: it runs once, and retries get its response (with Idempotent-Replayed: true). Kept for 24 hours.
                 *
                 *     In Swagger UI, leave `generate` to send a new key on every Execute, or type your own key and Execute twice to see a retry replayed.
                 */
                "Idempotency-Key"?: string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        /** @enum {string} */
                        status: "queued";
                    };
                };
            };
            /** @description The Idempotency-Key is missing. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description You may not issue it. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Your document of this note, in this language, is still being rendered (document_pending: its `id` is in the problem), or a request with this Idempotency-Key is still running. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description This Idempotency-Key was used for a different request. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description More than 10 a minute from one user (rate_limited). */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description PDF documents are not set up on this server (documents_unavailable: GOTENBERG_URL is unset). */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    NotesController_runBulk_v1: {
        parameters: {
            query?: never;
            header?: {
                /**
                 * @description A unique key per operation (a UUID), 1 to 255 printable ASCII characters. Send the same key on every retry of the same request: it runs once, and retries get its response (with Idempotent-Replayed: true). Kept for 24 hours.
                 *
                 *     In Swagger UI, leave `generate` to send a new key on every Execute, or type your own key and Execute twice to see a retry replayed.
                 */
                "Idempotency-Key"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    action: "delete" | "restore" | "update";
                    /** @description These records (1 to 500); those you may not act on are skipped. Send ids or filter. */
                    ids?: string[];
                    /** @description Every record matching these list filters, as on the list route: { "status": "draft", "title.startsWith": "Old" }. Always a background job. */
                    filter?: {
                        [key: string]: unknown;
                    };
                    /** @description What the action takes (update: the PATCH body). */
                    input?: {
                        /** @example Hello */
                        title?: string;
                        /** @example My first note. */
                        body?: string;
                        /**
                         * @description Custom field values by key (GET /custom-fields?subject=…). On an update, only the keys sent change; null removes one.
                         * @example {
                         *       "region": "eu"
                         *     }
                         */
                        custom?: {
                            [key: string]: unknown;
                        };
                    };
                };
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        done: number;
                        failed: number;
                        /** @description Ids not found, or not yours to act on (code not_found). */
                        skipped: number;
                        results: {
                            id: string;
                            /** @enum {string} */
                            status: "done" | "failed" | "skipped";
                            /** @description Why it failed: the problem the record's own route would have answered. */
                            error?: {
                                /** @example field_forbidden */
                                code: string;
                                message: string;
                                errors?: {
                                    path: string;
                                    message: string;
                                }[];
                            };
                        }[];
                        /** @description A background job keeps 10000 results; true when there were more. */
                        truncated?: boolean;
                    };
                };
            };
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        /** @enum {string} */
                        status: "queued";
                    };
                };
            };
            /** @description The body is invalid (validation_failed: ids and filter both or neither, an unknown action, a bad filter or input), more than 500 ids (bulk_too_many), or the Idempotency-Key is missing. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description A request with this Idempotency-Key is still running. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description This Idempotency-Key was used for a different request. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    NotesController_watch_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        watching: boolean;
                    };
                };
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    NotesController_unwatch_v1: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No valid API key or session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not allowed by your permissions. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description You were not watching it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
}
