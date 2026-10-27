import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  FileUpload,
  FileUploadTrigger,
} from '@nestjs-monorepo-template/ui/components/file-upload';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { UserAvatar } from '@/components/user-avatar';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { meQuery, type Me } from '@/lib/session';
import { postMultipart } from '@/lib/upload';
import { unwrap } from '@nestjs-monorepo-template/api-client';

/** The types the API takes (from the bytes; it decides). */
const TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/**
 * The account's picture: choose a file (`PUT /v1/account/avatar`) or remove
 * it (`DELETE`). The nav, comments and member lists show it from the
 * `avatarUrl` of `GET /v1/auth/me` and `/v1/people`; both are refreshed after
 * a change. The browser checks only the type it guesses; the API decides the
 * type and the size (AVATAR_MAX_MB, an operator's setting the page does not
 * know: 415, 413) and its message is shown.
 */
export function AvatarSection({ me }: { me: Me }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { user } = me;
  const [busy, setBusy] = useState(false);
  const impersonating = !!user.impersonator;
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: meQuery.queryKey }),
      queryClient.invalidateQueries({ queryKey: ['people'] }),
    ]);
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE('/v1/account/avatar')),
    onSuccess: async () => {
      await refresh();
      toast.success(t('account.avatar.removed'));
    },
  });
  const avatarLabel = user.avatarUrl
    ? t('account.avatar.change')
    : t('account.avatar.choose');
  return (
    <div className="flex items-center gap-4">
      <UserAvatar
        size="lg"
        className="size-16"
        name={user.name}
        src={user.avatarUrl}
      />
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          {/*
            axe "label-title-only": the upload's hidden input is named only by
            its clipped, screen-reader-only label, which axe does not count as
            visible. FileUpload's root takes `render`: as a <label> it is the
            input's visible label (with the button's text), and `label` names it.
          */}
          <FileUpload
            // oxlint-disable-next-line jsx-a11y/label-has-associated-control -- FileUpload fills it with the input and the trigger's text
            render={<label />} // NOSONAR S6853: FileUpload fills it with the input and the trigger's text
            label={t('account.avatar.title')}
            accept={TYPES.join(',')}
            maxFiles={1}
            disabled={impersonating || busy}
            onFileReject={(file, message) =>
              toast.error(
                t('account.avatar.rejected', {
                  name: file.name,
                  reason: message,
                }),
              )
            }
            onUpload={async (files, { onSuccess, onError }) => {
              const file = files[0];
              if (!file) return;
              setBusy(true);
              try {
                const form = new FormData();
                form.append('file', file);
                await postMultipart(
                  '/v1/account/avatar',
                  form,
                  () => undefined,
                  'PUT',
                );
                onSuccess(file);
                await refresh();
                toast.success(t('account.avatar.saved'));
              } catch (error) {
                toast.error(errorMessage(error));
                onError(file, error instanceof Error ? error : new Error());
              } finally {
                setBusy(false);
              }
            }}
          >
            <FileUploadTrigger
              render={<Button variant="outline" size="sm" type="button" />}
            >
              {avatarLabel}
            </FileUploadTrigger>
          </FileUpload>
          {user.avatarUrl && (
            <Button
              variant="ghost"
              size="sm"
              type="button"
              disabled={impersonating || remove.isPending}
              onClick={() => remove.mutate()}
            >
              {t('account.avatar.remove')}
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {t('account.avatar.hint')}
        </p>
      </div>
    </div>
  );
}
