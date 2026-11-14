import { useState, useEffect, Component, useRef } from "react";
import type { ReactNode, ErrorInfo } from "react";
import { Switch, Route, Router as WouterRouter, Link, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider, Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ClerkProvider,
  UserButton,
  useAuth,
  useUser,
  useClerk,
  SignIn,
  SignUp,
} from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { setBaseUrl } from "@workspace/api-client-react";
import { apiFetch } from "@/lib/api";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/Dashboard";
import DocumentLibrary from "@/pages/DocumentLibrary";
import UploadPage from "@/pages/UploadPage";
import ChatPage from "@/pages/ChatPage";
import AdminQueue from "@/pages/AdminQueue";
import SettingsPage from "@/pages/SettingsPage";
import ScrapePage from "@/pages/ScrapePage";
import LandingPage from "@/pages/LandingPage";
import WikiPage from "@/pages/WikiPage";
import DraftPage from "@/pages/DraftPage";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  BookOpen,
  Upload,
  MessageSquare,
  ClipboardCheck,
  Shield,
  Settings,
  Globe,
  Loader2,
  ChevronLeft,
  ChevronRight,
  PenLine,
} from "lucide-react";

// ─── Error Boundary ────────────────────────────────────────────────────────────

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, message: "" };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, message: error.message };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Uncaught error:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
          <div className="text-center space-y-4 max-w-md">
            <div className="flex justify-center">
              <div className="w-14 h-14 rounded-2xl bg-red-100 flex items-center justify-center">
                <Shield className="w-7 h-7 text-red-500" />
              </div>
            </div>
            <div>
              <h1 className="text-xl font-bold text-slate-900">Something went wrong</h1>
              <p className="text-sm text-slate-500 mt-1">
                An unexpected error occurred. Please refresh the page to try again.
              </p>
              {this.state.message && (
                <p className="text-xs text-slate-400 mt-2 font-mono bg-slate-100 rounded p-2 text-left break-all">
                  {this.state.message}
                </p>
              )}
            </div>
            <button
              onClick={() => window.location.reload()}
              className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
            >
              Reload page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ─── Query client ──────────────────────────────────────────────────────────────

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
  },
});

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

setBaseUrl(import.meta.env.BASE_URL.replace(/\/$/, ""));

const NAV_ITEMS = [
  { path: "/", label: "Dashboard", icon: LayoutDashboard },
  { path: "/library", label: "Policy Library", icon: BookOpen },
  { path: "/upload", label: "Upload", icon: Upload },
  { path: "/chat", label: "Chat", icon: MessageSquare },
  { path: "/draft", label: "Policy Drafter", icon: PenLine },
  { path: "/review", label: "Review Queue", icon: ClipboardCheck },
  { path: "/scrape", label: "Web Scraper", icon: Globe, badgeKey: "pal" as const },
  { path: "/settings", label: "Settings", icon: Settings },
];

// ─── Sidebar ───────────────────────────────────────────────────────────────────

function NavBadge({ count, collapsed }: { count: number; collapsed: boolean }) {
  if (count === 0) return null;
  if (collapsed) {
    return (
      <span className="absolute top-1 right-1 w-2 h-2 bg-amber-400 rounded-full" />
    );
  }
  return (
    <span className="ml-auto shrink-0 bg-amber-400 text-amber-900 text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none">
      {count}
    </span>
  );
}

