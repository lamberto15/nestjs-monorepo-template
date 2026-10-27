import { Input } from '@nestjs-monorepo-template/ui/components/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@nestjs-monorepo-template/ui/components/select';
import { Switch } from '@nestjs-monorepo-template/ui/components/switch';
import { Textarea } from '@nestjs-monorepo-template/ui/components/textarea';
import type { TFunction } from 'i18next';
import type { Draft, Invalid, ValueSpec } from './settings';

/** The input for a value of this setting's declared type (see `Kind`). */
export function ValueInput(props: {
  id: string;
  label: string;
  spec: ValueSpec;
  value: Draft;
  onChange: (value: Draft) => void;
  disabled?: boolean;
  invalid?: boolean;
  /** The ids of the hint and the error shown beside it (`useDescribedBy`). */
  describedBy?: string;
}) {
  const { id, spec, value, onChange, disabled } = props;
  switch (spec.type) {
    case 'boolean':
      return (
        <Switch
          id={id}
          aria-label={props.label}
          aria-describedby={props.describedBy}
          checked={value === true}
          onCheckedChange={onChange}
          disabled={disabled}
        />
      );
    case 'enum': {
      const options = (spec.options ?? []).map((option) => ({
        value: String(option),
        label: String(option),
      }));
      return (
        <Select
          items={options}
          value={String(value) || null}
          onValueChange={(next) => onChange(next ?? '')}
          disabled={disabled}
        >
          <SelectTrigger
            id={id}
            aria-label={props.label}
            aria-invalid={props.invalid}
            aria-describedby={props.describedBy}
            className="w-full"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }
    case 'json':
      return (
        <Textarea
          id={id}
          aria-label={props.label}
          aria-invalid={props.invalid}
          aria-describedby={props.describedBy}
          className="font-mono"
          rows={4}
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
        />
      );
    case 'number':
      return (
        <Input
          id={id}
          aria-label={props.label}
          aria-invalid={props.invalid}
          aria-describedby={props.describedBy}
          type="number"
          min={spec.min}
          max={spec.max}
          step={spec.integer ? 1 : 'any'}
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
        />
      );
    default:
      return (
        <Input
          id={id}
          aria-label={props.label}
          aria-invalid={props.invalid}
          aria-describedby={props.describedBy}
          type="text"
          maxLength={spec.maxLength}
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
        />
      );
  }
}

/** What a number setting takes, for the input's hint ("From 12 to 64."). */
export function boundsHint(
  spec: ValueSpec,
  t: TFunction<'settings'>,
): string | undefined {
  if (spec.type === 'number') {
    if (spec.min !== undefined && spec.max !== undefined) {
      return t('bounds.between', { min: spec.min, max: spec.max });
    }
    if (spec.min !== undefined) {
      return t('bounds.min', { min: spec.min });
    }
    if (spec.max !== undefined) {
      return t('bounds.max', { max: spec.max });
    }
  }
  if (spec.type === 'string' && spec.maxLength !== undefined) {
    return t('bounds.maxLength', { maxLength: spec.maxLength });
  }
  return undefined;
}

/** The text of a refused draft. */
export function invalidText(invalid: Invalid, t: TFunction<'settings'>) {
  return t(`invalid.${invalid.reason}`, { limit: invalid.limit });
}

/** A value as text, for a table cell. */
export function formatValue(value: unknown, on: string, off: string): string {
  if (typeof value === 'boolean') {
    return value ? on : off;
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * A setting's value for a table cell: `null` is "No limit" for a quota and
 * "Not set" elsewhere; the dashboard layout is a summary, not its JSON.
 */
export function displayValue(
  key: string,
  value: unknown,
  t: TFunction<'settings'>,
): string {
  if (value === null || value === undefined) {
    return key.startsWith('quotas.') ? t('noLimit') : t('notSet');
  }
  if (key === 'dashboard.layout' && typeof value === 'object') {
    const { order, hidden } = value as { order?: unknown; hidden?: unknown };
    const counts = {
      ordered: Array.isArray(order) ? order.length : 0,
      hidden: Array.isArray(hidden) ? hidden.length : 0,
    };
    return counts.ordered + counts.hidden === 0
      ? t('layoutDefault')
      : t('layoutSummary', counts);
  }
  return formatValue(value, t('on'), t('off'));
}
