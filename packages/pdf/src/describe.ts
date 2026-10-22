/**
 * How the reader and writer word a caught failure in their `reason`.
 */

import * as Predicate from "effect/Predicate";

/** A caught failure's message (every error the codec throws has one), else its string form. */
export const describeCause = (cause: unknown): string =>
  Predicate.hasProperty(cause, "message") && Predicate.isString(cause.message)
    ? cause.message
    : String(cause);
