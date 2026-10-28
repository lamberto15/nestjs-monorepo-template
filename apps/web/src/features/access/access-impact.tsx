import type { TFunction } from 'i18next';
import type { AccessImpact, Unit } from '@/features/access/api';

/**
 * What a preview says (`POST …/impact`, docs/permissions.md "Organization
 * structure"), for a confirmation: each person whose reach would change,
 * with the units they would gain or lose under "my units and below" and
 * "units I lead and below", one line each.
 */
export function ImpactSummary(props: {
  impact: AccessImpact;
  units: readonly Unit[];
  t: TFunction;
}) {
  const { impact, t } = props;
  const names = (ids: string[]) =>
    ids
      .map((id) => props.units.find((unit) => unit.id === id)?.name ?? id)
      .join(', ');
  const lines = impact.changes.map((change) => {
    const parts = (
      [
        ['andBelow', change.andBelow],
        ['ledAndBelow', change.ledAndBelow],
      ] as const
    ).flatMap(([reach, { gains, loses }]) => [
      ...(gains.length
        ? [t(`units.impact.${reach}.gains`, { units: names(gains) })]
        : []),
      ...(loses.length
        ? [t(`units.impact.${reach}.loses`, { units: names(loses) })]
        : []),
    ]);
    return `${change.name || change.email}: ${parts.join('; ')}`;
  });
  return (
    <span className="whitespace-pre-line">
      {[
        impact.changes.length
          ? t('units.impact.some', { count: impact.changes.length })
          : t('units.impact.none'),
        ...lines,
        ...(impact.truncated ? [t('units.impact.truncated')] : []),
      ].join('\n')}
    </span>
  );
}
