/**
 * What the unit tree needs from the access engine (iam/access) without
 * importing it: the engine reads units, so units never read the engine.
 * IamModule binds it to AccessService.
 */
export abstract class UnitAccess {
  /** Drops the cached abilities on every instance: after any unit or membership change. */
  abstract invalidate(): void;

  /** A user's units as the unit conditions read them (`AccessService.unitContext()`), in the current transaction. */
  abstract unitContext(
    userId: string,
  ): Promise<{ unitIdsAndBelow: string[]; ledUnitIdsAndBelow: string[] }>;
}
