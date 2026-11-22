import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { BookOpen, ClipboardCheck, FilePlus2, LogOut, Menu, MessageSquareText, Plus, Radio, Settings as SettingsIcon } from "lucide-react";
import { api } from "./api";
import { Spinner, ToastProvider } from "./components/bits";
import Login from "./pages/Login";
import Ask from "./pages/Ask";
import Library from "./pages/Library";
import DocumentView from "./pages/DocumentView";
import AddDocuments from "./pages/AddDocuments";
import Checklist from "./pages/Checklist";
import Updates from "./pages/Updates";
import Settings from "./pages/Settings";

export interface Me {
  user: { id: number; name: string; email: string; role: "admin" | "staff"; is_owner: number; school_id: number } | null;
  school?: { id: number; name: string; school_type: string | null; suburb: string | null; website: string | null };
  counts?: { school_docs: number; pal_docs: number; alerts: number };
  aiReady?: boolean;
  answerLength?: "short" | "normal" | "extended";
  hasAccounts: boolean;
}

const MeCtx = createContext<{ me: Me; refresh: () => Promise<void> }>(null!);
export const useMe = () => useContext(MeCtx);

// Lets the conversation list in the sidebar refresh when a new conversation starts.
const ConvoCtx = createContext<{ version: number; bump: () => void }>({ version: 0, bump: () => {} });
export const useConvoList = () => useContext(ConvoCtx);

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const refresh = useCallback(async () => setMe(await api<Me>("/me")), []);
  useEffect(() => {
    refresh().catch(() => setMe({ user: null, hasAccounts: true }));
  }, [refresh]);

  if (!me) {
    return (
      <div className="empty" style={{ paddingTop: "30vh" }}>
        <Spinner size={22} />
      </div>
    );
  }
  return (
    <MeCtx.Provider value={{ me, refresh }}>
      <ToastProvider>
        <BrowserRouter>
          {me.user ? <Shell /> : (
            <Routes>
              <Route path="*" element={<Login />} />
            </Routes>
          )}
        </BrowserRouter>
      </ToastProvider>
    </MeCtx.Provider>
  );
}

function Shell() {
  const { me, refresh } = useMe();
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState(0);
  const [convos, setConvos] = useState<Array<{ id: number; title: string }>>([]);
  const location = useLocation();
  const navigate = useNavigate();
  const isAdmin = me.user!.role === "admin";

  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    api<{ conversations: Array<{ id: number; title: string }> }>("/conversations").then((d) => setConvos(d.conversations)).catch(() => {});
  }, [version]);
  // Keep counts (alerts, document totals) fresh as people move around.
  useEffect(() => {
    refresh().catch(() => {});
  }, [location.pathname, refresh]);

  const logout = async () => {
    await api("/auth/logout", { method: "POST" });
    await refresh();
    navigate("/");
  };

  return (
    <ConvoCtx.Provider value={{ version, bump: () => setVersion((v) => v + 1) }}>
      <div className="shell">
        <header className="topbar">
          <button className="btn icon ghost" onClick={() => setOpen(true)} aria-label="Open menu"><Menu size={20} /></button>
          <img src="/favicon.svg" width={22} height={22} alt="" />
          <strong>PolicyPilot</strong>
        </header>
        {open && <div className="scrim" onClick={() => setOpen(false)} />}
        <aside className={`sidebar${open ? " open" : ""}`} aria-label="Main navigation">
          <NavLink to="/" className="brand">
            <img src="/favicon.svg" width={30} height={30} alt="" />
            <div>
              <div className="brand-name">PolicyPilot</div>
              <div className="brand-school">{me.school?.name}</div>
            </div>
          </NavLink>
          <nav className="nav">
            <NavLink to="/" end><MessageSquareText size={18} /> Ask</NavLink>
            <NavLink to="/library"><BookOpen size={18} /> Library</NavLink>
            {isAdmin && <NavLink to="/add"><FilePlus2 size={18} /> Add documents</NavLink>}
            <NavLink to="/checklist"><ClipboardCheck size={18} /> Policy checklist</NavLink>
            <NavLink to="/updates">
              <Radio size={18} /> PAL updates
              {!!me.counts?.alerts && <span className="badge count" aria-label={`${me.counts.alerts} affect your documents`}>{me.counts.alerts}</span>}
            </NavLink>
            <NavLink to="/settings"><SettingsIcon size={18} /> Settings</NavLink>
          </nav>
          <div className="side-section row">
            <span>Your conversations</span>
            <span className="spacer" />
            <button className="btn ghost sm icon" style={{ width: 28, height: 26 }} onClick={() => navigate("/")} aria-label="New question"><Plus size={16} /></button>
          </div>
          <div className="recent">
            {convos.length === 0 && <p className="muted small" style={{ padding: "4px 10px" }}>Questions you ask will appear here.</p>}
            {convos.map((c) => (
              <NavLink key={c.id} to={`/ask/${c.id}`} title={c.title}>{c.title}</NavLink>
            ))}
          </div>
          <div className="me">
            <div style={{ minWidth: 0 }}>
              <div className="me-name">{me.user!.name}</div>
              <div className="me-role">{isAdmin ? "School admin" : "Staff"}</div>
            </div>
            <button className="btn ghost icon" onClick={logout} aria-label="Sign out" title="Sign out"><LogOut size={18} /></button>
          </div>
        </aside>
        <main className="main">
          <Routes>
            <Route path="/" element={<Ask />} />
            <Route path="/ask/:id" element={<Ask />} />
            <Route path="/library" element={<Library />} />
            <Route path="/documents/:id" element={<DocumentView />} />
            <Route path="/add" element={isAdmin ? <AddDocuments /> : <Navigate to="/" />} />
            <Route path="/checklist" element={<Checklist />} />
            <Route path="/updates" element={<Updates />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </main>
      </div>
    </ConvoCtx.Provider>
  );
}
