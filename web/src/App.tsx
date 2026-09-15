import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  Link,
  Outlet,
  RouterProvider,
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter
} from "@tanstack/react-router"
import { TokenGate } from "./components/TokenPrompt.tsx"
import { openTokenPrompt } from "./lib/api.ts"
import { WINDOWS } from "./lib/queries.ts"
import { DashboardView } from "./views/Dashboard.tsx"
import { KeysView } from "./views/Keys.tsx"
import { ProvidersView } from "./views/Providers.tsx"
import { RoutesView } from "./views/Routes.tsx"
import { UsageView } from "./views/Usage.tsx"

/** Client errors are not retried; the token gate owns the 401 path. */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: true,
      staleTime: 5_000
    }
  }
})

const NAV = [
  { to: "/", label: "Dashboard" },
  { to: "/providers", label: "Providers" },
  { to: "/routes", label: "Routes" },
  { to: "/keys", label: "API keys" },
  { to: "/usage", label: "Usage" }
] as const

function Shell() {
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">agg2api</span>
          <span className="muted small">admin</span>
        </div>
        <nav className="nav" aria-label="Sections">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="nav-link"
              activeOptions={{ exact: item.to === "/" }}
              activeProps={{ className: "nav-link nav-link-active" }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <button type="button" className="btn btn-small" onClick={openTokenPrompt}>
          Token
        </button>
      </header>
      <main className="content">
        <Outlet />
      </main>
      <footer className="footer muted small">
        <span>Default window: {WINDOWS[1].label}</span>
        <span>·</span>
        <span>Admin API under /admin/api</span>
      </footer>
    </div>
  )
}

const rootRoute = createRootRoute({ component: Shell })

const dashboardRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: DashboardView })
const providersRoute = createRoute({ getParentRoute: () => rootRoute, path: "/providers", component: ProvidersView })
const routesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/routes", component: RoutesView })
const keysRoute = createRoute({ getParentRoute: () => rootRoute, path: "/keys", component: KeysView })
const usageRoute = createRoute({ getParentRoute: () => rootRoute, path: "/usage", component: UsageView })

const routeTree = rootRoute.addChildren([dashboardRoute, providersRoute, routesRoute, keysRoute, usageRoute])

/**
 * Hash routing keeps the bundle relocatable: `index.html` may be served from any
 * path prefix without a server-side rewrite rule.
 */
const router = createRouter({ routeTree, history: createHashHistory() })

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TokenGate>
        <RouterProvider router={router} />
      </TokenGate>
    </QueryClientProvider>
  )
}
