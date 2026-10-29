import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@nestjs-monorepo-template/ui/components/alert';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CopyIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { recordLinkOf } from '@/features/watching/record-links';
import { useListDescription } from '@/lib/list-query';
import { findDuplicates } from './panels/api';
import { nameOf } from './panels/duplicates-panel';

/** How long the values must stay unchanged before they are checked. */
const SETTLE_MS = 400;

/**
 * A form's warning that the record it would save likely exists already
 * (the subject's `merge` capability: docs/merging.md): the form's values,
 * once they settle, go to `POST <listPath>/duplicates` (`excludeId`: the
 * record being edited), and the records the API finds among those the user
 * may read are listed, each a link to its page. It never blocks the save.
 *
 *   <DuplicatesWarning subject="Note" listPath="/v1/notes"
 *     values={{ title }} excludeId={note?.id} />
 */
export function DuplicatesWarning(props: {
  subject: string;
  listPath: string;
  values: Record<string, string>;
  excludeId?: string;
}) {
  const { t } = useTranslation('records');
  const merge = useListDescription(props.subject).data?.capabilities.merge;
  const key = JSON.stringify(props.values);
  const [settled, setSettled] = useState(props.values);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(props.values), SETTLE_MS);
    return () => clearTimeout(timer);
    // `key` stands for the values: a new object each render, the same text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const filled = Object.values(settled).some((value) => value.trim() !== '');
  const found = useQuery({
    queryKey: ['duplicates', props.listPath, settled, props.excludeId ?? null],
    queryFn: () =>
      findDuplicates(props.listPath, {
        values: settled,
        ...(props.excludeId && { excludeId: props.excludeId }),
      }),
    enabled: !!merge && filled,
    // Only a hint: a failure stays quiet, the save goes on.
    meta: { errorToast: false },
  });
  const items = found.data?.items ?? [];
  if (!merge || !filled || items.length === 0) {
    return null;
  }
  const link = recordLinkOf(props.subject);
  return (
    <Alert role="status">
      <CopyIcon aria-hidden />
      <AlertTitle>{t('duplicates.warning')}</AlertTitle>
      <AlertDescription>
        <ul className="flex flex-col gap-1">
          {items.map((duplicate) => (
            <li key={duplicate.id}>
              {link ? (
                <Link to={link.path(duplicate.id)} className="underline">
                  {nameOf(duplicate)}
                </Link>
              ) : (
                nameOf(duplicate)
              )}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
