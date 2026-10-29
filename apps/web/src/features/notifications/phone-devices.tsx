import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { unwrap, type GetResponse } from '@nestjs-monorepo-template/api-client';
import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { FieldGroup } from '@nestjs-monorepo-template/ui/components/field';
import { SmartphoneIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Section } from '@/components/account/section';
import { ConfirmButton } from '@/components/confirm-button';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/date-time';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { FormAlert, useAppForm } from '@/lib/form';
import { z } from '@/lib/zod';
import {
  browserName,
  pushRegistration,
  rememberDevice,
  rememberedDevice,
} from './web-push';

export const phoneQuery = queryOptions({
  queryKey: ['messaging', 'phone'],
  queryFn: () => unwrap(api.GET('/v1/messaging/phone')),
});

export const devicesQuery = queryOptions({
  queryKey: ['messaging', 'devices'],
  queryFn: () => unwrap(api.GET('/v1/devices')),
});

type Device = GetResponse<'/v1/devices'>['items'][number];

const webPushQuery = queryOptions({
  queryKey: ['messaging', 'web-push'],
  queryFn: () => unwrap(api.GET('/v1/devices/web-push')),
});

/** This browser's push subscription, or null; false where push can't work here (a query's data is never undefined). */
const subscriptionQuery = queryOptions({
  queryKey: ['messaging', 'web-push', 'subscription'],
  queryFn: async () => {
    const registration = await pushRegistration();
    return registration
      ? await registration.pushManager.getSubscription()
      : false;
  },
});

/** Unsubscribes this browser; its device row goes too unless `removed` already. */
async function unsubscribe(removed?: string) {
  const registration = await pushRegistration();
  await (await registration?.pushManager.getSubscription())?.unsubscribe();
  const id = rememberedDevice();
  if (id && id !== removed) {
    await unwrap(api.DELETE('/v1/devices/{id}', { params: { path: { id } } }));
  }
  rememberDevice(null);
}

/**
 * Push on this browser: asks for permission, subscribes with the API's VAPID
 * key and registers the subscription as a `web` device. Shown only when Web
 * Push is on (the key) and this browser can (a service worker, the Push API).
 */
function WebPushToggle() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();
  const key = useQuery(webPushQuery);
  const subscription = useQuery(subscriptionQuery);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: devicesQuery.queryKey }),
      queryClient.invalidateQueries({ queryKey: subscriptionQuery.queryKey }),
    ]);
  const enable = useMutation({
    mutationFn: async (publicKey: string) => {
      if ((await Notification.requestPermission()) !== 'granted') {
        return false;
      }
      const registration = (await pushRegistration())!;
      const subscribed = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: publicKey,
      });
      const device = await unwrap(
        api.PUT('/v1/devices', {
          body: {
            platform: 'web',
            name: browserName().slice(0, 100),
            token: JSON.stringify(subscribed),
          },
        }),
      );
      rememberDevice(device.id);
      return true;
    },
    onSuccess: async (granted) => {
      if (!granted) {
        toast.error(t('devices.denied'));
        return;
      }
      toast.success(t('devices.enabled'));
      await refresh();
    },
  });
  const disable = useMutation({
    mutationFn: () => unsubscribe(),
    onSuccess: async () => {
      toast.success(t('devices.disabled'));
      await refresh();
    },
  });
  const publicKey = key.data?.publicKey;
  if (
    !publicKey ||
    subscription.data === undefined ||
    subscription.data === false
  ) {
    return null;
  }
  return subscription.data ? (
    <Button
      variant="outline"
      className="self-start"
      disabled={disable.isPending}
      onClick={() => disable.mutate()}
    >
      {t('devices.disable')}
    </Button>
  ) : (
    <Button
      variant="outline"
      className="self-start"
      disabled={enable.isPending}
      onClick={() => enable.mutate(publicKey)}
    >
      {t('devices.enable')}
    </Button>
  );
}

/**
 * The SMS number (docs/notifications.md, "Push and SMS"): set it (the API
 * texts a code), confirm the code, see its state (including STOP), remove it.
 */
export function PhoneSection() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();
  const phone = useQuery(phoneQuery);
  const [changing, setChanging] = useState(false);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: phoneQuery.queryKey });
  const remove = useMutation({
    mutationFn: async () => {
      await unwrap(api.DELETE('/v1/messaging/phone'));
    },
    onSuccess: async () => {
      toast.success(t('phone.removed'));
      await refresh();
    },
  });
  const current = phone.data?.phone ?? null;
  return (
    <Section title={t('phone.title')} description={t('phone.description')}>
      {phone.isPending ? (
        <Spinner />
      ) : (
        <>
          {current && (
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-medium">{current}</span>
              {phone.data?.optedOut ? (
                <Badge variant="destructive">{t('phone.optedOut')}</Badge>
              ) : phone.data?.verified ? (
                <Badge variant="secondary">{t('phone.verified')}</Badge>
              ) : (
                <Badge variant="outline">{t('phone.unverified')}</Badge>
              )}
              <ConfirmButton
                size="sm"
                variant="ghost"
                title={t('phone.removeTitle')}
                description={t('phone.removeDescription')}
                confirm={t('phone.remove')}
                onConfirm={() => remove.mutateAsync()}
              >
                {t('phone.remove')}
              </ConfirmButton>
            </div>
          )}
          {current && phone.data?.optedOut && (
            <p className="text-sm text-muted-foreground">
              {t('phone.optedOutHint')}
            </p>
          )}
          {current && !phone.data?.verified && <VerifyForm onDone={refresh} />}
          {(!current || changing) && (
            <PhoneForm
              changing={!!current}
              onDone={async () => {
                setChanging(false);
                await refresh();
              }}
            />
          )}
          {current && !changing && (
            <button
              type="button"
              className="self-start text-sm underline"
              onClick={() => setChanging(true)}
            >
              {t('phone.change')}
            </button>
          )}
        </>
      )}
    </Section>
  );
}

