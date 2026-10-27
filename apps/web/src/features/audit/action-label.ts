import type { TFunction } from 'i18next';

/**
 * An audit action (`member.signed-in`) as people read it: the translated
 * `actions.*` entry when there is one, else the key spelled out ("Member
 * signed in").
 */
export function actionLabel(t: TFunction<'audit'>, action: string): string {
  const spelled = action.replaceAll(/[.\-_]+/g, ' ').trim();
  return t(`actions.${action}`, {
    defaultValue: spelled.charAt(0).toUpperCase() + spelled.slice(1),
  });
}
