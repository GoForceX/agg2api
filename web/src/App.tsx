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
import { COPY } from "./lib/copy.ts"
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
  { to: "/", label: COPY.nav.dashboard },
  { to: "/providers", label: COPY.nav.providers },
  { to: "/routes", label: COPY.nav.routes },
  { to: "/keys", label: COPY.nav.keys },
  { to: "/usage", label: COPY.nav.usage }
] as const

function Shell() {
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">agg2api</span>
          <span className="muted small">{COPY.brand.admin}</span>
        </div>
        <nav className="nav" aria-label={COPY.nav.sections}>
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
          {COPY.nav.token}
        </button>
      </header>
      <main className="content">
        <Outlet />
      </main>
      <footer className="footer muted small">
        <span>{COPY.footer.defaultWindow(WINDOWS[1].label)}</span>
        <span>·</span>
        <span>{COPY.footer.apiPath}</span>
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
