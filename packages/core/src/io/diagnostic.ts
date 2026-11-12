/**
 * The diagnostics channel (#112, owner decision: option 3): a reader or
 * writer reports a non-fatal issue as a warning log record annotated with its
 * {@link Diagnostic}, so no `Reader` / `Writer` signature changes and no
 * service is required; `convert` (and {@link collectDiagnostics}) gather the
 * records into the report. A log record is also an ordinary warning, so a
 * direct `reader.read` call still shows it through the app's loggers.
 */

import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Diagnostic } from "../profile/loss.ts";

/** The log annotation a {@link Diagnostic} travels under; its value is the diagnostic itself. */
export const DIAGNOSTIC_ANNOTATION = "effect-document/diagnostic";

const isDiagnostic = Schema.is(Diagnostic);

/**
 * Report `diagnostic`: a warning log record (`Effect.logWarning`) whose
 * message is the format and detail, annotated with the diagnostic under
 * {@link DIAGNOSTIC_ANNOTATION}. Never fails. A `MinimumLogLevel` above
 * `Warn` filters it out before any logger sees it, `convert`'s collector
 * included, so a caller that raises the level gives up the report's
 * diagnostics.
 */
export const logDiagnostic = (diagnostic: Diagnostic): Effect.Effect<void> =>
  Effect.logWarning(`${diagnostic.format}: ${diagnostic.detail}`).pipe(
    Effect.annotateLogs(DIAGNOSTIC_ANNOTATION, diagnostic),
  );

/** Report each of `diagnostics` in order, as {@link logDiagnostic} does; nothing for none. */
export const logDiagnostics = (diagnostics: ReadonlyArray<Diagnostic>): Effect.Effect<void> =>
  Effect.forEach(diagnostics, logDiagnostic, { concurrency: 1, discard: true });

/**
 * Run `effect` and gather the diagnostics it reports (by {@link logDiagnostic}),
 * in order. The records still reach the loggers already installed, so
 * collecting changes nothing a caller's logs show. Other log records are
 * ignored.
 *
 * ```ts
 * const [doc, diagnostics] = yield* collectDiagnostics(reader.read(input));
 * ```
 */
export const collectDiagnostics = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<readonly [A, ReadonlyArray<Diagnostic>], E, R> =>
  Effect.suspend(() => {
    const found: Array<Diagnostic> = [];
    const collector = Logger.make(({ fiber }) => {
      const value = fiber.getRef(References.CurrentLogAnnotations)[DIAGNOSTIC_ANNOTATION];
      if (isDiagnostic(value)) found.push(value);
    });
    return Effect.map(Effect.withLogger(effect, collector), (a) => [a, found] as const);
  });
