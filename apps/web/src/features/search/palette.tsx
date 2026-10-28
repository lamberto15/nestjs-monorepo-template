import { useQuery } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Command as CommandRoot,
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@nestjs-monorepo-template/ui/components/command';
import { CornerDownLeftIcon, HistoryIcon, SearchIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { groupBySubject, searchQuery } from './api';
import { Snippet } from './snippet';
import { addRecent, clearRecent, readRecent } from './recent';
import {
  useQuickCommands,
  type QuickCommand,
  type QuickCommandKind,
} from './commands';
import { useOnSessionChange } from '@/hooks/use-on-session-change';
import { normalizeRedirect } from '@/lib/safe-redirect';
import { meQuery, sessionIdentity } from '@/lib/session';

export const DEBOUNCE_MS = 250;

/** The value, once it stopped changing for `delay` ms. */
export function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** The event that opens the palette from elsewhere (the phone's bottom bar). */
const openEvent = 'search-palette:open';

/** Opens the palette: one mounted in the header, whatever button asks. */
export function openSearchPalette() {
  window.dispatchEvent(new Event(openEvent));
}

/** Cmd/Ctrl+K toggles, `openSearchPalette()` opens; Escape is the dialog's own. */
function useShortcut(toggle: () => void, open: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener(openEvent, open);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(openEvent, open);
    };
  }, [toggle, open]);
}

/**
 * The header's search button and the palette it opens (also Cmd/Ctrl+K).
 * Typing searches records (GET /v1/search); `>` lists quick commands.
 */
export function SearchPalette(props: { debounceMs?: number }) {
  const { t } = useTranslation('search');
  const [open, setOpen] = useState(false);
  useShortcut(
    () => setOpen((value) => !value),
    () => setOpen(true),
  );
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t('open')}
        title={t('open')}
        onClick={() => setOpen(true)}
      >
        <SearchIcon />
      </Button>
      {open && (
        <PaletteDialog
          onClose={() => setOpen(false)}
          debounceMs={props.debounceMs ?? DEBOUNCE_MS}
        />
      )}
    </>
  );
}

