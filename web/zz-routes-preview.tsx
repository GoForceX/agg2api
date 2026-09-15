import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { RoutesView } from "./src/views/Routes.tsx"
import "./src/styles.css"

localStorage.setItem("agg2api.token", "stub")

const CONFIG = {
  providers: [
    {
      provider: {
        id: 1,
        name: "openai-main",
        kind: "openai-chat",
        base_url: "https://api.openai.com",
        api_key: "sk-***",
        priority: 100,
        enabled: true,
        currency: "USD",
        input_price: null,
        output_price: null,
        max_retries: 2,
        model_allow: [],
        model_deny: [],
        headers: {},
        model_rename: {}
      },
      models: [
        { provider_id: 1, upstream_id: "gpt-4o", public_id: "gpt-4o", context_length: null, max_output_tokens: null, supports_images: true },
        { provider_id: 1, upstream_id: "gpt-4o-mini", public_id: "fast-mini", context_length: null, max_output_tokens: null, supports_images: false }
      ],
      status: { open_until: 0, consecutive_failures: 0, last_error: null, last_error_at: null, last_success_at: null, last_latency_ms: null },
      credits: null,
      routed_models: ["gpt-4o"]
    },
    {
      provider: {
        id: 2,
        name: "backup-pool",
        kind: "workbuddy2api",
        base_url: "https://backup.example",
        api_key: "sk-***",
        priority: 50,
        enabled: false,
        currency: "USD",
        input_price: null,
        output_price: null,
        max_retries: 1,
        model_allow: [],
        model_deny: [],
        headers: {},
        model_rename: {}
      },
      models: [],
      status: { open_until: 0, consecutive_failures: 0, last_error: null, last_error_at: null, last_success_at: null, last_latency_ms: null },
      credits: null,
      routed_models: []
    }
  ],
  routes: [
    {
      public_model: "gpt-4o",
      strategy: "priority",
      enabled: true,
      display_name: "主对话模型",
      targets: [
        { provider_id: 1, upstream_model: "gpt-4o", priority: 100, enabled: true },
        { provider_id: 2, upstream_model: "gpt-4o-old", priority: 20, enabled: false }
      ],
      created_at: 1700000000000,
      updated_at: 1700000000000
    },
    {
      public_model: "gpt-4o-mini",
      strategy: "weighted",
      enabled: true,
      display_name: null,
      targets: [{ provider_id: 1, upstream_model: "gpt-4o-mini", priority: 5, enabled: true }],
      created_at: 1700000000000,
      updated_at: 1700000000000
    },
    {
      public_model: "orphan-model",
      strategy: null,
      enabled: false,
      display_name: null,
      targets: [],
      created_at: 1700000000000,
      updated_at: 1700000000000
    }
  ],
  keys: [],
  settings: { default_strategy: "weighted", require_client_key: false, request_timeout_ms: 30000, discovery_interval_s: 300 }
}

const realFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input)
  if (url.includes("/admin/api/config")) return new Response(JSON.stringify(CONFIG), { status: 200 })
  if (url.includes("/admin/api/routes/sync")) {
    return new Response(JSON.stringify({ created: ["a"], updated: ["b", "c"], removed: [] }), { status: 200 })
  }
  if (url.includes("/admin/api/overview")) return new Response(JSON.stringify({}), { status: 200 })
  return realFetch(input, init)
}

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <RoutesView />
    </QueryClientProvider>
  </StrictMode>
)
