import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { cn } from '@nestjs-monorepo-template/ui/lib/utils';
import { ChevronDownIcon } from 'lucide-react';
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';

/**
 * The app's banners as one strip: the first one shown (pass them most urgent
 * first), and a toggle for the others, so several never push the page down
 * together. Each banner decides on its own whether it shows (it renders
 * nothing otherwise): the strip counts what is there, as it changes.
 */
export function BannerStrip(props: { children: ReactNode }) {
  const { t } = useTranslation();
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(0);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const strip = ref.current;
    if (!strip) {
      return;
    }
    // The banners are other components' elements: `hidden` on all but the
    // first while folded (no wrapper a banner that renders nothing would leave).
    const update = () => {
      const banners = [...strip.children];
      banners.forEach((banner, index) => {
        banner.toggleAttribute('hidden', !open && index > 0);
      });
      setShown(banners.length);
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(strip, { childList: true });
    return () => observer.disconnect();
  }, [open]);
  const more = shown - 1;
  return (
    <div>
      <div ref={ref} id={id}>
        {props.children}
      </div>
      {more > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-full rounded-none border-b text-xs text-muted-foreground"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? t('banners.fewer') : t('banners.more', { count: more })}
          <ChevronDownIcon
            aria-hidden
            className={cn('transition-transform', open && 'rotate-180')}
          />
        </Button>
      )}
    </div>
  );
}
