import {
  Combobox,
  ComboboxAnchor,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxTrigger,
} from '@nestjs-monorepo-template/ui/components/combobox';
import { isApiError } from '@nestjs-monorepo-template/api-client';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDebouncedCallback } from '@/hooks/use-debounced-callback';
import {
  principalLabel,
  principalSearchQuery,
  type Principal,
  type PrincipalKind,
} from '@/lib/principals';

/**
 * Picks a user or an API client by searching the tenant's principals
 * (`GET /v1/access/principals?q=`) as one types: Dice UI's combobox, the
 * search done by the API (`manualFiltering`). The value is the principal's
 * `key` (`user:<id>`, a setting's `scopeId`) or, with `by="id"`, its id.
 */
export function PrincipalPicker(props: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string, principal: Principal | undefined) => void;
  /** Only users, or only API clients. */
  kind?: PrincipalKind;
  /** Leave out deactivated users and revoked clients. */
  active?: boolean;
  /** What the value is: the key (default) or the id. */
  by?: 'key' | 'id';
  /** Ids or keys not offered (yourself). */
  exclude?: readonly string[];
  /** What the input shows for the current value before any search. */
  initialLabel?: string;
  placeholder?: string;
  invalid?: boolean;
  /** The ids of the hint and the error the caller shows beside it (`useDescribedBy`). */
  describedBy?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const by = props.by ?? 'key';
  const [input, setInput] = useState(props.initialLabel ?? '');
  const [term, setTerm] = useState('');
  const search = useDebouncedCallback((next: string) => setTerm(next), 250);
  const found = useQuery({
    ...principalSearchQuery({
      q: term,
      kind: props.kind,
      active: props.active,
    }),
    retry: false,
    meta: { errorToast: false },
  });
  const forbidden = isApiError(found.error) && found.error.status === 403;
  const items = (found.data ?? []).filter(
    (principal) =>
      !props.exclude?.includes(principal.id) &&
      !props.exclude?.includes(principal.key),
  );
  const empty = forbidden
    ? t('principals.forbidden')
    : found.isError
      ? t('principals.failed')
      : found.isFetching
        ? t('principals.searching')
        : t('principals.none');

  return (
    <Combobox
      value={props.value}
      onValueChange={(value) => {
        const principal = items.find((p) => p[by] === value);
        if (principal) {
          setInput(principalLabel(principal));
        }
        props.onChange(value, principal);
      }}
      inputValue={input}
      onInputValueChange={(next) => {
        setInput(next);
        search(next);
      }}
      manualFiltering
      openOnFocus
      disabled={props.disabled}
    >
      <ComboboxAnchor>
        <ComboboxInput
          id={props.id}
          aria-label={props.label}
          aria-invalid={props.invalid}
          aria-describedby={props.describedBy}
          placeholder={props.placeholder ?? t('principals.placeholder')}
        />
        <ComboboxTrigger />
      </ComboboxAnchor>
      <ComboboxContent>
        <ComboboxEmpty keepVisible={items.length === 0}>{empty}</ComboboxEmpty>
        {items.map((principal) => (
          <ComboboxItem
            key={principal.id}
            value={principal[by]}
            label={principalLabel(principal)}
          >
            {principalLabel(principal)}
            {principal.kind === 'client' && (
              <span className="ms-1 text-muted-foreground">
                {t('principals.client')}
              </span>
            )}
          </ComboboxItem>
        ))}
      </ComboboxContent>
    </Combobox>
  );
}
