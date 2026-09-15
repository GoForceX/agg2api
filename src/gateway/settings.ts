/**
 * Boot settings as a service.
 *
 * Handlers and the executor need a handful of numeric limits from the config
 * (timeouts, breaker thresholds). Publishing them through the context keeps those
 * consumers free of a requirement on the config *loader*, so they can be exercised
 * in tests with hand-built settings.
 */
import * as Context from "effect/Context"
import type { Settings } from "../config.ts"

export class AppSettings extends Context.Tag("AppSettings")<AppSettings, Settings>() {}

/** Server start time, for the dashboard's uptime figure. */
export class StartedAt extends Context.Tag("StartedAt")<StartedAt, number>() {}