function Sidebar({
  collapsed,
  onToggle,
  palAlertCount,
}: {
  collapsed: boolean;
  onToggle: () => void;
  palAlertCount: number;
}) {
  const [location] = useLocation();
  const { user } = useUser();

  const displayName =
    user?.fullName ??
    user?.primaryEmailAddress?.emailAddress?.split("@")[0] ??
    "Account";

  return (
    <aside
      className={cn(
        "shrink-0 bg-slate-900 min-h-screen flex flex-col transition-[width] duration-200 ease-in-out overflow-hidden",
        collapsed ? "w-[3.5rem]" : "w-56"
      )}
    >
      {/* Logo */}
      <div
        className={cn(
          "border-b border-slate-800 transition-all duration-200",
          collapsed ? "px-3 py-5" : "px-5 py-5"
        )}
      >
        <div
          className={cn(
            "flex items-center",
            collapsed ? "justify-center" : "gap-2.5"
          )}
        >
          <div className="w-8 h-8 rounded-lg bg-blue-500 flex items-center justify-center shrink-0">
            <Shield className="w-4 h-4 text-white" />
          </div>
          <div
            className={cn(
              "overflow-hidden transition-all duration-200",
              collapsed ? "w-0 opacity-0" : "w-auto opacity-100"
            )}
          >
            <p className="text-white font-bold text-sm leading-tight whitespace-nowrap">
              PolicyPilot
            </p>
            <p className="text-slate-400 text-xs whitespace-nowrap">
              K-12 Policy Intelligence
            </p>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav
        className={cn(
          "flex-1 py-4 space-y-0.5 transition-all duration-200",
          collapsed ? "px-2" : "px-3"
        )}
      >
        {NAV_ITEMS.map(({ path, label, icon: Icon, badgeKey }) => {
          const active =
            path === "/" ? location === "/" : location.startsWith(path);
          const badge = badgeKey === "pal" ? palAlertCount : 0;

          const link = (
            <Link
              href={path}
              className={cn(
                "relative flex items-center rounded-lg text-sm font-medium transition-colors",
                collapsed
                  ? "justify-center px-2 py-2"
                  : "gap-3 px-3 py-2",
                active
                  ? "bg-blue-600 text-white"
                  : "text-slate-400 hover:bg-slate-800 hover:text-white"
              )}
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span
                className={cn(
                  "overflow-hidden whitespace-nowrap transition-all duration-200 flex-1",
                  collapsed ? "w-0 opacity-0" : "w-auto opacity-100"
                )}
              >
                {label}
              </span>
              {!collapsed && badge > 0 && <NavBadge count={badge} collapsed={false} />}
              {collapsed && badge > 0 && <NavBadge count={badge} collapsed={true} />}
            </Link>
          );

          if (collapsed) {
            return (
              <Tooltip key={path} delayDuration={100}>
                <TooltipTrigger asChild>{link}</TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                  {label}
                  {badge > 0 && ` (${badge} update${badge !== 1 ? "s" : ""})`}
                </TooltipContent>
              </Tooltip>
            );
          }

          return <div key={path}>{link}</div>;
        })}
      </nav>

      {/* Collapse toggle */}
      <div
        className={cn(
          "border-t border-slate-800 transition-all duration-200",
          collapsed ? "px-2 py-2" : "px-3 py-2"
        )}
      >
        <Tooltip delayDuration={100}>
          <TooltipTrigger asChild>
            <button
              onClick={onToggle}
              className={cn(
                "w-full flex items-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white transition-colors text-sm py-2",
                collapsed ? "justify-center px-2" : "gap-3 px-3"
              )}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {collapsed ? (
                <ChevronRight className="w-4 h-4 shrink-0" />
              ) : (
                <>
                  <ChevronLeft className="w-4 h-4 shrink-0" />
                  <span className="overflow-hidden whitespace-nowrap">
                    Collapse
                  </span>
                </>
              )}
            </button>
          </TooltipTrigger>
          {collapsed && (
            <TooltipContent side="right" sideOffset={8}>
              Expand sidebar
            </TooltipContent>
          )}
        </Tooltip>
      </div>

      {/* User */}
      <div
        className={cn(
          "pb-4 border-t border-slate-800 transition-all duration-200",
          collapsed ? "px-3 pt-3" : "px-4 pt-4"
        )}
      >
        <div
          className={cn(
            "flex items-center min-w-0",
            collapsed ? "justify-center" : "gap-3"
          )}
        >
          <UserButton
            appearance={{
              elements: { userButtonAvatarBox: "w-8 h-8" },
            }}
          />
          <span
            className={cn(
              "text-slate-300 text-xs truncate transition-all duration-200",
              collapsed ? "w-0 opacity-0" : "w-auto opacity-100"
            )}
            title={displayName}
          >
            {displayName}
          </span>
        </div>
      </div>
    </aside>
  );
}

