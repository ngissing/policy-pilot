export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body || opts.form ? "POST" : "GET"),
    headers: opts.body ? { "Content-Type": "application/json" } : undefined,
    body: opts.form ?? (opts.body ? JSON.stringify(opts.body) : undefined),
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status}).`, res.status);
  return data as T;
}

export interface Source {
  n: number;
  documentId: number;
  title: string;
  section: string;
  excerpt: string;
  isSchool: boolean;
  url: string | null;
  reviewed: string | null;
}

export interface Message {
  id: number | string;
  role: "user" | "assistant";
  content: string;
  sources: Source[];
  followups: string[];
}

/** POST a question and read the Server-Sent Events stream. */
export async function streamAnswer(
  conversationId: number,
  question: string,
  on: {
    status?: (m: string) => void;
    sources?: (s: Source[]) => void;
    text?: (delta: string) => void;
    done?: (d: { messageId: number; followups: string[] }) => void;
    error?: (m: string) => void;
  },
  signal?: AbortSignal
) {
  const res = await fetch(`/api/conversations/${conversationId}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    on.error?.(data.error ?? "Couldn't reach the server.");
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = raw.match(/^event: (.+)$/m)?.[1];
      const dataLine = raw.match(/^data: (.*)$/m)?.[1];
      if (!event || dataLine === undefined) continue;
      let data: any;
      try {
        data = JSON.parse(dataLine);
      } catch {
        continue;
      }
      if (event === "status") on.status?.(data.message);
      else if (event === "sources") on.sources?.(data);
      else if (event === "text") on.text?.(data.delta);
      else if (event === "done") on.done?.(data);
      else if (event === "error") on.error?.(data.message);
    }
  }
}

export function fmtDate(s: string | null | undefined): string {
  if (!s) return "";
  const iso = s.length === 7 ? `${s}-01` : s.slice(0, 10);
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString("en-AU", s.length === 7 ? { month: "long", year: "numeric" } : { day: "numeric", month: "short", year: "numeric" });
}
