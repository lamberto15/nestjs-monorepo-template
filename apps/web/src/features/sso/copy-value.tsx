import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { CopyIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

/** A value an administrator pastes into the identity provider, with a copy button. */
export function CopyValue(props: { label: string; value: string }) {
  const { t } = useTranslation('sso');
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs text-muted-foreground">{props.label}</dt>
      <dd className="flex items-start gap-2">
        <code className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1 text-xs">
          {props.value}
        </code>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label={t('copy', { label: props.label })}
          onClick={() => {
            navigator.clipboard.writeText(props.value).then(
              () => toast.success(t('copied')),
              () => toast.error(t('copyFailed')),
            );
          }}
        >
          <CopyIcon />
        </Button>
      </dd>
    </div>
  );
}
