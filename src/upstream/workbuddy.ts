/**
 * workbuddy2api adapter.
 *
 * The upstream is an OpenAI-compatible reverse proxy over a pool of accounts, so
 * chat completions, SSE framing and model listing are byte-identical to
 * `openai-chat` and are shared through `chatCompletion`. What is unique — and the
 * only reason this is a separate provider kind — is `/status`, which reports the
 * credit balance of every account in the pool.
 */
import * as HttpClient from "@effect/platform/HttpClient"
import * as Effect from "effect/Effect"
import { asBoolean, asNumber, asRecordArray, asString, firstNumber, isRecord } from "../json.ts"
import type { Credits, CreditsAccount, Provider } from "../domain.ts"
import { providerError, type ProviderError } from "../errors.ts"
import type { Adapter } from "./adapter.ts"
import { chatCompletion, getRequest } from "./chat-adapter.ts"
import { decodeJson, errorMessageFrom, execute, transportFailure } from "./http.ts"

const STATUS_PATH = "/status"

export const workbuddyAdapter: Adapter = chatCompletion("workbuddy2api")

/**
 * Read the pool's credit snapshot.
 *
 * The pool's balance is the sum of its per-account balances, and its healthy count is
 * the number of accounts that are neither cooling nor disabled. Those are always derived
 * from the rows rather than read from the payload's own `total` / `healthy` fields:
 * workbuddy2api uses `total` for the *number of accounts in the pool*, so trusting it
 * reported a two-account pool holding 7032 credits as "2".
 *
 * The payload's own figures are used only when it names no accounts at all, which is
 * how a build that states a balance and no rows still works.
 */
export const fetchCredits = (
  provider: Provider
): Effect.Effect<Credits, ProviderError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const response = yield* execute(provider, getRequest(provider, STATUS_PATH))
    const body = yield* response.text.pipe(
      Effect.mapError((cause) => transportFailure(provider, cause))
    )
    const json = yield* decodeJson(provider, body)
    // Recent builds wrap the snapshot in `{data: …}`; older ones answer flat.
    const payload = isRecord(json) && isRecord(json.data) ? json.data : json
    // A proxy often reports failure as HTTP 200 with an error body. That is not an
    // empty pool: treating it as one would report a funded account as zero and — via
    // `refreshCredits` — overwrite the last known balance with it. A real snapshot
    // always carries the list, even when the pool is empty.
    if (!isRecord(payload) || !Array.isArray(payload.accounts)) {
      return yield* Effect.fail(
        providerError({
          provider_id: provider.id,
          provider_name: provider.name,
          kind: "network",
          status: 200,
          message: errorMessageFrom(body, "upstream returned no account list"),
          body
        })
      )
    }
    const accounts = asRecordArray(payload.accounts).map(toAccount)
    const total = asNumber(payload.total)
    const healthy = asNumber(payload.healthy)

    return {
      provider_id: provider.id,
      total: accounts.length > 0 ? accounts.reduce((sum, account) => sum + account.credits, 0) : (total ?? 0),
      healthy:
        accounts.length > 0
          ? accounts.filter((account) => account.cooling !== true && account.disabled !== true).length
          : (healthy ?? 0),
      accounts,
      fetched_at: Date.now(),
      // Adapters never invent a partial failure: anything short of a complete
      // snapshot fails the effect, so a returned one is always usable.
      error: null
    }
  })

const toAccount = (raw: Record<string, unknown>): CreditsAccount => ({
  uid: asString(raw.uid) ?? "",
  nickname: asString(raw.nickname) ?? undefined,
  realm: asString(raw.realm) ?? undefined,
  credits: firstNumber(raw.credits),
  cooling: asBoolean(raw.cooling) ?? undefined,
  disabled: asBoolean(raw.disabled) ?? undefined,
  disabled_reason: asString(raw.disabled_reason) ?? undefined
})
