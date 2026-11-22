import { useCallback, useEffect, useState } from "react";
import { Copy, Cpu, Download, KeyRound, Landmark, RefreshCw, Trash2 } from "lucide-react";
import { api, fmtDate } from "../api";
import type { Source } from "../api";
import { useMe } from "../App";
import { CitedMarkdown, Spinner, usePoll, useToast } from "../components/bits";

export const LENGTH_OPTIONS = [
  { id: "short", label: "Short", about: "The direct answer and only the must-dos. Reads up to 5 passages." },
  { id: "normal", label: "Normal", about: "The answer plus the key requirements or steps. Reads up to 7 passages." },
  { id: "extended", label: "Extended", about: "Every relevant requirement, exceptions, roles and related policies. Reads up to 10 passages." },
] as const;

export default function Settings() {
  const { me } = useMe();
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Your school's profile helps PolicyPilot pitch its answers. Staff join with your school's code.</p>
        </div>
      </div>
      <div className="stack" style={{ gap: 24 }}>
        <AnswerPreferences />
        <YourAccount />
        <SchoolProfile />
        <Staff />
        {!!me.user!.is_owner && <Platform />}
      </div>
    </div>
  );
}

function AnswerPreferences() {
  const { me, refresh } = useMe();
  const toast = useToast();
  const current = me.answerLength ?? "normal";
  const choose = async (answerLength: string) => {
    await api("/me/preferences", { method: "PATCH", body: { answerLength } });
    await refresh();
    toast("Answer length saved.");
  };
  return (
    <section className="card card-pad">
      <h2 style={{ marginBottom: 4 }}>Your answers</h2>
      <p className="muted small" style={{ marginBottom: 14 }}>How much detail you get. Just for you; you can also switch it under the question box.</p>
      <div className="choice-grid" role="radiogroup" aria-label="Answer length">
        {LENGTH_OPTIONS.map((o) => (
          <button key={o.id} type="button" role="radio" aria-checked={current === o.id} className="choice" onClick={() => choose(o.id)}>
            <strong>{o.label}</strong>
            <span>{o.about}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function SchoolProfile() {
  const { me, refresh } = useMe();
  const toast = useToast();
  const [school, setSchool] = useState<any>(null);
  const isAdmin = me.user!.role === "admin";
  useEffect(() => { api("/school").then((d) => setSchool(d.school)); }, []);
  if (!school) return null;

  const save = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    await api("/school", { method: "PATCH", body: Object.fromEntries(new FormData(e.currentTarget)) });
    await refresh();
    toast("School profile saved.");
  };

  return (
    <form className="card card-pad" onSubmit={save}>
      <h2 style={{ marginBottom: 16 }}>School profile</h2>
      <fieldset disabled={!isAdmin} style={{ border: 0, padding: 0, margin: 0 }} className="form-grid">
        <div className="field"><label htmlFor="sn">School name</label><input id="sn" className="input" name="name" defaultValue={school.name} required /></div>
        <div className="field">
          <label htmlFor="st">Type of school</label>
          <select id="st" className="select" name="school_type" defaultValue={school.school_type ?? ""}>
            <option value="">—</option>
            {["Primary", "Secondary", "P–12", "Specialist", "Flexible learning", "Language school", "Other"].map((t) => <option key={t}>{t}</option>)}
          </select>
        </div>
        <div className="field"><label htmlFor="sb">Suburb or town</label><input id="sb" className="input" name="suburb" defaultValue={school.suburb ?? ""} /></div>
        <div className="field">
          <label htmlFor="rg">Region</label>
          <select id="rg" className="select" name="region" defaultValue={school.region ?? ""}>
            <option value="">—</option>
            {["North-Eastern Victoria", "North-Western Victoria", "South-Eastern Victoria", "South-Western Victoria"].map((t) => <option key={t}>{t}</option>)}
          </select>
        </div>
        <div className="field wide"><label htmlFor="ws">Website</label><input id="ws" className="input" name="website" defaultValue={school.website ?? ""} placeholder="www.yourschool.vic.edu.au" /></div>
        <div className="field wide">
          <label htmlFor="ab">About your school</label>
          <textarea id="ab" className="textarea" name="about" defaultValue={school.about ?? ""} placeholder="e.g. Years 7–12, about 600 students, two campuses, a flexible learning program, students on Individual Education Plans." />
          <span className="hint">Shared with the AI so answers fit your setting. Don't include student or staff names.</span>
        </div>
        {isAdmin && <div className="wide"><button className="btn primary" type="submit">Save profile</button></div>}
      </fieldset>
    </form>
  );
}

function YourAccount() {
  const { me } = useMe();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    if (f.get("next") !== f.get("again")) return setError("The two new passwords don't match.");
    setError(null);
    try {
      await api("/me/password", { body: { current: f.get("current"), next: f.get("next") } });
      form.reset();
      setOpen(false);
      toast("Password changed. Other browsers have been signed out.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <section className="card card-pad">
      <div className="row">
        <div style={{ flex: 1 }}>
          <h2 style={{ marginBottom: 2 }}>Your account</h2>
          <p className="muted small">{me.user!.name}, {me.user!.email}</p>
        </div>
        {!open && <button className="btn" onClick={() => setOpen(true)}><KeyRound size={15} /> Change password</button>}
      </div>
      {open && (
        <form className="form-grid" style={{ marginTop: 16 }} onSubmit={save}>
          <div className="field wide"><label htmlFor="cur">Current password</label><input id="cur" className="input" name="current" type="password" required autoComplete="current-password" /></div>
          <div className="field"><label htmlFor="nw">New password</label><input id="nw" className="input" name="next" type="password" required minLength={10} autoComplete="new-password" /><span className="hint">At least 10 characters.</span></div>
          <div className="field"><label htmlFor="nw2">Type it again</label><input id="nw2" className="input" name="again" type="password" required minLength={10} autoComplete="new-password" /></div>
          {error && <div className="notice error wide" role="alert">{error}</div>}
          <div className="row wide"><button className="btn primary" type="submit">Save password</button><button className="btn ghost" type="button" onClick={() => { setOpen(false); setError(null); }}>Cancel</button></div>
        </form>
      )}
    </section>
  );
}

function Staff() {
  const { me } = useMe();
  const toast = useToast();
  const [data, setData] = useState<any>(null);
  const [reset, setReset] = useState<{ name: string; email: string; password: string } | null>(null);
  const isAdmin = me.user!.role === "admin";
  const load = useCallback(() => api("/school").then(setData), []);
  useEffect(() => { load(); }, [load]);
  if (!data) return null;

  const copy = async () => {
    await navigator.clipboard.writeText(data.school.join_code);
    toast("Join code copied.");
  };
  const newCode = async () => {
    if (!confirm("Make a new join code? The old one will stop working.")) return;
    await api("/school/join-code", { method: "POST" });
    load();
  };
  const setRole = async (id: number, role: string) => {
    await api(`/school/staff/${id}`, { method: "PATCH", body: { role } });
    load();
  };
  const remove = async (s: any) => {
    if (!confirm(`Remove ${s.name}'s access?`)) return;
    await api(`/school/staff/${s.id}`, { method: "DELETE" });
    load();
  };
  const resetPassword = async (s: any) => {
    if (!confirm(`Give ${s.name} a one-time password? Their current password stops working and they're signed out.`)) return;
    try {
      const { password } = await api(`/school/staff/${s.id}/reset-password`, { method: "POST" });
      setReset({ name: s.name, email: s.email, password });
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="card card-pad">
      <h2 style={{ marginBottom: 6 }}>Staff</h2>
      {isAdmin && (
        <div className="row" style={{ marginBottom: 16 }}>
          <p className="muted">Staff join at this site using the code</p>
          <code style={{ fontSize: 17, fontWeight: 700, background: "var(--mark-soft)", padding: "3px 10px", borderRadius: 6 }}>{data.school.join_code}</code>
          <button className="btn sm" onClick={copy}><Copy size={14} /> Copy</button>
          <button className="btn ghost sm" onClick={newCode}><RefreshCw size={14} /> New code</button>
        </div>
      )}
      <div className="stack" style={{ gap: 0 }}>
        {data.staff.map((s: any) => (
          <div key={s.id} className="row" style={{ padding: "10px 0", borderTop: "1px solid var(--rule)" }}>
            <div style={{ flex: 1, minWidth: 180 }}>
              <div style={{ fontWeight: 600 }}>{s.name}{s.id === me.user!.id && <span className="muted"> (you)</span>}</div>
              <div className="small muted">{s.email}</div>
            </div>
            {isAdmin && s.id !== me.user!.id ? (
              <>
                <select className="select" style={{ width: 150 }} value={s.role} onChange={(e) => setRole(s.id, e.target.value)} aria-label={`Role for ${s.name}`}>
                  <option value="staff">Staff</option>
                  <option value="admin">School admin</option>
                </select>
                <button className="btn ghost sm" onClick={() => resetPassword(s)} title={`Give ${s.name} a one-time password`}>
                  <KeyRound size={14} /> Reset password
                </button>
                <button className="btn ghost icon" onClick={() => remove(s)} aria-label={`Remove ${s.name}`}><Trash2 size={16} /></button>
              </>
            ) : (
              <span className="badge">{s.role === "admin" ? "School admin" : "Staff"}</span>
            )}
          </div>
        ))}
      </div>
      {reset && (
        <div className="notice" role="status" style={{ marginTop: 12 }}>
          <div className="stack" style={{ gap: 8 }}>
            <p>
              One-time password for <strong>{reset.name}</strong> ({reset.email}). Give it to them in person or by phone. They'll
              choose their own when they sign in. It won't be shown again.
            </p>
            <div className="row">
              <code style={{ fontSize: 17, fontWeight: 700, background: "var(--surface)", padding: "3px 10px", borderRadius: 6 }}>{reset.password}</code>
              <button className="btn sm" onClick={async () => { await navigator.clipboard.writeText(reset.password); toast("Copied."); }}><Copy size={14} /> Copy</button>
              <button className="btn ghost sm" onClick={() => setReset(null)}>Done</button>
            </div>
          </div>
        </div>
      )}
      <p className="small muted" style={{ marginTop: 10 }}>School admins can add and remove documents. Staff can ask questions and read the library.</p>
    </section>
  );
}

function Platform() {
  const { refresh } = useMe();
  const toast = useToast();
  const [p, setP] = useState<any>(null);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api("/platform").then(setP), []);
  useEffect(() => { load(); }, [load]);
  usePoll(load, 2000, !!p?.pal.running);
  useEffect(() => { if (p && !p.pal.running) refresh(); }, [p?.pal.running]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!p) return null;

  const saveKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const r = await api("/platform/key", { method: "PUT", body: { key } });
      setKey("");
      toast(r.retagging ? `Key saved. Updating ${r.retagging} documents that were added without AI.` : "Key saved and working.");
      await load();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setSaving(false);
  };
  const removeKey = async () => {
    if (!confirm("Remove the API key? Questions will stop being answered.")) return;
    await api("/platform/key", { method: "PUT", body: { key: "" } });
    load();
    refresh();
  };
  const sync = async (full: boolean) => {
    await api("/platform/pal-sync", { body: { full } });
    load();
  };

  const job = p.job;
  return (
    <section className="card card-pad stack">
      <div>
        <h2>Platform</h2>
        <p className="muted small" style={{ marginTop: 4 }}>Only you see this. These settings apply to all {p.schools} school{p.schools === 1 ? "" : "s"} on this PolicyPilot.</p>
      </div>

      <div className="stack" style={{ gap: 10 }}>
        <h3 className="row"><KeyRound size={16} /> AI answers</h3>
        {p.ai.ready ? (
          <div className="row">
            <span className="badge ok">Connected</span>
            <span className="small muted">
              {p.ai.source === "environment" ? "Using ANTHROPIC_API_KEY from the server environment" : `Key ending ${p.ai.hint}`}, model {p.ai.model}
            </span>
            {p.ai.source === "settings" && <button className="btn ghost sm" onClick={removeKey}>Remove key</button>}
          </div>
        ) : (
          <p className="small">Add an Anthropic API key to turn on answers, document briefings and automatic tagging. Get one at console.anthropic.com.</p>
        )}
        <form className="row" onSubmit={saveKey}>
          <input className="input" style={{ maxWidth: 420 }} type="password" autoComplete="off" placeholder={p.ai.ready ? "Replace the key" : "sk-ant-…"} value={key} onChange={(e) => setKey(e.target.value)} aria-label="Anthropic API key" />
          <button className="btn primary" type="submit" disabled={!key || saving}>{saving && <Spinner />} Save key</button>
        </form>
        {error && <div className="notice error" role="alert">{error}</div>}
      </div>

      <div className="stack" style={{ gap: 10, borderTop: "1px solid var(--rule)", paddingTop: 16 }}>
        <h3 className="row"><Landmark size={16} /> PAL library</h3>
        <p className="small">
          {p.pal.topics ? `${p.pal.topics} topics${p.pal.guides ? ` and ${p.pal.guides} guides` : ""} loaded` : "Not loaded yet"}
          {p.pal.lastSync && `, last checked ${fmtDate(p.pal.lastSync)}`}. PolicyPilot checks PAL for changes every week and only re-reads topics that changed.
        </p>
        {p.pal.running && job ? (
          <div className="stack" style={{ gap: 6, maxWidth: 520 }}>
            <div className="progress"><div style={{ width: `${(job.done / Math.max(1, job.total)) * 100}%` }} /></div>
            <p className="small muted" aria-live="polite">{job.done} of {job.total}: {job.message}</p>
          </div>
        ) : (
          <>
            {job?.status === "failed" && <div className="notice error">{job.message}</div>}
            {job?.status === "done" && <p className="small muted">Last run: {job.message}</p>}
            <div className="row">
              <button className="btn primary" onClick={() => sync(false)}>{p.pal.topics ? "Check for changes now" : "Load the PAL library"}</button>
              {!!p.pal.topics && <button className="btn ghost" onClick={() => sync(true)}>Re-read every topic</button>}
            </div>
            {!p.pal.topics && <p className="small muted">Takes about 10–15 minutes. PolicyPilot reads one page at a time so it doesn't load the Department's site.</p>}
          </>
        )}
      </div>

      <Models p={p} onSaved={load} />
      <Invites />
      <Backup />
    </section>
  );
}

/** New schools join by invitation: the owner makes a single-use link and sends it to the school's leader. */
function Invites() {
  const { me } = useMe();
  const toast = useToast();
  const [data, setData] = useState<{ invites: any[]; schools: any[] } | null>(null);
  const [note, setNote] = useState("");
  const load = useCallback(() => api("/platform/invites").then(setData), []);
  useEffect(() => { load(); }, [load]);
  const link = (token: string) => `${window.location.origin}/?invite=${token}`;
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const { token } = await api("/platform/invites", { body: { note } });
    await navigator.clipboard.writeText(link(token)).catch(() => {});
    setNote("");
    toast("Invitation link made and copied.");
    load();
  };
  const cancel = async (token: string) => {
    await api(`/platform/invites/${token}`, { method: "DELETE" });
    load();
  };
  if (!data) return null;
  const open = data.invites.filter((i) => !i.used_at);
  return (
    <div className="stack" style={{ gap: 10, borderTop: "1px solid var(--rule)", paddingTop: 16 }}>
      <h3 className="row"><Landmark size={16} /> Schools</h3>
      <p className="small">
        {data.schools.length} school{data.schools.length === 1 ? "" : "s"} on this PolicyPilot.{" "}
        {me.signup?.schools === "open"
          ? "Anyone can set up a new school (SCHOOL_SIGNUP=open)."
          : "New schools need an invitation link. Each link works once and lasts 14 days."}
      </p>
      <form className="row" onSubmit={create}>
        <input className="input" style={{ maxWidth: 360 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Which school is it for? (optional)" aria-label="Which school the invitation is for" />
        <button className="btn primary" type="submit">Make invitation link</button>
      </form>
      {open.length > 0 && (
        <div className="stack" style={{ gap: 6 }}>
          {open.map((i) => (
            <div key={i.token} className="file-item">
              <span className="name">{i.note || "Invitation"} <span className="muted small">expires {fmtDate(new Date(i.expires_at).toISOString())}</span></span>
              <button className="btn sm" onClick={async () => { await navigator.clipboard.writeText(link(i.token)); toast("Link copied."); }}><Copy size={14} /> Copy link</button>
              <button className="btn ghost sm" onClick={() => cancel(i.token)}>Cancel</button>
            </div>
          ))}
        </div>
      )}
      {data.schools.length > 1 && (
        <details>
          <summary className="small" style={{ cursor: "pointer" }}>All schools</summary>
          <div className="stack small" style={{ gap: 4, marginTop: 8 }}>
            {data.schools.map((s: any) => <span key={s.name + s.created_at}>{s.name} <span className="muted">({s.staff} staff, since {fmtDate(s.created_at)})</span></span>)}
          </div>
        </details>
      )}
    </div>
  );
}

function Backup() {
  return (
    <div className="stack" style={{ gap: 8, borderTop: "1px solid var(--rule)", paddingTop: 16 }}>
      <h3 className="row"><Download size={16} /> Backups</h3>
      <p className="small">
        PolicyPilot keeps a copy of its database from each of the last 7 days next to the live one. That covers mistakes,
        not losing the server, so download a copy now and then and keep it somewhere safe. It holds every school's
        documents and accounts.
      </p>
      <div><a className="btn" href="/api/platform/backup"><Download size={15} /> Download a backup</a></div>
    </div>
  );
}

const ROLE_HINTS: Record<string, string> = {
  "claude-opus-5-5": "Most capable. The safest choice for nuanced policy questions.",
  "claude-sonnet-5-5": "About half the cost of Opus. Strong at reading sources and citing them.",
  "claude-haiku-5-5": "About 40 times cheaper than Opus. Well suited to tagging and summarising documents.",
};

function Models({ p, onSaved }: { p: any; onSaved: () => void }) {
  const toast = useToast();
  const options: Array<{ id: string; label: string; input: number; output: number }> = p.models.options;
  const save = async (field: "answers" | "processing", id: string) => {
    await api("/platform/models", { method: "PUT", body: { [field]: id } });
    toast("Model saved.");
    onSaved();
  };
  const price = (o: { input: number; output: number }) => `US$${o.input} in / $${o.output} out per million tokens`;
  return (
    <div className="stack" style={{ gap: 12, borderTop: "1px solid var(--rule)", paddingTop: 16 }}>
      <h3 className="row"><Cpu size={16} /> Models</h3>
      <div className="form-grid">
        {(["answers", "processing"] as const).map((field) => (
          <div className="field" key={field}>
            <label htmlFor={`m-${field}`}>{field === "answers" ? "Answering questions" : "Reading documents (tags, categories, briefings)"}</label>
            <select id={`m-${field}`} className="select" value={p.models[field]} onChange={(e) => save(field, e.target.value)}>
              {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
            <span className="hint">
              {ROLE_HINTS[p.models[field]]} {price(options.find((o) => o.id === p.models[field])!)}.
            </span>
          </div>
        ))}
      </div>
      <Compare options={options} ready={p.ai.ready} />
    </div>
  );
}

/** Ask one question of several models from the same sources and compare them side by side. */
function Compare({ options, ready }: { options: Array<{ id: string; label: string }>; ready: boolean }) {
  const [question, setQuestion] = useState("");
  const [picked, setPicked] = useState<string[]>(options.map((o) => o.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [out, setOut] = useState<{ sources: Source[]; results: any[] } | null>(null);

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setOut(await api("/platform/compare", { body: { question, models: picked } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  };

  return (
    <details className="compare">
      <summary>Compare models on your own question</summary>
      <p className="small muted" style={{ margin: "8px 0 12px" }}>
        Each model answers from exactly the same passages, so you can judge whether a cheaper one is good enough. A comparison
        costs a few cents.
      </p>
      <form className="stack" style={{ gap: 10 }} onSubmit={run}>
        <textarea className="textarea" style={{ minHeight: 70 }} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="e.g. What must we do before a Year 9 camp?" aria-label="Question to compare" />
        <div className="row">
          {options.map((o) => (
            <label key={o.id} className="row small" style={{ gap: 6 }}>
              <input
                type="checkbox"
                checked={picked.includes(o.id)}
                onChange={(e) => setPicked((ps) => (e.target.checked ? [...ps, o.id] : ps.filter((x) => x !== o.id)))}
              />
              {o.label}
            </label>
          ))}
          <span className="spacer" />
          <button className="btn primary" type="submit" disabled={!ready || busy || !question.trim() || !picked.length}>
            {busy && <Spinner />} {busy ? "Asking…" : "Compare"}
          </button>
        </div>
        {!ready && <p className="small muted">Add an API key first.</p>}
      </form>
      {error && <div className="notice error" role="alert" style={{ marginTop: 12 }}>{error}</div>}
      {out && (
        <div className="compare-grid" style={{ marginTop: 16 }}>
          {out.results.map((r) => (
            <div key={r.model} className="compare-col">
              <div className="compare-head">
                <strong>{r.label}</strong>
                {!r.error && (
                  <span className="small muted">
                    {r.seconds.toFixed(1)}s, {r.inputTokens.toLocaleString()} in / {r.outputTokens.toLocaleString()} out, about US${r.cost.toFixed(3)}
                  </span>
                )}
              </div>
              {r.error ? <p className="small" style={{ color: "var(--danger)" }}>{r.error}</p> : (
                <CitedMarkdown text={r.text} sources={out.sources} onCite={() => {}} className="answer compact" />
              )}
            </div>
          ))}
        </div>
      )}
    </details>
  );
}
