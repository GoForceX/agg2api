/**
 * Capability inference.
 *
 * The three tiers are not interchangeable, so each is exercised against the shape of
 * input that selects it: an upstream that states modalities, an upstream identified by
 * its base URL, and an id matched across the catalogue.
 */
import { describe, expect, test } from "bun:test"
import {
  buildIndex,
  hostOf,
  resolveModel,
  normaliseModelId,
  parseStored,
  reportedCapabilities
} from "../src/models/capabilities.ts"

/** A `models.dev` document, trimmed to the fields the index reads. */
const catalogue = (
  providers: Record<string, { api?: string; models: Record<string, string[] | { input: string[]; context?: number; output?: number }> }>
): unknown => {
  const out: Record<string, unknown> = {}
  for (const [id, provider] of Object.entries(providers)) {
    const models: Record<string, unknown> = {}
    for (const [modelId, spec] of Object.entries(provider.models)) {
      const input = Array.isArray(spec) ? spec : spec.input
      models[modelId] = {
        name: modelId,
        modalities: { input, output: ["text"] },
        tool_call: true,
        ...(Array.isArray(spec) ? {} : { limit: { context: spec.context, output: spec.output } })
      }
    }
    out[id] = { id, api: provider.api, models }
  }
  return out
}

describe("normaliseModelId", () => {
  test("folds the spellings that differ only by provenance", () => {
    // These are one model; a lookup that treats them as three misses two of them.
    const same = ["gpt-4o", "openai/gpt-4o", "gpt-4o:latest", "GPT-4O"]
    for (const id of same) expect(normaliseModelId(id)).toBe("gpt-4o")
    expect(normaliseModelId("claude-3-5-sonnet-20241022")).toBe("claude-3-5-sonnet")
    expect(normaliseModelId("claude-3-5-sonnet-2024-10-22")).toBe("claude-3-5-sonnet")
  })
})

describe("hostOf", () => {
  test("reduces a base URL to the host that identifies the provider", () => {
    expect(hostOf("https://api.deepseek.com/v1")).toBe("api.deepseek.com")
    expect(hostOf("api.deepseek.com")).toBe("api.deepseek.com")
    expect(hostOf("http://127.0.0.1:8080/v1")).toBe("127.0.0.1")
    expect(hostOf("not a url")).toBe(null)
  })
})

describe("reportedCapabilities", () => {
  test("reads OpenRouter's architecture block", () => {
    const reported = reportedCapabilities({
      architecture: { input_modalities: ["text", "image", "file"], output_modalities: ["text"] }
    })
    expect(reported?.input).toEqual(["text", "image", "pdf"])
    expect(reported?.output).toEqual(["text"])
  })

  test("reads the compact modality string that predates the arrays", () => {
    const reported = reportedCapabilities({ architecture: { modality: "text+image->text" } })
    expect(reported?.input).toEqual(["text", "image"])
    expect(reported?.output).toEqual(["text"])
  })

  test("maps an unknown modality to nothing rather than passing it through", () => {
    const reported = reportedCapabilities({ architecture: { input_modalities: ["text", "hologram"] } })
    expect(reported?.input).toEqual(["text"])
  })

  test("reports no claim when the entry carries no capability field at all", () => {
    // This is what OpenAI itself returns; returning a claim here would mask tiers 2 and 3.
    expect(reportedCapabilities({ id: "gpt-4o", owned_by: "openai" })).toBe(null)
  })
})