function PaletteDialog(props: { onClose: () => void; debounceMs: number }) {
  const { t } = useTranslation('search');
  const router = useRouter();
  const [input, setInput] = useState('');
  // The searches of this session only (recent.ts): read once on opening.
  const identity = sessionIdentity(useQuery(meQuery).data);
  const [recent, setRecent] = useState(() => readRecent(identity));
  // What was typed and listed belongs to the session that opened it.
  useOnSessionChange(props.onClose);
  const commandMode = input.startsWith('>');
  const q = useDebounced(input.trim(), props.debounceMs);
  const searching = !commandMode && q.length > 0;
  const results = useQuery({ ...searchQuery(q), enabled: searching });
  const commands = useQuickCommands();
  const groups = useMemo(
    () => groupBySubject(results.data ?? []),
    [results.data],
  );
  const filter = input.slice(1).trim().toLowerCase();
  const shownCommands = commands.filter((c) =>
    c.label.toLowerCase().includes(filter),
  );
  const commandGroups: Array<{
    kind: QuickCommandKind;
    heading: string;
    commands: QuickCommand[];
  }> = (['page', 'action'] as const).map((kind) => ({
    kind,
    heading: t(kind === 'page' ? 'pages' : 'actions'),
    commands: shownCommands.filter((command) => command.kind === kind),
  }));

  const go = (href: string | undefined) => {
    // A link comes from the API: only a path of this app is followed.
    const safe = normalizeRedirect(href);
    if (!safe) {
      return;
    }
    props.onClose();
    void router.navigate({ href: safe });
  };

  return (
    <CommandDialog
      open
      onOpenChange={(next) => !next && props.onClose()}
      title={t('title')}
      description={t('description')}
      className="sm:max-w-xl"
    >
      {/* The API filters and ranks; cmdk only moves the selection. */}
      <CommandRoot shouldFilter={false} label={t('title')}>
        <CommandInput
          value={input}
          onValueChange={setInput}
          placeholder={t('placeholder')}
        />
        {/*
          Always mounted: cmdk's combobox input names this list in
          `aria-controls` whether or not it has real options, and a missing
          target fails axe's "aria-valid-attr-value". A message (hint,
          searching, no hits) is a disabled option of its own, which also
          keeps the listbox's "aria-required-children" (an option or a
          group) satisfied when there is nothing else to show.
        */}
        <CommandList>
          {commandMode ? (
            shownCommands.length === 0 ? (
              <CommandItem
                disabled
                value="no-commands"
                className="py-6 text-center text-sm"
              >
                {t('noCommands')}
              </CommandItem>
            ) : (
              commandGroups.map((group) => (
                <QuickCommandGroup
                  key={group.kind}
                  heading={group.heading}
                  kind={group.kind}
                  commands={group.commands}
                  onSelect={go}
                />
              ))
            )
          ) : searching ? (
            <>
              {results.isPending && (
                <CommandItem
                  disabled
                  value="searching"
                  className="py-6 text-center text-sm"
                >
                  <span role="status">{t('searching')}</span>
                </CommandItem>
              )}
              {results.isError && (
                <CommandItem
                  disabled
                  value="error"
                  className="py-6 text-center text-sm"
                >
                  <span role="alert">{t('error')}</span>
                </CommandItem>
              )}
              {results.isSuccess && groups.length === 0 && (
                <CommandItem
                  disabled
                  value="empty"
                  className="py-6 text-center text-sm"
                >
                  <span role="status">{t('empty', { q })}</span>
                </CommandItem>
              )}
              {groups.map((group) => (
                <CommandGroup key={group.subject} heading={group.label}>
                  {group.items.map((hit) => (
                    <CommandItem
                      key={`${hit.subject}:${hit.id}`}
                      value={`${hit.subject}:${hit.id}`}
                      disabled={normalizeRedirect(hit.link) === undefined}
                      onSelect={() => {
                        setRecent(addRecent(identity, q));
                        go(hit.link ?? undefined);
                      }}
                      className="flex-col items-start gap-0.5"
                    >
                      <span className="font-medium">{hit.title}</span>
                      {hit.snippet && (
                        <span className="line-clamp-2 text-xs text-muted-foreground">
                          <Snippet value={hit.snippet} />
                        </span>
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </>
          ) : (
            <>
              {recent.length > 0 && (
                <CommandGroup heading={t('recent')}>
                  {recent.map((value) => (
                    <CommandItem
                      key={value}
                      value={`recent:${value}`}
                      onSelect={() => setInput(value)}
                    >
                      <HistoryIcon />
                      {value}
                    </CommandItem>
                  ))}
                  <CommandItem
                    value="recent-clear"
                    onSelect={() => {
                      clearRecent(identity);
                      setRecent([]);
                    }}
                  >
                    {t('clearRecent')}
                  </CommandItem>
                </CommandGroup>
              )}
              {/* Below the recent searches, or alone: cmdk's Enter runs the
                  selected (non-disabled) option, so this never intercepts it. */}
              <CommandItem
                disabled
                value="hint"
                className="flex items-center gap-1 px-3 py-4 text-xs text-muted-foreground"
              >
                <CornerDownLeftIcon className="size-3" />
                {t('hint')}
              </CommandItem>
            </>
          )}
        </CommandList>
      </CommandRoot>
    </CommandDialog>
  );
}

function QuickCommandGroup(props: {
  heading: string;
  kind: QuickCommandKind;
  commands: QuickCommand[];
  onSelect: (href: string) => void;
}) {
  if (props.commands.length === 0) {
    return null;
  }
  return (
    <CommandGroup heading={props.heading}>
      {props.commands.map((command) => (
        <CommandItem
          key={`${props.kind}:${command.to}`}
          value={`${props.kind}:${command.to}`}
          onSelect={() => props.onSelect(command.to)}
        >
          <command.icon />
          {command.label}
        </CommandItem>
      ))}
    </CommandGroup>
  );
}
