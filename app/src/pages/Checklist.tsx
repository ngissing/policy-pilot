import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Check, CircleSlash, HelpCircle, X } from "lucide-react";
import { api, fmtDate } from "../api";
import { useMe } from "../App";
import { Spinner, useToast } from "../components/bits";

export default function Checklist() {
  const { me } = useMe();
  const toast = useToast();
  const isAdmin = me.user!.role === "admin";
  const [items, setItems] = useState<any[] | null>(null);
  const [docs, setDocs] = useState<any[]>([]);
  const [linking, setLinking] = useState<string | null>(null);

  const load = useCallback(() => api("/checklist").then((d) => setItems(d.items)), []);
  useEffect(() => {
    load();
    api("/documents?source=school").then((d) => setDocs(d.documents.filter((x: any) => x.status === "ready")));
  }, [load]);

  const mark = async (key: string, body: any, msg: string) => {
    await api(`/checklist/${key}`, { method: "PUT", body });
    setLinking(null);
    toast(msg);
    load();
  };

  if (!items) return <div className="empty"><Spinner /></div>;

  const have = items.filter((i) => i.status === "found" || i.status === "linked");
  const needsReview = have.filter((i) => i.flags.length > 0);
  const missing = items.filter((i) => i.status === "missing" || i.status === "possible");
  const na = items.filter((i) => i.status === "not_applicable");

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Policy checklist</h1>
          <p>
            Policies Victorian government schools commonly hold, each tied to the PAL topic behind it. PolicyPilot matches
            them to your documents and flags anything overdue or older than the latest PAL change.
          </p>
        </div>
      </div>

      {docs.length === 0 ? (
        <div className="notice" style={{ marginBottom: 16 }}>
          <div>
            <strong>Add your school's documents to check them against this list.</strong>
            <p>{isAdmin ? <>Upload them or find them on your website in <Link to="/add">Add documents</Link>.</> : "Ask your school admin to add them."}</p>
          </div>
        </div>
      ) : (
        <div className="tally">
          <div><strong>{have.length}</strong><span>In place</span></div>
          <div><strong style={{ color: needsReview.length ? "var(--warn)" : undefined }}>{needsReview.length}</strong><span>Need a look</span></div>
          <div><strong style={{ color: missing.length ? "var(--danger)" : undefined }}>{missing.length}</strong><span>Not found</span></div>
          <div><strong>{na.length}</strong><span>Marked not needed</span></div>
        </div>
      )}

      <div className="notice info" style={{ marginBottom: 16 }}>
        <HelpCircle size={18} />
        <p>
          This is a starting list, not the official one. The Department's full list of required school policies and templates
          is on the School Policy Templates Portal (staff login needed).
        </p>
      </div>

      <div className="card">
        {items.map((i) => (
          <div className="check-row" key={i.key}>
            <span className={`state-icon ${i.status === "found" || i.status === "linked" ? "found" : i.status === "possible" ? "possible" : i.status === "not_applicable" ? "na" : "missing"}`} aria-hidden>
              {i.status === "found" || i.status === "linked" ? <Check size={15} /> : i.status === "not_applicable" ? <CircleSlash size={14} /> : i.status === "possible" ? <HelpCircle size={15} /> : <X size={15} />}
            </span>
            <div style={{ minWidth: 0 }}>
              <div className="name">{i.name}</div>
              <div className="about">{i.about}</div>
              <div className="links">
                {i.document && (
                  <span>
                    {i.status === "possible" ? "Might be covered by " : "Your document: "}
                    <Link to={`/documents/${i.document.id}`}>{i.document.title}</Link>
                  </span>
                )}
                {i.status === "missing" && <span className="muted">No matching document found</span>}
                {i.status === "not_applicable" && <span className="muted">Marked as not needed</span>}
                {i.pal.documentId ? (
                  <Link to={`/documents/${i.pal.documentId}`}>PAL: {i.pal.title}</Link>
                ) : (
                  <a href={`https://www2.education.vic.gov.au/pal/${i.pal.slug}`} target="_blank" rel="noreferrer">PAL topic</a>
                )}
              </div>
              {i.flags.length > 0 && (
                <div className="flags">{i.flags.map((f: string) => <span key={f} className="badge warn">{f.replace(/(\d{4}-\d{2}(-\d{2})?)/g, (d) => fmtDate(d))}</span>)}</div>
              )}
              {linking === i.key && (
                <div className="row" style={{ marginTop: 10 }}>
                  <select className="select" style={{ maxWidth: 360 }} defaultValue="" onChange={(e) => e.target.value && mark(i.key, { status: "linked", documentId: Number(e.target.value) }, "Linked.")} aria-label="Choose the document">
                    <option value="" disabled>Choose the document…</option>
                    {docs.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
                  </select>
                  <button className="btn ghost sm" onClick={() => setLinking(null)}>Cancel</button>
                </div>
              )}
            </div>
            {isAdmin && (
              <div className="acts">
                {i.status === "possible" && <button className="btn sm" onClick={() => mark(i.key, { status: "linked", documentId: i.document.id }, "Confirmed.")}>That's it</button>}
                {i.status !== "not_applicable" && linking !== i.key && docs.length > 0 && (
                  <button className="btn ghost sm" onClick={() => setLinking(i.key)}>{i.document ? "Change" : "Choose document"}</button>
                )}
                {i.status !== "not_applicable" && i.status !== "linked" && i.status !== "found" && (
                  <button className="btn ghost sm" onClick={() => mark(i.key, { status: "not_applicable" }, "Marked as not needed.")}>Not needed</button>
                )}
                {(i.status === "not_applicable" || i.status === "linked") && (
                  <button className="btn ghost sm" onClick={() => mark(i.key, { status: "clear" }, "Reset.")}>Undo</button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
