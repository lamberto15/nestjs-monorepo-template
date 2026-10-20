/**
 * A feature module's record declaration, as an injection token
 * (record-parts.ts provides it). Apart from record-contract.ts so the
 * `?include=` pipe (record-can.ts) can inject it without an import cycle.
 */
export const RECORD_DECLARATION = Symbol('RECORD_DECLARATION');
