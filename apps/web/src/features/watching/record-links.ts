/**
 * Where a watched record opens, and what it is called. The subscriptions list
 * gives a subject and an id only, so each feature with record pages registers
 * its subject in `features/<feature>/record-link.ts` (default export), as it
 * registers its menu entry in `nav.ts`; removing the feature removes it. A
 * subject without one is listed by its name and id, still with a stop button.
 */
export type RecordLink = {
  subject: string;
  /** The record's page in the web app. */
  path: (id: string) => string;
  /** Its name, read from the API (the list shows it in place of the id). */
  title: (id: string) => Promise<string>;
};

const LINKS = Object.values(
  import.meta.glob<RecordLink>('../*/record-link.ts', {
    eager: true,
    import: 'default',
  }),
);

export const recordLinkOf = (subject: string): RecordLink | undefined =>
  LINKS.find((link) => link.subject === subject);