// ─── App shell ─────────────────────────────────────────────────────────────────

function AppShell() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("sidebar-collapsed") === "true";
    } catch {
      return false;
    }
  });

  const [palAlertCount, setPalAlertCount] = useState(0);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("sidebar-collapsed", String(next));
      } catch {}
      return next;
    });
  };

  // Poll PAL change alerts every 5 minutes
  useEffect(() => {
    let cancelled = false;
    async function fetchAlerts() {
      try {
        const alerts = await apiFetch<{ id: number }[]>("/scrape/pal/alerts");
        if (!cancelled) setPalAlertCount(alerts.length);
      } catch {
        // silently ignore — alerts are non-critical
      }
    }
    fetchAlerts();
    const interval = setInterval(fetchAlerts, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Sidebar
        collapsed={collapsed}
        onToggle={toggleCollapsed}
        palAlertCount={palAlertCount}
      />
      <main className="flex-1 p-6 min-w-0">
        <Switch>
          <Route path="/" component={Dashboard} />
          <Route path="/library" component={DocumentLibrary} />
          <Route path="/upload" component={UploadPage} />
          <Route path="/chat" component={ChatPage} />
          <Route path="/draft" component={DraftPage} />
          <Route path="/review" component={AdminQueue} />
          <Route path="/scrape" component={ScrapePage} />
          <Route path="/settings" component={SettingsPage} />
          <Route path="/wiki/:id" component={WikiPage} />
          <Route component={NotFound} />
        </Switch>
      </main>
    </div>
  );
}

// ─── Auth / Clerk wiring ───────────────────────────────────────────────────────

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    return addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) {
        queryClient.clear();
      }
      prevUserIdRef.current = userId;
    });
  }, [addListener]);
  return null;
}

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  const [, navigate] = useLocation();

  if (!isLoaded) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-400" />
      </div>
    );
  }

  if (!isSignedIn) {
    return <LandingPage onSignIn={() => navigate("/sign-in")} />;
  }

  return <>{children}</>;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();
  return (
      <ClerkProvider
        publishableKey={clerkPubKey}
        proxyUrl={clerkProxyUrl}
        signInUrl={`${basePath}/sign-in`}
        signUpUrl={`${basePath}/sign-up`}
        afterSignOutUrl={basePath || "/"}
        routerPush={(to) => setLocation(stripBase(to))}
        routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
        appearance={{
          variables: { colorPrimary: "#2563eb", fontFamily: "Inter, sans-serif" },
          options: {
            logoImageUrl: `${window.location.origin}${basePath}/favicon.svg`,
            logoLinkUrl: basePath || "/",
          },
        }}
        localization={{
          signIn: { start: { title: "Welcome to PolicyPilot", subtitle: "Sign in to your policy library" } },
          signUp: { start: { title: "Join PolicyPilot", subtitle: "Create your school policy account" } },
        }}
      >
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
              <ClerkQueryClientCacheInvalidator />
              <Switch>
                <Route path="/sign-in/*?">
                  <div className="min-h-screen bg-slate-950 flex items-center justify-center p-6">
                    <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} forceRedirectUrl={`${basePath}/`} />
                  </div>
                </Route>
                <Route path="/sign-up/*?">
                  <div className="min-h-screen bg-slate-950 flex items-center justify-center p-6">
                    <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} forceRedirectUrl={`${basePath}/`} />
                  </div>
                </Route>
                <Route>
                  <AuthGuard><AppShell /></AuthGuard>
                </Route>
              </Switch>
            <Toaster />
          </TooltipProvider>
        </QueryClientProvider>
      </ClerkProvider>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <WouterRouter base={basePath}>
        <ClerkProviderWithRoutes />
      </WouterRouter>
    </ErrorBoundary>
  );
}

export default App;
