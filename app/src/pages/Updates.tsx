import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Check } from "lucide-react";
import { api, fmtDate } from "../api";
import { useMe } from "../App";
import { Spinner } from "../components/bits";

export default function Updates() {
  const { refresh } = useMe();
  const [data, setData] = useState<any>(null);
  const [onlyMine, setOnlyMine] = useState(false);

  const load = useCallback(() => api("/updates").then(setData), []);
  useEffect(() => { load(); }, [load]);

  const ack = async (id: number) => {
    await api(`/updates/${id}/ack`, { method: "POST" });
    await load();
    refresh();
  };

  if (!data) return <div className="empty"><Spinner /></div>;

  const changes = (data.changes as any[]).filter((c) => !onlyMine || c.affects.length > 0);
  const months = new Map<string, any[]>();
  for (const c of changes) {
    const key = c.changed_on?.slice(0, 7) ?? "Undated";
    months.set(key, [...(months.get(key) ?? []), c]);
  }
  const mineCount = (data.changes as any[]).filter((c) => c.affects.length > 0 && !c.acked).length;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>PAL updates</h1>
          <p>
            Every change the Department has made to PAL in the last 12 months, in its own words. Changes to topics your
            documents rely on are highlighted so you can check whether your policy needs updating.
          </p>
        </div>
        <div className="segmented" role="group" aria-label="Filter changes">
          <button aria-pressed={!onlyMine} onClick={() => setOnlyMine(false)}>All changes</button>
          <button aria-pressed={onlyMine} onClick={() => setOnlyMine(true)}>Affects us {mineCount > 0 && <span className="badge count">{mineCount}</span>}</button>
        </div>
      </div>
      {data.lastSync && <p className="small muted" style={{ marginTop: -12, marginBottom: 12 }}>Checked against PAL {fmtDate(data.lastSync)}. PolicyPilot checks weekly.</p>}

      {changes.length === 0 ? (
        <div className="card empty">
          <h2>{onlyMine ? "Nothing affects your documents" : "No changes yet"}</h2>
          <p>{onlyMine ? "None of the PAL topics your documents relate to have changed in the last 12 months." : "Changes appear once the PAL library has been loaded."}</p>
        </div>
      ) : (
        [...months.entries()].map(([month, list]) => (
          <section key={month}>
            <h2 className="month">{month === "Undated" ? month : fmtDate(month)}</h2>
            <div className="card">
              {list.map((c) => (
                <div key={c.id} className={`change${c.affects.length && !c.acked ? " affects" : ""}`}>
                  <div className="date">{fmtDate(c.changed_on)}</div>
                  <div>
                    <div className="topic">
                      {c.document_id ? <Link to={`/documents/${c.document_id}`}>{c.title}</Link> : c.title}
                      {c.kind === "new" && <span className="badge dept" style={{ marginLeft: 8 }}>New topic</span>}
                      {c.kind === "retired" && <span className="badge danger" style={{ marginLeft: 8 }}>Retired</span>}
                    </div>
                    {c.description && <div className="desc">{c.description}</div>}
                    {c.affects.length > 0 && (
                      <div className="affects-box">
                        <span className="muted">Check:</span>
                        {c.affects.map((d: any) => <Link key={d.id} to={`/documents/${d.id}`} className="badge ok">{d.title}</Link>)}
                        {c.acked ? (
                          <span className="muted small row" style={{ gap: 4 }}><Check size={14} /> Checked</span>
                        ) : (
                          <button className="btn sm" onClick={() => ack(c.id)}><Check size={14} /> Mark as checked</button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
