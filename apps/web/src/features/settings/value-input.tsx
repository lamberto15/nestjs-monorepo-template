import { Input } from '@nestjs-monorepo-template/ui/components/input';
import { Switch } from '@nestjs-monorepo-template/ui/components/switch';
import { Textarea } from '@nestjs-monorepo-template/ui/components/textarea';
import type { Draft, Kind } from './settings';

/** The input for a value of this kind (see `kindOf`). */
export function ValueInput(props: {
  id: string;
  label: string;
  kind: Kind;
  value: Draft;
  onChange: (value: Draft) => void;
  disabled?: boolean;
}) {
  const { id, kind, value, onChange, disabled } = props;
  if (kind === 'boolean') {
    return (
      <Switch
        id={id}
        aria-label={props.label}
        checked={value === true}
        onCheckedChange={onChange}
        disabled={disabled}
      />
    );
  }
  if (kind === 'json') {
    return (
      <Textarea
        id={id}
        aria-label={props.label}
        className="font-mono"
        rows={4}
        value={String(value)}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      />
    );
  }
  return (
    <Input
      id={id}
      aria-label={props.label}
      type={kind === 'number' ? 'number' : 'text'}
      value={String(value)}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
    />
  );
}

/** A value as text, for a table cell. */
export function formatValue(value: unknown, on: string, off: string): string {
  if (typeof value === 'boolean') {
    return value ? on : off;
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}
