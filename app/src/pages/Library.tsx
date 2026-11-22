import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AlertTriangle, Building2, FilePlus2, Landmark, Search } from "lucide-react";
import { api, fmtDate } from "../api";
import { useMe } from "../App";
import { Spinner, usePoll } from "../components/bits";

interface Doc {
  id: number; title: string; source: string; category: string | null; doc_type: string | null; summary: string | null;
  status: string; error: string | null; reviewed_date: string | null; next_review: string | null; filename: string | null; word_count: number | null;
}

export default function Library() {
  const { me } = useMe();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "pal" ? "pal" : "school";
  const [q, setQ] = useState(params.get("q") ?? "");
  const [category, setCategory] = useState("");
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [categories, setCategories] = useState<string[]>([]);

  const load = useCallback(() => {
    const qs = new URLSearchParams({ source: tab, q, category });
    api(`/documents?${qs}`).then((d) => {
      setDocs(d.documents);
      setCategories(d.categories);
    });
  }, [tab, q, category]);

  useEffect(() => {
    const t = setTimeout(load, q ? 200 : 0);
    return () => clearTimeout(t);
  }, [load, q]);
  usePoll(load, 3000, !!docs?.some((d) => d.status === "queued" || d.status === "processing"));

  const setTab = (t: string) => {
    setDocs(null);
    setCategory("");
    setParams(t === "pal" ? { tab: "pal" } : {});
  };
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Library</h1>
          <p>Every document PolicyPilot reads when it answers. Your school's documents are private to your school.</p>
        </div>
        {me.user!.role === "admin" && <Link to="/add" className="btn primary"><FilePlus2 size={16} /> Add documents</Link>}
      </div>

      <div className="toolbar">
        <div className="segmented" role="tablist">
          <button role="tab" aria-pressed={tab === "school"} aria-selected={tab === "school"} onClick={() => setTab("school")}>
            <Building2 size={14} /> Our school <span className="muted">{me.counts?.school_docs ?? 0}</span>
          </button>
          <button role="tab" aria-pressed={tab === "pal"} aria-selected={tab === "pal"} onClick={() => setTab("pal")}>
            <Landmark size={14} /> PAL <span className="muted">{me.counts?.pal_docs ?? 0}</span>
          </button>
        </div>
        <div className="search">
          <Search size={16} aria-hidden />
          <input className="input" type="search" placeholder={tab === "pal" ? "Search PAL topics" : "Search your documents"} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        </div>
        <select className="select" style={{ width: "auto", maxWidth: 280 }} value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
          <option value="">All categories</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {!docs ? (
        <div className="empty"><Spinner /></div>
      ) : docs.length === 0 ? (
        <div className="card empty">
          {q || category ? (
            <><h2>Nothing matches</h2><p>Try fewer words, or clear the category filter.</p></>
          ) : tab === "school" ? (
            <>
              <h2>No school documents yet</h2>
              <p>Upload your policies, or let PolicyPilot find the ones already published on your school website.</p>
              {me.user!.role === "admin" && <Link to="/add" className="btn primary">Add documents</Link>}
            </>
          ) : (
            <><h2>PAL hasn't been loaded</h2><p>{me.user!.is_owner ? "Load it from Settings." : "Your platform owner can load it from Settings."}</p></>
          )}
        </div>
      ) : (
        <div className="doc-list">
          {docs.map((d) => {
            const overdue = d.next_review && d.next_review.slice(0, 10) < today;
            return (
              <Link key={d.id} to={`/documents/${d.id}`} className="doc-row">
                <span className={`edge${tab === "school" ? " school" : ""}`} aria-hidden />
                <div style={{ minWidth: 0 }}>
                  <div className="title">{d.title || d.filename || "Untitled"}</div>
                  {d.status === "ready" && d.summary && <div className="summary">{d.summary}</div>}
                  {d.status === "error" && <div className="summary" style={{ color: "var(--danger)" }}>{d.error}</div>}
                  <div className="meta">
                    {d.category && <span>{d.category}</span>}
                    {d.doc_type && <span>{d.doc_type}</span>}
                    {d.reviewed_date && <span>{tab === "pal" ? "Updated" : "Reviewed"} {fmtDate(d.reviewed_date)}</span>}
                  </div>
                </div>
                <div className="right">
                  {(d.status === "queued" || d.status === "processing") && <span className="badge"><Spinner size={12} /> Reading</span>}
                  {d.status === "error" && <span className="badge danger"><AlertTriangle size={12} /> {tab === "pal" ? "Retired" : "Couldn't read"}</span>}
                  {overdue && <span className="badge warn">Review overdue</span>}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
