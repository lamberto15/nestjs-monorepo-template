import { usePeopleNames, useUnitNames } from '@/lib/people';

/** A principal's name (`user:<id>`, `client:<id>`); the key itself until known. */
export function PersonName({ value }: { value: string }) {
  return <>{usePeopleNames([value]).name(value)}</>;
}

/** A unit's name; its id until known. */
export function UnitName({ value }: { value: string }) {
  return <>{useUnitNames([value]).name(value)}</>;
}
