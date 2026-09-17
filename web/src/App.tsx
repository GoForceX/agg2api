import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  Link,
  Outlet,
  RouterProvider,
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useRouterState
} from "@tanstack/react-router"
import {
  ActivityIcon,
  BoxesIcon,
  GaugeIcon,
  KeyRoundIcon,
  type LucideIcon,
  RouteIcon,
  ShieldCheckIcon
} from "lucide-react"

import { TokenGate, useTokenDialog } from "@/components/TokenDialog"
import { Separator } from "@/components/ui/separator"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar
} from "@/components/ui/sidebar"
import { COPY } from "@/lib/copy.ts"
import { DEFAULT_WINDOW } from "@/lib/queries.ts"
import { DashboardView } from "@/views/Dashboard.tsx"
import { KeysView } from "@/views/Keys.tsx"
import { ProvidersView } from "@/views/Providers.tsx"
import { RoutesView } from "@/views/Routes.tsx"
import { UsageView } from "@/views/Usage.tsx"

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

const NAV: ReadonlyArray<{ to: string; label: string; icon: LucideIcon }> = [
  { to: "/", label: COPY.nav.dashboard, icon: GaugeIcon },
  { to: "/providers", label: COPY.nav.providers, icon: BoxesIcon },
  { to: "/routes", label: COPY.nav.routes, icon: RouteIcon },
  { to: "/keys", label: COPY.nav.keys, icon: KeyRoundIcon },
  { to: "/usage", label: COPY.nav.usage, icon: ActivityIcon }
]

function NavMenu() {
  const { isMobile, setOpenMobile } = useSidebar()
  /** Hash routing has no location context in the root route, so the path is read
      from the router state — the sidebar has to mark the active item itself. */
  const path = useRouterState({ select: (state) => state.location.pathname })
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{COPY.nav.sections}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {NAV.map((item) => (
            <SidebarMenuItem key={item.to}>
              <SidebarMenuButton
                isActive={path === item.to}
                tooltip={item.label}
                render={<Link to={item.to} />}
                // On mobile the sidebar is a drawer over the page, so leaving it open
                // hides the view the operator just asked for.
                onClick={() => {
                  if (isMobile) setOpenMobile(false)
                }}
              >
                <item.icon />
                <span>{item.label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

function AppSidebar() {
  const { openDialog } = useTokenDialog()
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-2 px-1 py-1.5">
          <ShieldCheckIcon className="size-5 shrink-0 text-primary" />
          <div className="flex flex-col leading-tight group-data-[collapsible=icon]:hidden">
            <span className="font-semibold">{COPY.brand.name}</span>
            <span className="text-xs text-muted-foreground">{COPY.brand.admin}</span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <NavMenu />
      </SidebarContent>
      <SidebarFooter>
        {/* The footer keeps its full width when the rail collapses, so the label is
            hidden by size rather than by `group-data`, and the visible part is the icon. */}
        <Button
          variant="outline"
          size="sm"
          className="justify-start group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:p-0"
          onClick={openDialog}
        >
          <KeyRoundIcon data-icon="inline-start" />
          <span className="group-data-[collapsible=icon]:hidden">{COPY.nav.token}</span>
        </Button>
        <p className="text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">{COPY.footer.apiPath}</p>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

function Shell() {
  return (
    // Base UI's tooltip reads its configuration from a provider; without one the
    // trigger and its content render nothing at all.
    <TooltipProvider>
      <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-5" />
          <span className="text-sm text-muted-foreground">
            {COPY.footer.defaultWindow(DEFAULT_WINDOW.label)}
          </span>
        </header>
        <main className="flex min-w-0 flex-1 flex-col gap-4 p-4 md:p-6">
          <Outlet />
        </main>
      </SidebarInset>
        {/* Outside the sidebar provider so a toast still renders when a dialog is open. */}
        <Toaster position="bottom-right" />
      </SidebarProvider>
    </TooltipProvider>
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