describe("inferCapabilities", () => {
  const index = buildIndex(
    catalogue({
      openai: { api: "https://api.openai.com/v1", models: { "gpt-4o": ["text", "image"] } },
      mirror: { api: "https://mirror.example/v1", models: { "gpt-4o": ["text", "image"] } },
      reseller: { api: "https://reseller.example/v1", models: { "gpt-4o": ["text"] } }
    })
  )

  test("tier 1 — an upstream claim wins even when the index disagrees", () => {
    const resolved = resolveModel(index, {
      upstreamId: "gpt-4o",
      baseUrl: "https://api.openai.com/v1",
      reported: { input: ["text"] }
    })
    expect(resolved.capabilities?.source).toBe("upstream")
    expect(resolved.capabilities?.input).toEqual(["text"])
  })

  test("tier 2 — the provider is identified by base URL, so only its entry applies", () => {
    // The point of this tier: a reseller serving a reduced variant must be answered by
    // the reseller's own entry, not by the plurality of everyone else.
    const reseller = resolveModel(index, {
      upstreamId: "gpt-4o",
      baseUrl: "https://reseller.example/v1",
      reported: null
    })
    expect(reseller.capabilities?.source).toBe("models.dev")
    expect(reseller.capabilities?.input).toEqual(["text"])

    const firstParty = resolveModel(index, {
      upstreamId: "gpt-4o",
      baseUrl: "https://api.openai.com/v1",
      reported: null
    })
    expect(firstParty.capabilities?.source).toBe("models.dev")
    expect(firstParty.capabilities?.input).toEqual(["text", "image"])
  })

  test("tier 3 — an unknown provider falls back to the catalogue vote", () => {
    const resolved = resolveModel(index, {
      upstreamId: "gpt-4o",
      baseUrl: "http://10.0.0.7:8000",
      reported: null
    })
    expect(resolved.capabilities?.source).toBe("models.dev-nearest")
    // Two of the three entries say image; the dissenting reseller is outvoted.
    expect(resolved.capabilities?.input).toEqual(["text", "image"])
  })

  test("still resolves through the URL path when the exact id is absent", () => {
    const resolved = resolveModel(index, {
      upstreamId: "gpt-4o-2024-08-06",
      baseUrl: "https://api.openai.com/v1",
      reported: null
    })
    expect(resolved.capabilities?.source).toBe("models.dev")
    expect(resolved.capabilities?.input).toEqual(["text", "image"])
  })

  test("declines to guess when the id is genuinely ambiguous", () => {
    // A split vote means the id names different things to different providers, so any
    // answer would be a coin flip.
    const split = buildIndex(
      catalogue({
        a: { api: "https://a.example/v1", models: { "mystery": ["text"] } },
        b: { api: "https://b.example/v1", models: { "mystery": ["text", "image"] } }
      })
    )
    expect(
      resolveModel(split, { upstreamId: "mystery", baseUrl: "http://unknown", reported: null }).capabilities
    ).toBe(null)
  })

  test("reports null — not a text-only guess — when nothing is known", () => {
    const priv = resolveModel(index, { upstreamId: "private-model", baseUrl: "http://10.0.0.7", reported: null })
    expect(priv.capabilities).toBe(null)
    expect(priv.context_length).toBe(null)
    expect(resolveModel(null, { upstreamId: "gpt-4o", baseUrl: "x", reported: null }).capabilities).toBe(null)
  })

  test("tolerates a malformed document instead of throwing", () => {
    // This is a third-party file fetched over the network; a shape change upstream must
    // degrade to "no inference", not take the gateway down.
    for (const bad of [null, 42, "x", [], { openai: "nope" }, { openai: { models: 7 } }]) {
      const built = buildIndex(bad)
      expect(built.size).toBe(0)
      expect(
        resolveModel(built, { upstreamId: "gpt-4o", baseUrl: "x", reported: null }).capabilities
      ).toBe(null)
    }
  })
})

