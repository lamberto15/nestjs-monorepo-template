import {
  type Announcements,
  KeyboardSensor,
  MouseSensor,
  type ScreenReaderInstructions,
  TouchSensor,
  type UniqueIdentifier,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

/** How long a finger rests on a handle before it drags (shorter: it scrolls). */
const TOUCH_DELAY_MS = 200;
/** How far it may wander meanwhile, in px, and still pick the item up. */
const TOUCH_TOLERANCE_PX = 6;

type Data = { current?: { sortable?: { index?: number } } } | undefined;
const position = (data: Data) => (data?.current?.sortable?.index ?? 0) + 1;

/**
 * Props for a Dice UI `Sortable` (packages/ui, generated) that it lets a
 * caller replace: a touch that waits a moment before it drags, so a finger
 * on a handle can still scroll the page, and screen-reader announcements in
 * the user's language that name the item (`labelOf` its id), where the
 * component's own are English and read the id out.
 */
export function useSortableProps(
  count: number,
  labelOf: (id: UniqueIdentifier) => string,
) {
  const { t } = useTranslation();
  const sensors = useSensors(
    useSensor(MouseSensor),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: TOUCH_DELAY_MS,
        tolerance: TOUCH_TOLERANCE_PX,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const accessibility = useMemo(() => {
    const moved = (key: 'moved' | 'dropped') =>
      (({ active, over }) =>
        over
          ? t(`sortable.${key}`, {
              item: labelOf(active.id),
              position: position(over.data),
              count,
            })
          : t(key === 'moved' ? 'sortable.outside' : 'sortable.unchanged', {
              item: labelOf(active.id),
            })) satisfies Announcements['onDragOver'];
    const announcements: Announcements = {
      onDragStart: ({ active }) =>
        t('sortable.picked', {
          item: labelOf(active.id),
          position: position(active.data),
          count,
        }),
      onDragOver: moved('moved'),
      onDragEnd: moved('dropped'),
      onDragCancel: ({ active }) =>
        t('sortable.cancelled', {
          item: labelOf(active.id),
          position: position(active.data),
          count,
        }),
    };
    const screenReaderInstructions: ScreenReaderInstructions = {
      draggable: t('sortable.instructions'),
    };
    return { announcements, screenReaderInstructions };
  }, [t, labelOf, count]);
  return { sensors, accessibility };
}
