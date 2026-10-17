import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { featuresQuery, meQuery, type Features, type Me } from '@/lib/session';

/** A deployment switch that is on or off (`GET /v1/features`). */
export type FeatureName = {
  [K in keyof Features]: Features[K] extends boolean ? K : never;
}[keyof Features];

/** A permission, `Subject.action` (`GET /v1/auth/me`'s `can`). */
export type Permission = `${string}.${string}`;

/** The deployment's switches; undefined while loading (or signed out). */
export function useFeatures(): Features | undefined {
  return useQuery(featuresQuery).data;
}

/** Whether a switch is on (false until known). */
export function useFeature(name: FeatureName): boolean {
  return useFeatures()?.[name] === true;
}

/** The signed-in user (null: nobody; undefined: not known yet). */
export function useMe(): Me | null | undefined {
  return useQuery(meQuery).data;
}

/** Whether the user may do it (false until known). */
export function useCan(permission: Permission): boolean {
  return useMe()?.can[permission] === true;
}

/**
 * Shown only when the switch is on. Hiding is for the user's sake: the API
 * refuses a switched-off route anyway (404 `feature_off`).
 */
export function Feature(props: {
  name: FeatureName;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  return useFeature(props.name) ? props.children : (props.fallback ?? null);
}

/** Shown only with the permission. The API enforces it either way. */
export function Can(props: {
  permission: Permission;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  return useCan(props.permission) ? props.children : (props.fallback ?? null);
}

/** What `feature?` and `permission?` gate: a nav entry, a section. */
export type Gated = { feature?: FeatureName; permission?: Permission };

/** The entries this user sees: their switch on, their permission held. */
export function visible<T extends Gated>(
  items: readonly T[],
  features: Features | undefined,
  can: Record<string, boolean> | undefined,
): T[] {
  return items.filter(
    (item) =>
      (!item.feature || features?.[item.feature] === true) &&
      (!item.permission || can?.[item.permission] === true),
  );
}
