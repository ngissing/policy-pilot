import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Building2, Landmark, Loader2 } from "lucide-react";
import type { Source } from "../api";

export function SourceTab({ school }: { school: boolean }) {
  return school ? (
    <span className="tab school"><Building2 size={12} aria-hidden /> Our school</span>
  ) : (
    <span className="tab dept"><Landmark size={12} aria-hidden /> Department (PAL)</span>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <Loader2 size={size} className="spin" aria-hidden />;
}

/** Answer text with [n] citations turned into clickable source tabs. */
export function CitedMarkdown({
  text,
  sources,
  onCite,
  active,
  className,
}: {
  text: string;
  sources: Source[];
  onCite: (n: number) => void;
  active?: number | null;
  className?: string;
}) {
  // "[1, 3]" and "[1][3]" both become separate citation links.
  const prepared = text.replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (_m, nums: string) =>
    nums
      .split(/\s*,\s*/)
      .map((n) => (sources.some((s) => s.n === Number(n)) ? `[${n}](#cite-${n})` : ""))
      .join("")
  );
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children }) {
            const m = href?.match(/^#cite-(\d+)$/);
            if (m) {
              const n = Number(m[1]);
              const s = sources.find((x) => x.n === n);
              return (
                <button
                  type="button"
                  className={`cite${s?.isSchool ? " school" : ""}`}
                  onClick={() => onCite(n)}
                  aria-expanded={active === n}
                  title={s ? `${s.title}${s.section ? ` › ${s.section}` : ""}` : undefined}
                >
                  {n}
                </button>
              );
            }
            return (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          },
        }}
      >
        {prepared}
      </ReactMarkdown>
    </div>
  );
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

// ─── Toasts ────────────────────────────────────────────────────────────────

const ToastCtx = createContext<(msg: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 3200);
    return () => clearTimeout(t);
  }, [msg]);
  return (
    <ToastCtx.Provider value={setMsg}>
      {children}
      {msg && <div className="toast" role="status">{msg}</div>}
    </ToastCtx.Provider>
  );
}

export function usePoll(fn: () => void, ms: number, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const t = setInterval(fn, ms);
    return () => clearInterval(t);
  }, [active, ms, fn]);
}
