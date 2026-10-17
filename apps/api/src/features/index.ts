import type { FeatureDefinition } from './feature.js';
import { NOTES_FEATURE } from './notes/notes.feature.js';
// pnpm feature:add: imports above this line.

/**
 * Every feature, in order: app.module.ts hands their declarations to the
 * groups, openapi.ts their Swagger tags. `pnpm feature:add` appends here;
 * with features/tables.ts (and features/env.ts when it has variables),
 * that is all a feature changes outside its folder.
 */
export const FEATURES: readonly FeatureDefinition[] = [
  NOTES_FEATURE,
  // pnpm feature:add: features above this line.
];
