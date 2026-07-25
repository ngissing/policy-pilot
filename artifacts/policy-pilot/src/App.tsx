import { useState, useEffect, useLayoutEffect } from "react";
import { Switch, Route, Router as WouterRouter, Link, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider, Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ClerkProvider,
  UserButton,
  useAuth,
  useUser,
} from "@clerk/react";
import { setAuthTokenGetter, setBaseUrl } from "@workspace/api-client-react";
import { setApiTokenGetter } from "@/lib/api";
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
} from "lucide-react";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
  },
});

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

setBaseUrl(import.meta.env.BASE_URL.replace(/\/$/, ""));

const NAV_ITEMS = [
  { path: "/", label: "Dashboard", icon: LayoutDashboard },
  { path: "/library", label: "Policy Library", icon: BookOpen },
  { path: "/upload", label: "Upload", icon: Upload },
  { path: "/chat", label: "Chat", icon: MessageSquare },
  { path: "/review", label: "Review Queue", icon: ClipboardCheck },
  { path: "/scrape", label: "Web Scraper", icon: Globe },
  { path: "/settings", label: "Settings", icon: Settings },
];

function Sidebar({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
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
        {NAV_ITEMS.map(({ path, label, icon: Icon }) => {
          const active =
            path === "/" ? location === "/" : location.startsWith(path);
          const link = (
            <Link
              href={path}
              className={cn(
                "flex items-center rounded-lg text-sm font-medium transition-colors",
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
                  "overflow-hidden whitespace-nowrap transition-all duration-200",
                  collapsed ? "w-0 opacity-0" : "w-auto opacity-100"
                )}
              >
                {label}
              </span>
            </Link>
          );

          if (collapsed) {
            return (
              <Tooltip key={path} delayDuration={100}>
                <TooltipTrigger asChild>{link}</TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                  {label}
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

function AppShell() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("sidebar-collapsed") === "true";
    } catch {
      return false;
    }
  });

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("sidebar-collapsed", String(next));
      } catch {}
      return next;
    });
  };

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Sidebar collapsed={collapsed} onToggle={toggleCollapsed} />
      <main className="flex-1 p-6 min-w-0">
        <Switch>
          <Route path="/" component={Dashboard} />
          <Route path="/library" component={DocumentLibrary} />
          <Route path="/upload" component={UploadPage} />
          <Route path="/chat" component={ChatPage} />
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

function ClerkTokenSync() {
  const { getToken, isSignedIn } = useAuth();
  useLayoutEffect(() => {
    if (!isSignedIn) {
      setAuthTokenGetter(null);
      setApiTokenGetter(null);
      return;
    }
    const getter = () => getToken({ skipCache: true });
    setAuthTokenGetter(getter);
    setApiTokenGetter(getter);
  }, [isSignedIn, getToken]);
  return null;
}

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-400" />
      </div>
    );
  }

  if (!isSignedIn) {
    return <LandingPage onSignIn={() => {}} />;
  }

  return <>{children}</>;
}

function App() {
  return (
    <ClerkProvider publishableKey={PUBLISHABLE_KEY}>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <ClerkTokenSync />
            <AuthGuard>
              <AppShell />
            </AuthGuard>
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

export default App;
