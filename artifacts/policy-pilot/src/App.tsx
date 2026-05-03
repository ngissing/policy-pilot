import { Switch, Route, Router as WouterRouter, Link, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  ClerkProvider,
  SignIn,
  UserButton,
  useAuth,
  useUser,
} from "@clerk/react";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/Dashboard";
import DocumentLibrary from "@/pages/DocumentLibrary";
import UploadPage from "@/pages/UploadPage";
import ChatPage from "@/pages/ChatPage";
import AdminQueue from "@/pages/AdminQueue";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  BookOpen,
  Upload,
  MessageSquare,
  ClipboardCheck,
  Shield,
  Loader2,
} from "lucide-react";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
  },
});

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

const NAV_ITEMS = [
  { path: "/", label: "Dashboard", icon: LayoutDashboard },
  { path: "/library", label: "Policy Library", icon: BookOpen },
  { path: "/upload", label: "Upload", icon: Upload },
  { path: "/chat", label: "AI Chat", icon: MessageSquare },
  { path: "/review", label: "Review Queue", icon: ClipboardCheck },
];

function Sidebar() {
  const [location] = useLocation();
  const { user } = useUser();

  const displayName =
    user?.fullName ??
    user?.primaryEmailAddress?.emailAddress?.split("@")[0] ??
    "Account";

  return (
    <aside className="w-56 shrink-0 bg-slate-900 min-h-screen flex flex-col">
      <div className="px-5 py-5 border-b border-slate-800">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-blue-500 flex items-center justify-center">
            <Shield className="w-4 h-4 text-white" />
          </div>
          <div>
            <p className="text-white font-bold text-sm leading-tight">PolicyPilot</p>
            <p className="text-slate-400 text-xs">K-12 Policy Intelligence</p>
          </div>
        </div>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-0.5">
        {NAV_ITEMS.map(({ path, label, icon: Icon }) => {
          const active = path === "/" ? location === "/" : location.startsWith(path);
          return (
            <Link
              key={path}
              href={path}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                active
                  ? "bg-blue-600 text-white"
                  : "text-slate-400 hover:bg-slate-800 hover:text-white"
              )}
            >
              <Icon className="w-4 h-4 shrink-0" />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="px-4 py-4 border-t border-slate-800">
        <div className="flex items-center gap-3 min-w-0">
          <UserButton
            appearance={{
              elements: {
                userButtonAvatarBox: "w-8 h-8",
              },
            }}
          />
          <span className="text-slate-300 text-xs truncate" title={displayName}>
            {displayName}
          </span>
        </div>
      </div>
    </aside>
  );
}

function AppShell() {
  return (
    <div className="flex min-h-screen bg-slate-50">
      <Sidebar />
      <main className="flex-1 p-6 max-w-5xl">
        <Switch>
          <Route path="/" component={Dashboard} />
          <Route path="/library" component={DocumentLibrary} />
          <Route path="/upload" component={UploadPage} />
          <Route path="/chat" component={ChatPage} />
          <Route path="/review" component={AdminQueue} />
          <Route component={NotFound} />
        </Switch>
      </main>
    </div>
  );
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
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-950 to-slate-900 flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <div className="w-16 h-16 rounded-2xl bg-blue-500 flex items-center justify-center mx-auto mb-4">
              <Shield className="w-8 h-8 text-white" />
            </div>
            <h1 className="text-3xl font-bold text-white">PolicyPilot</h1>
            <p className="text-blue-200 mt-2">AI-powered school policy intelligence</p>
          </div>
          <SignIn routing="hash" />
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

function App() {
  return (
    <ClerkProvider publishableKey={PUBLISHABLE_KEY}>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
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
