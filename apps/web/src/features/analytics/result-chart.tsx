import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@nestjs-monorepo-template/ui/components/chart';
import { useTranslation } from 'react-i18next';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from 'recharts';
import { display } from './display';
import type { QueryResult } from './engine';

export type ChartKind = 'group' | 'histogram' | 'series';

const label = (value: unknown, language: string) =>
  typeof value === 'number'
    ? new Intl.NumberFormat(language, { maximumSignificantDigits: 4 }).format(
        value,
      )
    : display(value);

/**
 * One chart of a bounded query result: `value` against the first column (the
 * group, the bin's start or the time bucket). Rows whose value is not a number
 * (an empty group's MIN, say) are left out.
 */
export function ResultChart(props: {
  kind: ChartKind;
  result: QueryResult;
  valueLabel: string;
}) {
  const { t, i18n } = useTranslation('analytics');
  const xKey = props.result.columns[0];
  const data = xKey
    ? props.result.rows
        .filter((row) => Number.isFinite(row.value))
        .map((row) => ({
          x: label(row[xKey], i18n.language),
          value: row.value as number,
        }))
    : [];
  if (data.length === 0) return null;
  const config = {
    value: { label: props.valueLabel, color: 'var(--chart-1)' },
  } satisfies ChartConfig;
  const axes = (
    <>
      <CartesianGrid vertical={false} />
      <XAxis dataKey="x" tickLine={false} axisLine={false} tickMargin={8} />
      <YAxis width={48} tickLine={false} axisLine={false} />
      <ChartTooltip content={<ChartTooltipContent />} />
    </>
  );
  return (
    <figure aria-label={t(`chartKinds.${props.kind}`)}>
      <ChartContainer config={config} className="h-64 w-full">
        {props.kind === 'series' ? (
          <LineChart accessibilityLayer data={data}>
            {axes}
            <Line
              dataKey="value"
              type="monotone"
              stroke="var(--color-value)"
              strokeWidth={2}
              dot={data.length < 40}
            />
          </LineChart>
        ) : (
          <BarChart accessibilityLayer data={data}>
            {axes}
            <Bar dataKey="value" fill="var(--color-value)" radius={3} />
          </BarChart>
        )}
      </ChartContainer>
    </figure>
  );
}
