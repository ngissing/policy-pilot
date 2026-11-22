import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, FileText, Globe, Upload, X } from "lucide-react";
import { api } from "../api";
import { useMe } from "../App";
import { Spinner, usePoll, useToast } from "../components/bits";

export default function AddDocuments() {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Add your school's documents</h1>
          <p>
            PolicyPilot reads each document, writes a short briefing, picks out review dates, and links it to the PAL
            topics it relates to. Only people at your school can see them.
          </p>
        </div>
      </div>
      <div className="stack" style={{ gap: 28 }}>
        <Finder />
        <Uploader />
      </div>
    </div>
  );
}

// ─── Upload ──────────────────────────────────────────────────────────────────

interface Tracked { id: number; name: string; status: string; error?: string | null; title?: string }

function Uploader() {
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tracked, setTracked] = useState<Tracked[]>([]);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const send = async (files: FileList | File[]) => {
    const list = [...files];
    if (!list.length) return;
    setBusy(true);
    setError(null);
    const form = new FormData();
    list.forEach((f) => form.append("files", f));
    try {
      const { ids } = await api<{ ids: number[] }>("/documents/upload", { form });
      setTracked((t) => [...ids.map((id, i) => ({ id, name: list[i]?.name ?? "Document", status: "queued" })), ...t]);
      if (ids.length < list.length) setError(`${list.length - ids.length} file(s) were skipped. Use PDF, Word (.docx), text or web pages.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  const refresh = useCallback(async () => {
    const d = await api("/documents?source=school");
    setTracked((t) => t.map((x) => {
      const doc = d.documents.find((y: any) => y.id === x.id);
      return doc ? { ...x, status: doc.status, error: doc.error, title: doc.title } : x;
    }));
  }, []);
  usePoll(refresh, 2500, tracked.some((t) => t.status === "queued" || t.status === "processing"));

  return (
    <section>
      <h2 style={{ marginBottom: 4 }}>Upload files</h2>
      <p className="muted" style={{ marginBottom: 12 }}>PDF, Word (.docx), text or HTML, up to 30 MB each. You can drop a whole folder's worth at once.</p>
      <div
        className={`drop${over ? " over" : ""}`}
        role="button"
        tabIndex={0}
        onClick={() => input.current?.click()}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && input.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); send(e.dataTransfer.files); }}
      >
        {busy ? <Spinner size={22} /> : <Upload size={22} />}
        <strong>{busy ? "Uploading…" : "Drop files here, or choose files"}</strong>
        <span className="muted small">Scanned PDFs need text recognition (OCR) first.</span>
        <input ref={input} type="file" multiple hidden accept=".pdf,.docx,.txt,.md,.html,.htm" onChange={(e) => e.target.files && send(e.target.files)} />
      </div>
      {error && <div className="notice error" role="alert" style={{ marginTop: 12 }}>{error}</div>}
      {tracked.length > 0 && (
        <div className="file-list" aria-live="polite">
          {tracked.map((t) => (
            <div className="file-item" key={t.id}>
              <FileText size={16} color="var(--ink-3)" />
              <span className="name">{t.status === "ready" && t.title ? t.title : t.name}</span>
              {t.status === "ready" && <Link to={`/documents/${t.id}`} className="badge ok"><CheckCircle2 size={12} /> Ready</Link>}
              {(t.status === "queued" || t.status === "processing") && <span className="badge"><Spinner size={12} /> {t.status === "queued" ? "Waiting" : "Reading"}</span>}
              {t.status === "error" && <span className="badge danger" title={t.error ?? ""}>Couldn't read</span>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ─── Find on the school website ─────────────────────────────────────────────

function Finder() {
  const { me } = useMe();
  const toast = useToast();
  const [state, setState] = useState<any>(null);
  const [url, setUrl] = useState("");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    const d = await api("/finder");
    setState(d);
    setUrl((u) => u || d.website || me.school?.website || "");
    return d;
  }, [me.school?.website]);
  useEffect(() => {
    load().then((d) => setPicked(new Set(d.found.filter((f: any) => f.status === "new" && f.score >= 4).map((f: any) => f.id))));
  }, [load]);
  const running = state?.job?.status === "running";
  const anyImporting = state?.found?.some((f: any) => f.status === "imported" && ["queued", "processing"].includes(f.doc_status));
  usePoll(() => { load().then((d) => {
    if (d.job?.status !== "running" && running) setPicked(new Set(d.found.filter((f: any) => f.status === "new" && f.score >= 4).map((f: any) => f.id)));
  }); }, 2000, running || !!anyImporting);

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api("/finder/start", { body: { url } });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const importPicked = async () => {
    setImporting(true);
    const { results } = await api("/finder/import", { body: { ids: [...picked] } });
    const failed = results.filter((r: any) => r.error);
    toast(failed.length ? `${results.length - failed.length} added. ${failed.length} couldn't be downloaded.` : `${results.length} document${results.length === 1 ? "" : "s"} added. Reading them now.`);
    setPicked(new Set());
    setImporting(false);
    load();
  };

  const dismiss = async (id: number) => {
    await api(`/finder/${id}/dismiss`, { method: "POST" });
    setPicked((p) => { const n = new Set(p); n.delete(id); return n; });
    load();
  };

  const fresh = state?.found?.filter((f: any) => f.status === "new") ?? [];
  const imported = state?.found?.filter((f: any) => f.status === "imported") ?? [];
  const job = state?.job;

  return (
    <section>
      <h2 style={{ marginBottom: 4 }}>Find documents on your school website</h2>
      <p className="muted" style={{ marginBottom: 12 }}>
        PolicyPilot looks through your public website for policies and procedures, then you choose which to add.
      </p>
      <form className="row" onSubmit={start} style={{ alignItems: "stretch" }}>
        <div className="search" style={{ maxWidth: 520 }}>
          <Globe size={16} aria-hidden />
          <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="www.yourschool.vic.edu.au" aria-label="School website address" required />
        </div>
        <button className="btn primary" type="submit" disabled={running}>{running ? <><Spinner /> Searching</> : fresh.length || imported.length ? "Search again" : "Search website"}</button>
      </form>
      {error && <div className="notice error" role="alert" style={{ marginTop: 12 }}>{error}</div>}

      {job && (running || job.status === "failed") && (
        <div style={{ marginTop: 14, maxWidth: 520 }} className="stack">
          {running && <div className="progress" aria-hidden><div style={{ width: `${Math.min(100, (job.done / Math.max(1, job.total)) * 100)}%` }} /></div>}
          <p className="small muted" aria-live="polite">{job.message}</p>
        </div>
      )}
      {job && job.status === "done" && <p className="small muted" style={{ marginTop: 10 }}>{job.message}</p>}

      {fresh.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div className="row" style={{ marginBottom: 8 }}>
            <strong>{fresh.length} possible document{fresh.length === 1 ? "" : "s"}</strong>
            <button className="btn ghost sm" onClick={() => setPicked(new Set(fresh.map((f: any) => f.id)))}>Select all</button>
            <button className="btn ghost sm" onClick={() => setPicked(new Set())}>Select none</button>
            <span className="spacer" />
            <button className="btn primary" disabled={!picked.size || importing} onClick={importPicked}>
              {importing && <Spinner />} Add {picked.size || ""} selected
            </button>
          </div>
          <div className="card">
            {fresh.map((f: any) => (
              <label key={f.id} className="found-item">
                <input
                  type="checkbox"
                  checked={picked.has(f.id)}
                  onChange={(e) => setPicked((p) => { const n = new Set(p); e.target.checked ? n.add(f.id) : n.delete(f.id); return n; })}
                />
                <span style={{ minWidth: 0 }}>
                  <span className="t">{f.title}</span>{" "}
                  <span className="badge">{f.kind === "page" ? "Web page" : f.kind === "docx" ? "Word" : "PDF"}</span>
                  <span className="u" style={{ display: "block" }}><a href={f.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{decodeURIComponent(f.url)}</a></span>
                </span>
                <button type="button" className="btn ghost icon sm" onClick={(e) => { e.preventDefault(); dismiss(f.id); }} aria-label={`Hide ${f.title}`} title="Not a policy — hide it"><X size={15} /></button>
              </label>
            ))}
          </div>
        </div>
      )}

      {imported.length > 0 && (
        <details style={{ marginTop: 14 }}>
          <summary className="small" style={{ cursor: "pointer" }}>{imported.length} already added from your website</summary>
          <div className="file-list">
            {imported.map((f: any) => (
              <div key={f.id} className="file-item">
                <FileText size={16} color="var(--ink-3)" />
                <span className="name">{f.title}</span>
                {f.doc_status === "ready" && <Link className="badge ok" to={`/documents/${f.document_id}`}><CheckCircle2 size={12} /> Ready</Link>}
                {["queued", "processing"].includes(f.doc_status) && <span className="badge"><Spinner size={12} /> Reading</span>}
                {f.doc_status === "error" && <Link className="badge danger" to={`/documents/${f.document_id}`}>Couldn't read</Link>}
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
