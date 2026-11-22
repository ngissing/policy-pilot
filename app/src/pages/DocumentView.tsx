import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Download, ExternalLink, MessageSquareText, Pencil, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { api, fmtDate } from "../api";
import { useConvoList, useMe } from "../App";
import { Markdown, SourceTab, Spinner, usePoll, useToast } from "../components/bits";

export default function DocumentView() {
  const { id } = useParams();
  const { me } = useMe();
  const navigate = useNavigate();
  const toast = useToast();
  const { bump } = useConvoList();
  const [data, setData] = useState<any>(null);
  const [overview, setOverview] = useState<{ text?: string; loading?: boolean; error?: string }>({});
  const [editing, setEditing] = useState(false);

  const load = useCallback(() => {
    api(`/documents/${id}`).then((d) => {
      setData(d);
      if (d.document.overview) setOverview({ text: d.document.overview });
    }).catch(() => navigate("/library"));
  }, [id, navigate]);
  useEffect(load, [load]);
  usePoll(load, 2500, data && ["queued", "processing"].includes(data.document.status));

  const doc = data?.document;
  const isSchool = doc?.school_id !== null && doc?.school_id !== undefined;
  const isAdmin = me.user!.role === "admin";

  // PAL topics get their plain-English briefing the first time anyone opens them.
  useEffect(() => {
    if (!doc || doc.overview || isSchool || !me.aiReady || overview.loading || overview.text || overview.error) return;
    setOverview({ loading: true });
    api(`/documents/${doc.id}/overview`, { method: "POST" })
      .then((d) => setOverview({ text: d.overview }))
      .catch((e) => setOverview({ error: e.message }));
  }, [doc, isSchool, me.aiReady, overview]);

  if (!doc) return <div className="empty"><Spinner /></div>;

  const askAbout = async () => {
    const { id: cid } = await api<{ id: number }>("/conversations", { body: { documentId: doc.id, scope: "all" } });
    bump();
    navigate(`/ask/${cid}`);
  };
  const reprocess = async () => {
    await api(`/documents/${doc.id}/reprocess`, { method: "POST" });
    toast("Reading the document again.");
    load();
  };
  const remove = async () => {
    if (!confirm(`Remove "${doc.title}" from your library? Answers will stop using it.`)) return;
    await api(`/documents/${doc.id}`, { method: "DELETE" });
    toast("Document removed.");
    navigate("/library");
  };

  const meta = doc.meta ?? {};
  const busy = ["queued", "processing"].includes(doc.status);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="page">
      <Link to={isSchool ? "/library" : "/library?tab=pal"} className="btn ghost sm" style={{ marginBottom: 12, marginLeft: -10 }}>
        <ArrowLeft size={14} /> Library
      </Link>
      <div className="doc-head">
        <div className="row"><SourceTab school={isSchool} />{doc.category && <span className="muted small">{doc.category}</span>}</div>
        <h1>{doc.title || doc.filename}</h1>
        {doc.summary && <p style={{ color: "var(--ink-2)", fontSize: 16.5, maxWidth: "70ch" }}>{doc.summary}</p>}
        <div className="row" style={{ marginTop: 6 }}>
          <button className="btn primary" onClick={askAbout} disabled={doc.status !== "ready"}><MessageSquareText size={16} /> Ask about this</button>
          {!isSchool && doc.url && <a className="btn" href={doc.url} target="_blank" rel="noreferrer"><ExternalLink size={16} /> View on PAL</a>}
          {isSchool && doc.filename && doc.mime !== ".html" && <a className="btn" href={`/api/documents/${doc.id}/file`}><Download size={16} /> Original file</a>}
          {isSchool && doc.url && <a className="btn" href={doc.url} target="_blank" rel="noreferrer"><ExternalLink size={16} /> On your website</a>}
          {isSchool && isAdmin && (
            <>
              <span className="spacer" />
              <button className="btn ghost" onClick={() => setEditing(!editing)}><Pencil size={15} /> Edit details</button>
              <button className="btn ghost" onClick={reprocess} disabled={busy}><RefreshCw size={15} /> Read again</button>
              <button className="btn ghost danger" onClick={remove}><Trash2 size={15} /> Remove</button>
            </>
          )}
        </div>
      </div>

      {busy && <div className="notice info" style={{ marginBottom: 20 }}><Spinner /> <p>Reading this document. It'll be ready in a minute or two.</p></div>}
      {doc.status === "error" && <div className="notice error" role="alert" style={{ marginBottom: 20 }}>{doc.error}</div>}
      {isSchool && doc.status === "ready" && (doc.word_count ?? 0) < 150 && doc.mime === ".pdf" && (
        <div className="notice" style={{ marginBottom: 20 }}>
          <p>
            Only {doc.word_count} words could be read from this PDF, so it's probably a scan. Answers can't use what isn't
            readable. Save it again with text recognition (OCR) and upload the new copy.
          </p>
        </div>
      )}
      {isSchool && doc.needs_ai === 1 && doc.status === "ready" && (
        <div className="notice" style={{ marginBottom: 20 }}><p>This document can be searched, but it has no summary or review dates yet because AI wasn't set up when it was added. It'll be updated automatically once an API key is added.</p></div>
      )}

      {editing && <EditDetails doc={doc} onDone={() => { setEditing(false); load(); }} />}

      <dl className="facts">
        {isSchool ? (
          <>
            <div><dt>Type</dt><dd>{doc.doc_type ?? "—"}</dd></div>
            <div><dt>For</dt><dd>{doc.audience ?? "—"}</dd></div>
            <div><dt>Last reviewed</dt><dd>{doc.reviewed_date ? fmtDate(doc.reviewed_date) : "Not stated"}</dd></div>
            <div>
              <dt>Next review</dt>
              <dd style={doc.next_review && doc.next_review.slice(0, 10) < today ? { color: "var(--warn)" } : undefined}>
                {doc.next_review ? fmtDate(doc.next_review) : "Not stated"}
                {doc.next_review && doc.next_review.slice(0, 10) < today && " (overdue)"}
              </dd>
            </div>
          </>
        ) : (
          <>
            <div><dt>Policy last updated</dt><dd>{doc.reviewed_date ? fmtDate(doc.reviewed_date) : "Not stated"}</dd></div>
            <div><dt>Applies to</dt><dd>{meta.scope?.length ? meta.scope.join(", ") : "—"}</dd></div>
            <div><dt>Chapters</dt><dd>{meta.chapters?.length ?? "—"}</dd></div>
            <div><dt>Length</dt><dd>{doc.word_count ? `${Math.round(doc.word_count / 230)} min read` : "—"}</dd></div>
          </>
        )}
      </dl>

      <div className="doc-layout">
        <div className="stack" style={{ gap: 24 }}>
          <section className="card card-pad">
            <div className="row" style={{ marginBottom: 12 }}>
              <Sparkles size={16} color="var(--ink-3)" />
              <h2 style={{ fontSize: 16 }}>Plain-English briefing</h2>
            </div>
            {overview.loading && <p className="status-line"><Spinner size={14} /> Writing a briefing from the full text…</p>}
            {overview.error && <p className="muted">{overview.error}</p>}
            {overview.text && <Markdown text={overview.text} className="overview" />}
            {!overview.text && !overview.loading && !overview.error && (
              <p className="muted">{me.aiReady ? "No briefing yet." : "Briefings appear once an AI key has been added in Settings. The full text is below."}</p>
            )}
            {overview.text && <p className="small muted" style={{ marginTop: 14 }}>Written by AI from the document below. Check the original wording before acting on it.</p>}
          </section>

          {doc.body && (
            <section>
              <h2 style={{ marginBottom: 8 }}>Full text</h2>
              <Markdown text={doc.body.replace(/<!-- page (\d+) -->/g, "\n\n*Page $1*\n\n")} className="fulltext" />
            </section>
          )}
        </div>

        <aside className="stack" style={{ gap: 16 }}>
          {isSchool && (
            <section className="card card-pad">
              <h3 style={{ marginBottom: 4 }}>Related PAL topics</h3>
              <p className="small muted" style={{ marginBottom: 8 }}>You'll be alerted when these change.</p>
              {data.related.length === 0 && <p className="small muted">None found yet. Load the PAL library to link them.</p>}
              <div className="side-list">
                {data.related.map((r: any) => (
                  <Link key={r.slug} to={`/documents/${r.id}`}>
                    <div style={{ fontWeight: 600 }}>{r.title}</div>
                    {r.last_change && <div className="small muted">PAL changed {fmtDate(r.last_change)}{doc.reviewed_date && r.last_change > doc.reviewed_date ? ", after your review" : ""}</div>}
                  </Link>
                ))}
              </div>
            </section>
          )}
          {!isSchool && (
            <>
              <section className="card card-pad">
                <h3 style={{ marginBottom: 8 }}>Your documents that relate to this</h3>
                {data.usedBy.length === 0 && <p className="small muted">None of your school's documents match this topic.</p>}
                <div className="side-list">
                  {data.usedBy.map((d: any) => <Link key={d.id} to={`/documents/${d.id}`}>{d.title}</Link>)}
                </div>
              </section>
              {data.changes.length > 0 && (
                <section className="card card-pad">
                  <h3 style={{ marginBottom: 8 }}>Recent changes</h3>
                  <div className="stack" style={{ gap: 12 }}>
                    {data.changes.map((c: any, i: number) => (
                      <div key={i}>
                        <div className="small" style={{ fontWeight: 600 }}>{fmtDate(c.changed_on)}</div>
                        <div className="small muted">{c.description}</div>
                      </div>
                    ))}
                  </div>
                </section>
              )}
              {meta.related?.length > 0 && (
                <section className="card card-pad">
                  <h3 style={{ marginBottom: 8 }}>Related policies on PAL</h3>
                  <div className="side-list small">
                    {meta.related.map((r: any) => <RelatedLink key={r.slug} slug={r.slug} title={r.title} />)}
                  </div>
                </section>
              )}
              {meta.contacts?.length > 0 && (
                <section className="card card-pad">
                  <h3 style={{ marginBottom: 8 }}>Contacts</h3>
                  <div className="stack small" style={{ gap: 4 }}>
                    {meta.contacts.map((c: string) => <a key={c} href={`mailto:${c}`}>{c}</a>)}
                  </div>
                </section>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

function RelatedLink({ slug, title }: { slug: string; title: string }) {
  const navigate = useNavigate();
  const go = async (e: React.MouseEvent) => {
    e.preventDefault();
    const d = await api(`/documents?source=pal&q=${encodeURIComponent(slug)}`);
    const hit = d.documents.find((x: any) => x.title === title) ?? d.documents[0];
    if (hit) navigate(`/documents/${hit.id}`);
    else window.open(`https://www2.education.vic.gov.au/pal/${slug}`, "_blank", "noreferrer");
  };
  return <a href={`https://www2.education.vic.gov.au/pal/${slug}`} onClick={go}>{title}</a>;
}

function EditDetails({ doc, onDone }: { doc: any; onDone: () => void }) {
  const [opts, setOpts] = useState<any>(null);
  const toast = useToast();
  useEffect(() => { api("/documents?source=school&q=__none__").then(setOpts); }, []);
  const save = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    await api(`/documents/${doc.id}`, { method: "PATCH", body: Object.fromEntries(new FormData(e.currentTarget)) });
    toast("Details saved.");
    onDone();
  };
  if (!opts) return null;
  return (
    <form className="card card-pad form-grid" style={{ marginBottom: 24 }} onSubmit={save}>
      <div className="field wide"><label htmlFor="t">Title</label><input id="t" className="input" name="title" defaultValue={doc.title} required /></div>
      <div className="field"><label htmlFor="c">Category</label>
        <select id="c" className="select" name="category" defaultValue={doc.category ?? ""}><option value="">—</option>{opts.categories.map((c: string) => <option key={c}>{c}</option>)}</select></div>
      <div className="field"><label htmlFor="dt">Type</label>
        <select id="dt" className="select" name="doc_type" defaultValue={doc.doc_type ?? ""}><option value="">—</option>{opts.docTypes.map((c: string) => <option key={c}>{c}</option>)}</select></div>
      <div className="field"><label htmlFor="rv">Last reviewed</label><input id="rv" className="input" type="date" name="reviewed_date" defaultValue={doc.reviewed_date?.length === 10 ? doc.reviewed_date : ""} /></div>
      <div className="field"><label htmlFor="nr">Next review</label><input id="nr" className="input" type="date" name="next_review" defaultValue={doc.next_review?.length === 10 ? doc.next_review : ""} /></div>
      <div className="row wide"><button className="btn primary" type="submit">Save details</button><button className="btn ghost" type="button" onClick={onDone}>Cancel</button></div>
    </form>
  );
}
