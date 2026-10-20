import { Injectable } from '@nestjs/common';
import { type NextNumberOptions } from './sequences.service.js';

/**
 * A subject whose records take a number. Register from the constructor:
 * `namingSeries.register({ subject: 'Note', sequence: 'note', declared })`.
 * Naming series can only be made for a registered subject (400).
 */
export interface NumberedSubject {
  /** The records' permission subject: `Note`. */
  readonly subject: string;
  /** The `sequences` name its counters take: `note`. */
  readonly sequence: string;
  /** The format in code, used while the tenant has no series of the subject. */
  readonly declared: Pick<
    NextNumberOptions,
    'prefix' | 'perYear' | 'width' | 'separator'
  >;
  /**
   * The create body's fields a series may print (`{customer}`), take its
   * date from (`dateField`) or test (`conditions`), by kind; `boolean`
   * ones only in conditions. None: a series uses dates and variables only.
   */
  readonly fields?: Readonly<Record<string, NumberingFieldKind>>;
}

/** A field as numbering reads it from a create body. */
export type NumberingFieldKind =
  | 'text'
  | 'number'
  | 'date'
  | 'datetime'
  | 'boolean';

@Injectable()
export class NamingSeriesRegistry {
  private readonly subjects = new Map<string, NumberedSubject>();

  register(numbered: NumberedSubject) {
    const known = this.subjects.get(numbered.subject);
    // The same declaration again is harmless (a provider made twice); two are a mistake.
    if (known && known.sequence !== numbered.sequence) {
      throw new Error(`Two numbered subjects are "${numbered.subject}".`);
    }
    this.subjects.set(numbered.subject, numbered);
  }

  /** The registered subject, or undefined. */
  find(subject: string): NumberedSubject | undefined {
    return this.subjects.get(subject);
  }

  /** Every numbered subject. */
  all() {
    return [...this.subjects.values()];
  }
}
