/**
 * Test harness.
 *
 * Effect runs `Effect.gen` bodies inside its own runtime, so an exception thrown
 * by `expect` becomes a *defect* in the fiber rather than a rejected promise. A
 * test that simply awaits such an effect therefore passes no matter what its
 * assertions say — silently, and with "0 expect() calls" as the only hint.
 *
 * `runScoped` closes that hole: it runs the effect against a fresh in-memory
 * database and re-throws the original defect, so assertion failures surface as
 * ordinary test failures. Always use it (or `runLive`) instead of awaiting an
 * Effect directly.
 */
import { Cause, Effect, Exit, Option } from "effect"
import type { Layer } from "effect/Layer"
import type * as SqlClient from "@effect/sql/SqlClient"
import { withTestDatabase } from "../src/db/database.ts"

/** Rethrow whatever killed the fiber, so bun:test reports the real failure. */
const rethrow = (cause: Cause.Cause<unknown>): never => {
  const defect = Cause.dieOption(cause)
  if (Option.isSome(defect)) throw defect.value
  // `renderErrorCause` walks into an error's own `cause` chain; without it a
  // wrapped SqlError prints as a bare "Failed to execute statement".
  throw new Error(Cause.pretty(cause, { renderErrorCause: true }))
}

/** Run an effect against a fresh in-memory database. */
export const runScoped = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromiseExit(withTestDatabase(effect)).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value
    return rethrow(exit.cause)
  })

/**
 * Run an effect that needs an explicit layer, e.g. an HTTP client.
 *
 * Same defect handling; the caller supplies whatever provides the requirements.
 */
export const runWith = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  layer: Layer<R, never, never>
): Promise<A> =>
  Effect.runPromiseExit(Effect.provide(effect, layer)).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value
    return rethrow(exit.cause)
  })

/** Run a plain effect with no requirements. */
export const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromiseExit(effect).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value
    return rethrow(exit.cause)
  })
