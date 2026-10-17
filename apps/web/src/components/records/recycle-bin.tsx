import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Trash2Icon } from 'lucide-react';
import { parseAsBoolean, parseAsInteger, useQueryState } from 'nuqs';

/**
 * Whether a list shows the recycle bin: `?deleted=true` in the URL (nuqs),
 * which becomes ListPage's `query` (`GET /v1/<x>?deleted=true`). Going in or
 * out starts again at the first page.
 */
export function useRecycleBin() {
  const [deleted, setDeleted] = useQueryState(
    'deleted',
    parseAsBoolean.withDefault(false),
  );
  const [, setPage] = useQueryState('page', parseAsInteger);
  const toggle = () => {
    void setPage(null);
    void setDeleted(deleted ? null : true);
  };
  return { deleted, toggle };
}

/** The toggle for it, pressed while the bin is shown. */
export function RecycleBinToggle(props: {
  label: string;
  pressed: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      type="button"
      variant={props.pressed ? 'secondary' : 'outline'}
      aria-pressed={props.pressed}
      onClick={props.onToggle}
    >
      <Trash2Icon />
      {props.label}
    </Button>
  );
}