function PhoneForm(props: { changing: boolean; onDone: () => Promise<void> }) {
  const { t } = useTranslation('notifications');
  const [error, setError] = useState<string>();
  const form = useAppForm({
    defaultValues: { phone: '' },
    validators: {
      onSubmit: z.object({
        phone: z
          .string()
          .trim()
          .regex(/^\+[1-9]\d{6,14}$/, t('phone.invalid')),
      }),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      try {
        await unwrap(
          api.PUT('/v1/messaging/phone', {
            body: { phone: value.phone.trim() },
          }),
        );
        toast.success(t('phone.codeSent'));
        await props.onDone();
      } catch (caught) {
        if (!applyFieldErrors(form, caught)) {
          setError(errorMessage(caught));
        }
      }
    },
  });
  return (
    <form
      noValidate
      className="max-w-sm"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <FieldGroup>
        <FormAlert message={error} />
        <form.AppField name="phone">
          {(field) => (
            <field.TextField
              label={t('phone.number')}
              description={t('phone.numberHint')}
              autoComplete="tel"
              placeholder="+4915112345678"
            />
          )}
        </form.AppField>
        <form.AppForm>
          <form.SubmitButton>
            {props.changing ? t('phone.save') : t('phone.add')}
          </form.SubmitButton>
        </form.AppForm>
      </FieldGroup>
    </form>
  );
}

/** The six-digit code texted to the number. */
function VerifyForm(props: { onDone: () => Promise<unknown> }) {
  const { t } = useTranslation('notifications');
  const [error, setError] = useState<string>();
  const form = useAppForm({
    defaultValues: { code: '' },
    validators: {
      onSubmit: z.object({
        code: z.string().regex(/^\d{6}$/, t('phone.codeInvalid')),
      }),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      try {
        await unwrap(
          api.POST('/v1/messaging/phone/verify', {
            body: { code: value.code },
          }),
        );
        toast.success(t('phone.confirmed'));
        await props.onDone();
      } catch (caught) {
        if (!applyFieldErrors(form, caught)) {
          setError(errorMessage(caught));
        }
      }
    },
  });
  return (
    <form
      noValidate
      className="max-w-sm"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <FieldGroup>
        <FormAlert message={error} />
        <form.AppField name="code">
          {(field) => (
            <field.CodeField
              label={t('phone.code')}
              description={t('phone.codeHint')}
            />
          )}
        </form.AppField>
        <form.AppForm>
          <form.SubmitButton>{t('phone.verify')}</form.SubmitButton>
        </form.AppForm>
      </FieldGroup>
    </form>
  );
}

/** The devices registered for push: this browser from here (WebPushToggle), phones by the native app. */
export function DevicesSection() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();
  const devices = useQuery(devicesQuery);
  const remove = useMutation({
    mutationFn: async (id: string) => {
      await unwrap(
        api.DELETE('/v1/devices/{id}', { params: { path: { id } } }),
      );
      // This browser's own row: its subscription goes with it.
      if (id === rememberedDevice()) await unsubscribe(id);
    },
    onSuccess: async () => {
      toast.success(t('devices.removed'));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: devicesQuery.queryKey }),
        queryClient.invalidateQueries({
          queryKey: subscriptionQuery.queryKey,
        }),
      ]);
    },
  });
  return (
    <Section title={t('devices.title')} description={t('devices.description')}>
      <WebPushToggle />
      {devices.isPending ? (
        <Spinner />
      ) : devices.data?.items.length ? (
        <ul className="flex flex-col divide-y rounded-md border">
          {devices.data.items.map((device: Device) => (
            <li
              key={device.id}
              className="flex flex-wrap items-center gap-3 p-3"
            >
              <SmartphoneIcon className="size-4 text-muted-foreground" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{device.name}</span>
                <span className="text-xs text-muted-foreground">
                  {t('devices.lastSeen', {
                    date: formatDateTime(device.lastSeenAt),
                  })}
                </span>
              </div>
              <Badge variant="outline">
                {t(`devices.platforms.${device.platform}`)}
              </Badge>
              <ConfirmButton
                size="sm"
                variant="ghost"
                title={t('devices.removeTitle')}
                description={t('devices.removeDescription', {
                  name: device.name,
                })}
                confirm={t('devices.remove')}
                label={t('devices.removeLabel', { name: device.name })}
                onConfirm={() => remove.mutateAsync(device.id)}
              >
                {t('devices.remove')}
              </ConfirmButton>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{t('devices.none')}</p>
      )}
    </Section>
  );
}
