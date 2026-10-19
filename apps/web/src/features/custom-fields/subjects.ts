/**
 * The subjects whose records take custom fields. The API has no list of
 * them (an open backend issue), so each feature that opts in
 * (`--with custom`, docs/custom-fields.md) registers its subject in
 * `features/<feature>/custom-fields.ts` (default export: the subject), as it
 * registers its menu entry in `nav.ts`; removing the feature removes it.
 */
export const CUSTOM_FIELD_SUBJECTS: string[] = Object.values(
  import.meta.glob<string>('../*/custom-fields.ts', {
    eager: true,
    import: 'default',
  }),
).toSorted();
