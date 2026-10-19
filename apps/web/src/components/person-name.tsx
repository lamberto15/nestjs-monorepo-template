import { usePeopleNames, useTeamNames } from '@/lib/people';

/** A principal's name (`user:<id>`, `client:<id>`); the key itself until known. */
export function PersonName({ value }: { value: string }) {
  return <>{usePeopleNames([value]).name(value)}</>;
}

/** A team's name; its id until known. */
export function TeamName({ value }: { value: string }) {
  return <>{useTeamNames([value]).name(value)}</>;
}
