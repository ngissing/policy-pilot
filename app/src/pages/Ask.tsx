import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { ArrowUp, Building2, ExternalLink, FileText, Landmark, Layers, MessageCircleQuestion, Trash2, X } from "lucide-react";
import { api, streamAnswer, fmtDate } from "../api";
import type { Message, Source } from "../api";
import { useConvoList, useMe } from "../App";
import { CitedMarkdown, SourceTab, Spinner, useToast } from "../components/bits";

type Scope = "all" | "department" | "school";

const EXAMPLES = [
  "A student has had an anaphylactic reaction on camp. What do we have to do and report?",
  "Can we ask parents to pay for a Year 9 excursion, and what if they can't?",
  "What are our obligations when a staff member suspects grooming?",
  "When can a principal suspend a student, and what process must we follow?",
  "What must our mobile phone policy say?",
  "How long do we keep student records?",
];

function ScopeControl({ scope, onChange, schoolDocs }: { scope: Scope; onChange: (s: Scope) => void; schoolDocs: number }) {
  return (
    <div className="segmented" role="group" aria-label="Which policies to search">
      <button type="button" aria-pressed={scope === "all"} onClick={() => onChange("all")}><Layers size={14} /> All policies</button>
      <button type="button" aria-pressed={scope === "department"} onClick={() => onChange("department")}><Landmark size={14} /> PAL only</button>
      <button
        type="button"
        aria-pressed={scope === "school"}
        onClick={() => onChange("school")}
        disabled={!schoolDocs}
        title={schoolDocs ? undefined : "Add your school's documents first"}
      >
        <Building2 size={14} /> Our school
      </button>
    </div>
  );
}

function LengthSelect() {
  const { me, refresh } = useMe();
  return (
    <select
      className="select length-select"
      aria-label="Answer length"
      title="How detailed answers are (also in Settings)"
      value={me.answerLength ?? "normal"}
      onChange={async (e) => {
        await api("/me/preferences", { method: "PATCH", body: { answerLength: e.target.value } });
        refresh();
      }}
    >
      <option value="short">Short answers</option>
      <option value="normal">Normal answers</option>
      <option value="extended">Extended answers</option>
    </select>
  );
}

function Composer({ onSend, busy, placeholder, children, autoFocus }: {
  onSend: (q: string) => void; busy: boolean; placeholder: string; children?: React.ReactNode; autoFocus?: boolean;
}) {
  const [q, setQ] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [q]);
  const send = () => {
    const text = q.trim();
    if (!text || busy) return;
    onSend(text);
    setQ("");
  };
  return (
    <form className="composer" onSubmit={(e) => { e.preventDefault(); send(); }}>
      <label className="visually-hidden" htmlFor="question">Your question</label>
      <textarea
        id="question"
        ref={ref}
        rows={1}
        value={q}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="composer-bar">
        {children}
        <span className="spacer" />
        <button className="btn primary icon" type="submit" disabled={!q.trim() || busy} aria-label="Ask">
          {busy ? <Spinner /> : <ArrowUp size={18} />}
        </button>
      </div>
    </form>
  );
}

export default function Ask() {
  const { id } = useParams();
  return id ? <Conversation key={id} id={Number(id)} /> : <AskHome />;
}