describe("namespaced ids", () => {
  // A pool prefixes its catalogue (`cn:glm-5.3-flash`); without stripping the namespace
  // none of these resolve, which is why an entire provider can report no capabilities.
  const index = buildIndex(
    catalogue({
      zai: { api: "https://api.z.ai/v1", models: { "glm-5.3-flash": ["text", "image", "video", "pdf"] } },
      deepseek: { api: "https://api.deepseek.com/v1", models: { "deepseek-v4-pro": ["text"] } },
      // Listed only here, not under models.dev's own `deepseek` entry — the shape of the
      // real case a proxy produces.
      reseller: { api: "https://reseller.example/v1", models: { "deepseek-v4.1-flash": ["text", "image"] } }
    })
  )

  test("a pool namespace resolves to the underlying model", () => {
    const facts = resolveModel(index, {
      upstreamId: "cn:glm-5.3-flash",
      baseUrl: "http://host.docker.internal:7863",
      reported: null
    })
    expect(facts.capabilities?.input).toEqual(["text", "image", "video", "pdf"])
  })

  test("a tag suffix is still read as a tag, not as a namespace", () => {
    expect(normaliseModelId("gpt-4o:latest")).toBe("gpt-4o")
    expect(normaliseModelId("cn:glm-5.3-flash")).toBe("glm-5.3-flash")
    expect(normaliseModelId("global:gpt-5.4")).toBe("gpt-5.4")
  })

  test("a known provider that lacks the id falls through to the id vote", () => {
    // The real case: a proxy in front of DeepSeek serves `deepseek-v4.1-flash`, which
    // models.dev's own deepseek entry does not list. Stopping at tier 2 would report
    // nothing; falling through resolves it.
    const facts = resolveModel(index, {
      upstreamId: "deepseek-v4.1-flash",
      baseUrl: "https://api.deepseek.com",
      reported: null
    })
    expect(facts.capabilities).not.toBe(null)
  })
})

describe("resolveModel limits", () => {
  // Two providers agree, so the vote is a majority rather than a tie.
  const index = buildIndex(
    catalogue({
      openai: {
        api: "https://api.openai.com/v1",
        models: { "gpt-4o": { input: ["text", "image"], context: 128_000, output: 16_384 } }
      },
      mirror: {
        api: "https://mirror.example/v1",
        models: { "gpt-4o": { input: ["text", "image"], context: 128_000, output: 16_384 } }
      }
    })
  )
  // The fixture above only sets modalities, so limits come from a document with them.
  const withLimits = buildIndex(
    catalogue({
      openai: {
        api: "https://api.openai.com/v1",
        models: { "gpt-4o": { input: ["text", "image"], context: 128_000, output: 16_384 } }
      }
    })
  )

  test("an upstream-reported window wins over the catalogue's", () => {
    const facts = resolveModel(withLimits, {
      upstreamId: "gpt-4o",
      baseUrl: "https://api.openai.com/v1",
      reported: null,
      reportedContextLength: 999
    })
    expect(facts.context_length).toBe(999)
  })

  test("a provider that reports nothing still gets the catalogue's limits", () => {
    // This is the case that made `context_length` null for every OpenAI-compatible
    // upstream: they report only an id, and the value was never looked up.
    const facts = resolveModel(index, {
      upstreamId: "gpt-4o",
      baseUrl: "https://api.openai.com/v1",
      reported: null
    })
    expect(facts.capabilities?.input).toEqual(["text", "image"])
    expect(facts.context_length).toBe(128_000)
    expect(facts.max_output_tokens).toBe(16_384)
  })

  test("a provider with no index and no report stays honestly null", () => {
    const facts = resolveModel(null, {
      upstreamId: "m",
      baseUrl: "http://x",
      reported: null,
      reportedContextLength: 8_192
    })
    expect(facts.context_length).toBe(8_192)
    expect(facts.max_output_tokens).toBe(null)
  })
})

describe("parseStored", () => {
  test("round-trips a stored capability and rejects anything unusable", () => {
    expect(parseStored('{"input":["text","image"],"output":["text"],"source":"models.dev"}')?.input)
      .toEqual(["text", "image"])
    // Empty string is what the migration's DEFAULT writes.
    expect(parseStored("")).toBe(null)
    expect(parseStored(null)).toBe(null)
    expect(parseStored("{not json")).toBe(null)
    expect(parseStored('{"input":[]}')).toBe(null)
    // A source outside the enum would be rendered verbatim by the UI.
    expect(parseStored('{"input":["text"],"source":"guessed"}')).toBe(null)
  })
})