function AskHome() {
  const { me } = useMe();
  const navigate = useNavigate();
  const { bump } = useConvoList();
  const [scope, setScope] = useState<Scope>("all");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const firstName = me.user!.name.split(" ")[0];
  const palDocs = me.counts?.pal_docs ?? 0;

  const start = async (question: string) => {
    setBusy(true);
    try {
      const { id } = await api<{ id: number }>("/conversations", { body: { scope, question } });
      bump();
      navigate(`/ask/${id}`, { state: { ask: question } });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="ask-home">
      <h1>What do you need to check, {firstName}?</h1>
      <p className="lede">
        Ask in plain words. Answers come from {palDocs ? `${palDocs} PAL topics` : "the Department's PAL library"}
        {me.counts?.school_docs ? ` and ${me.counts.school_docs} of your school's documents` : ""}, with every claim linked to its source.
      </p>

      {!me.aiReady && (
        <div className="notice" style={{ marginBottom: 16 }}>
          <MessageCircleQuestion size={20} />
          <div>
            <strong>Answers need an AI key.</strong>
            <p>{me.user!.is_owner ? <>Add your Anthropic API key in <Link to="/settings">Settings</Link>. Search and the library work without it.</> : "Your platform owner needs to add an Anthropic API key before questions can be answered."}</p>
          </div>
        </div>
      )}
      {!palDocs && (
        <div className="notice info" style={{ marginBottom: 16 }}>
          <Landmark size={20} />
          <div>
            <strong>The PAL library hasn't been loaded yet.</strong>
            <p>{me.user!.is_owner ? <>Load it from <Link to="/settings">Settings</Link>. It takes about 10 minutes.</> : "Your platform owner can load it from Settings."}</p>
          </div>
        </div>
      )}

      <Composer onSend={start} busy={busy} placeholder="e.g. What do we need to do before a school camp?" autoFocus>
        <ScopeControl scope={scope} onChange={setScope} schoolDocs={me.counts?.school_docs ?? 0} />
        <LengthSelect />
      </Composer>

      <div className="examples">
        {EXAMPLES.map((q) => (
          <button key={q} type="button" onClick={() => start(q)} disabled={busy}>
            <MessageCircleQuestion size={16} />
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}

interface LiveMessage extends Message {
  streaming?: boolean;
  status?: string;
  error?: string;
}

function Conversation({ id }: { id: number }) {
  const { me } = useMe();
  const location = useLocation();
  const navigate = useNavigate();
  const { bump } = useConvoList();
  const toast = useToast();
  const [convo, setConvo] = useState<any>(null);
  const [messages, setMessages] = useState<LiveMessage[]>([]);
  const [panel, setPanel] = useState<{ msg: number; n: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const asked = useRef(false);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    let live = true;
    api(`/conversations/${id}`)
      .then((d) => {
        if (!live) return;
        setConvo(d.conversation);
        setMessages(d.messages);
        const pending = (location.state as any)?.ask as string | undefined;
        if (pending && !asked.current && d.messages.length === 0) {
          asked.current = true;
          navigate(location.pathname, { replace: true, state: null });
          send(pending);
        }
      })
      .catch(() => live && navigate("/"));
    return () => {
      live = false;
      abort.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    const el = scroller.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 240) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const updateLast = (fn: (m: LiveMessage) => LiveMessage) =>
    setMessages((ms) => (ms[ms.length - 1]?.role === "assistant" ? [...ms.slice(0, -1), fn(ms[ms.length - 1])] : ms));

  async function send(question: string) {
    setBusy(true);
    setPanel(null);
    setMessages((ms) => [
      ...ms,
      { id: `q${Date.now()}`, role: "user", content: question, sources: [], followups: [] },
      { id: `a${Date.now()}`, role: "assistant", content: "", sources: [], followups: [], streaming: true, status: "Searching policies…" },
    ]);
    abort.current = new AbortController();
    try {
      await streamAnswer(id, question, {
        status: (s) => updateLast((m) => ({ ...m, status: s })),
        sources: (sources) => updateLast((m) => ({ ...m, sources })),
        text: (d) => updateLast((m) => ({ ...m, content: m.content + d, status: undefined })),
        done: (d) => updateLast((m) => ({ ...m, id: d.messageId, followups: d.followups, streaming: false })),
        error: (msg) => updateLast((m) => ({ ...m, streaming: false, error: msg })),
      }, abort.current.signal);
    } catch {
      updateLast((m) => ({ ...m, streaming: false }));
    }
    updateLast((m) => ({ ...m, streaming: false, status: undefined }));
    setBusy(false);
    bump();
  }

  const changeScope = async (scope: Scope) => {
    setConvo((c: any) => ({ ...c, scope }));
    await api(`/conversations/${id}`, { method: "PATCH", body: { scope } });
  };

  const remove = async () => {
    await api(`/conversations/${id}`, { method: "DELETE" });
    bump();
    toast("Conversation deleted.");
    navigate("/");
  };

  const active = panel ? messages[panel.msg]?.sources.find((s) => s.n === panel.n) : null;

  if (!convo) return <div className="empty"><Spinner /></div>;

  return (
    <div className={`convo${active ? " with-panel" : ""}`}>
      <div className="thread">
        <div className="thread-scroll" ref={scroller}>
          <div className="thread-inner">
            <div className="thread-head">
              <h1>{convo.title}</h1>
              {convo.document_id ? (
                <Link to={`/documents/${convo.document_id}`} className="badge dept"><FileText size={12} /> Only: {convo.document_title}</Link>
              ) : (
                <ScopeControl scope={convo.scope} onChange={changeScope} schoolDocs={me.counts?.school_docs ?? 0} />
              )}
              <button className="btn ghost icon" onClick={remove} aria-label="Delete conversation" title="Delete conversation"><Trash2 size={16} /></button>
            </div>

            {messages.length === 0 && (
              <p className="muted">Ask your first question{convo.document_title ? ` about ${convo.document_title}` : ""} below.</p>
            )}

            {messages.map((m, i) =>
              m.role === "user" ? (
                <div key={m.id} className="q">{m.content}</div>
              ) : (
                <AnswerBlock
                  key={m.id}
                  m={m}
                  activeN={panel?.msg === i ? panel.n : null}
                  onCite={(n) => setPanel(panel?.msg === i && panel.n === n ? null : { msg: i, n })}
                  onFollowup={(q) => !busy && send(q)}
                  isLast={i === messages.length - 1}
                />
              )
            )}

            {!busy && messages.length > 0 && messages[messages.length - 1].role === "user" && (
              <div className="notice">
                <p>This question hasn't been answered.</p>
                <button
                  className="btn sm"
                  onClick={() => {
                    const last = messages[messages.length - 1];
                    setMessages((ms) => ms.slice(0, -1));
                    send(last.content);
                  }}
                >
                  Try again
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="thread-foot">
          <Composer onSend={send} busy={busy} placeholder="Ask a follow-up question">
            <LengthSelect />
          </Composer>
        </div>
      </div>

      {active && <SourcePanel s={active} onClose={() => setPanel(null)} />}
    </div>
  );
}

function AnswerBlock({ m, activeN, onCite, onFollowup, isLast }: {
  m: LiveMessage; activeN: number | null; onCite: (n: number) => void; onFollowup: (q: string) => void; isLast: boolean;
}) {
  const cited = new Set([...m.content.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].flatMap((x) => x[1].split(/\s*,\s*/).map(Number)));
  // With no answer text (e.g. AI unavailable) every passage found is worth showing.
  const showEverything = m.streaming || !m.content.trim();
  const shown = showEverything ? m.sources : m.sources.filter((s) => cited.has(s.n));
  const extra = showEverything ? [] : m.sources.filter((s) => !cited.has(s.n));
  const [showAll, setShowAll] = useState(false);

  return (
    <div className="a">
      {m.status && (
        <div className="status-line"><Spinner size={14} /> {m.status}</div>
      )}
      {m.content && (
        <CitedMarkdown
          text={m.content}
          sources={m.sources}
          onCite={onCite}
          active={activeN}
          className={`answer${m.streaming ? " streaming" : ""}`}
        />
      )}
      {m.error && <div className="notice error" role="alert">{m.error}</div>}

      {(shown.length > 0 || extra.length > 0) && (
        <div className="sources">
          <span className="sources-label">{m.streaming ? "Reading" : showEverything ? "Most relevant passages" : "Sources"}</span>
          {[...shown, ...(showAll ? extra : [])].map((s) => (
            <button key={s.n} type="button" className={`source-row${cited.has(s.n) || showEverything ? "" : " unused"}`} onClick={() => onCite(s.n)}>
              <span className={`cite${s.isSchool ? " school" : ""}`} aria-hidden>{s.n}</span>
              <span style={{ minWidth: 0 }}>
                <span className="t">{s.title}</span>
                {s.section && <span className="s"> › {s.section}</span>}
              </span>
              <span className="muted small">{s.reviewed ? fmtDate(s.reviewed) : ""}</span>
            </button>
          ))}
          {extra.length > 0 && (
            <button type="button" className="btn ghost sm" style={{ alignSelf: "flex-start" }} onClick={() => setShowAll(!showAll)}>
              {showAll ? "Hide" : "Show"} {extra.length} other passage{extra.length === 1 ? "" : "s"} it read
            </button>
          )}
        </div>
      )}

      {isLast && !m.streaming && m.followups.length > 0 && (
        <div className="followups" aria-label="Suggested follow-up questions">
          {m.followups.map((f) => <button key={f} type="button" onClick={() => onFollowup(f)}>{f}</button>)}
        </div>
      )}
    </div>
  );
}

function SourcePanel({ s, onClose }: { s: Source; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <aside className="panel" aria-label="Source">
      <div className="panel-head">
        <div style={{ flex: 1, minWidth: 0 }} className="stack">
          <div className="row"><SourceTab school={s.isSchool} /><span className="muted small">Source {s.n}</span></div>
          <h2 style={{ fontSize: 18 }}>{s.title}</h2>
          {s.section && <p className="muted small">{s.section}</p>}
        </div>
        <button className="btn ghost icon" onClick={onClose} aria-label="Close source"><X size={18} /></button>
      </div>
      <div className="panel-body">
        {s.reviewed && <p className="small muted">{s.isSchool ? "Reviewed" : "Policy last updated"} {fmtDate(s.reviewed)}</p>}
        <div className="excerpt">{s.excerpt.replace(/<!-- page \d+ -->\s*/g, "")}{s.excerpt.length >= 1400 ? "…" : ""}</div>
        <div className="row">
          <Link className="btn sm" to={`/documents/${s.documentId}`}><FileText size={14} /> Open document</Link>
          {s.url && (
            <a className="btn sm" href={s.url} target="_blank" rel="noreferrer">
              <ExternalLink size={14} /> {s.isSchool ? "Original" : "View on PAL"}
            </a>
          )}
        </div>
      </div>
    </aside>
  );
}
