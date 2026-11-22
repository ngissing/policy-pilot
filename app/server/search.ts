import { all } from "./db.ts";
import { embed, vectorSearch } from "./embed.ts";

export type Scope = "all" | "department" | "school";

export interface Passage {
  chunkId: number;
  documentId: number;
  title: string;
  section: string;
  text: string;
  source: "pal" | "upload" | "web";
  isSchool: boolean;
  url: string | null;
  reviewed: string | null;
  score: number;
}

const STOP = new Set(
  "a an and are as at be but by can do does for from has have how i if in is it its of on or our should that the their them there these they this to was we what when where which who why will with you your about into than then also any all must may".split(" ")
);

function ftsQuery(q: string): string | null {
  const terms = [...new Set(q.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])].filter((t) => !STOP.has(t)).slice(0, 16);
  return terms.length ? terms.map((t) => `"${t}"`).join(" OR ") : null;
}

export async function retrieve(
  query: string,
  opts: { schoolId: number; scope: Scope; documentId?: number | null; k?: number; minK?: number }
): Promise<Passage[]> {
  const k = opts.k ?? 8;
  const { schoolId, scope, documentId } = opts;

  const where: string[] = ["d.status = 'ready'"];
  const params: any[] = [];
  if (documentId) {
    where.push("d.id = ?", "(d.school_id IS NULL OR d.school_id = ?)");
    params.push(documentId, schoolId);
  } else if (scope === "department") {
    where.push("d.school_id IS NULL");
  } else if (scope === "school") {
    where.push("d.school_id = ?");
    params.push(schoolId);
  } else {
    where.push("(d.school_id IS NULL OR d.school_id = ?)");
    params.push(schoolId);
  }
  const allowed = (e: { docId: number; schoolId: number | null }) => {
    if (documentId) return e.docId === documentId && (e.schoolId === null || e.schoolId === schoolId);
    if (scope === "department") return e.schoolId === null;
    if (scope === "school") return e.schoolId === schoolId;
    return e.schoolId === null || e.schoolId === schoolId;
  };

  // Keyword ranking (BM25; title matches count most).
  const match = ftsQuery(query);
  const keyword = match
    ? all<{ id: number }>(
        `SELECT c.id FROM chunks_fts f JOIN chunks c ON c.id = f.rowid JOIN documents d ON d.id = c.document_id
         WHERE chunks_fts MATCH ? AND ${where.join(" AND ")}
         ORDER BY bm25(chunks_fts, 4.0, 2.0, 1.0) LIMIT 60`,
        match,
        ...params
      )
    : [];

  // Meaning-based ranking.
  const [qv] = await embed([query]);
  const semantic = vectorSearch(qv, allowed, 60);

  // Reciprocal rank fusion.
  const fused = new Map<number, number>();
  keyword.forEach((r, i) => fused.set(r.id, (fused.get(r.id) ?? 0) + 1 / (60 + i)));
  semantic.forEach((r, i) => fused.set(r.id, (fused.get(r.id) ?? 0) + 1 / (60 + i)));
  // Drop passages that are neither a strong keyword hit nor close in meaning.
  const semScore = new Map(semantic.map((r) => [r.id, r.score]));
  const kwRank = new Map(keyword.map((r, i) => [r.id, i]));
  const relevant = (id: number) => (semScore.get(id) ?? 0) >= 0.3 || (kwRank.get(id) ?? 99) < 12;
  const ranked = [...fused.entries()].filter(([id]) => relevant(id)).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return [];

  const ids = ranked.slice(0, 80).map(([id]) => id);
  const rows = all<any>(
    `SELECT c.id, c.document_id, c.idx, c.section, c.text, d.title, d.source, d.school_id, d.url, d.reviewed_date,
            d.parent_id, p.title AS parent_title
     FROM chunks c JOIN documents d ON d.id = c.document_id LEFT JOIN documents p ON p.id = d.parent_id
     WHERE c.id IN (${ids.map(() => "?").join(",")})`,
    ...ids
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  // Attached guides support the policy text rather than replace it, so they rank a little lower.
  ranked.splice(0, ranked.length, ...ranked
    .filter(([id]) => byId.has(id))
    .map(([id, s]) => [id, byId.get(id).parent_id ? s * 0.8 : s] as [number, number])
    .sort((a, b) => b[1] - a[1]));

  // Pick the best passages, at most 3 per document, and keep room for the school's own documents.
  const picked: any[] = [];
  const perDoc = new Map<number, number>();
  const take = (r: any, score: number) => {
    if ((perDoc.get(r.document_id) ?? 0) >= 3) return false;
    perDoc.set(r.document_id, (perDoc.get(r.document_id) ?? 0) + 1);
    picked.push({ ...r, score });
    return true;
  };
  for (const [id, score] of ranked) {
    const r = byId.get(id);
    if (r && picked.length < k) take(r, score);
  }
  if (scope === "all" && !documentId && !picked.some((p) => p.school_id !== null)) {
    const schoolHits = ranked.filter(([id]) => byId.get(id)?.school_id !== null && byId.get(id)).slice(0, 2);
    for (const [id, score] of schoolHits) {
      picked.splice(Math.max(0, picked.length - 1), 1);
      take(byId.get(id), score);
    }
  }

  // Drop weak tail results: past the first few, keep only passages that score close to the best match.
  // (A passage ranked first by only one of the two searches scores about half of a passage both rank first.)
  const top = picked[0]?.score ?? 0;
  const kept = picked.filter((p, i) => i < (opts.minK ?? 3) || p.school_id !== null || p.score >= top * 0.45);

  // Widen each passage with its neighbours so the model sees whole thoughts, and merge windows
  // from the same document that touch or overlap so no text is sent twice.
  interface Window { docId: number; lo: number; hi: number; best: any; sections: string[] }
  const windows: Window[] = [];
  for (const p of kept) {
    const lo = p.idx - 1;
    const hi = p.idx + 1;
    const w = windows.find((x) => x.docId === p.document_id && lo <= x.hi + 1 && hi >= x.lo - 1);
    if (w) {
      w.lo = Math.min(w.lo, lo);
      w.hi = Math.max(w.hi, hi);
      if (p.section && !w.sections.includes(p.section)) w.sections.push(p.section);
    } else {
      windows.push({ docId: p.document_id, lo, hi, best: p, sections: p.section ? [p.section] : [] });
    }
  }
  // Growing a window can make it reach another one from the same document.
  for (let i = windows.length - 1; i > 0; i--) {
    const w = windows[i];
    const into = windows.slice(0, i).find((x) => x.docId === w.docId && w.lo <= x.hi + 1 && w.hi >= x.lo - 1);
    if (into) {
      into.lo = Math.min(into.lo, w.lo);
      into.hi = Math.max(into.hi, w.hi);
      for (const s of w.sections) if (!into.sections.includes(s)) into.sections.push(s);
      windows.splice(i, 1);
    }
  }

  return windows.map((w) => {
    const p = w.best;
    const around = all<{ text: string }>(
      "SELECT text FROM chunks WHERE document_id = ? AND idx BETWEEN ? AND ? ORDER BY idx",
      w.docId, w.lo, w.hi
    );
    const sections = w.sections.join("; ");
    return {
      chunkId: p.id,
      documentId: p.document_id,
      // An attached guide is cited under its PAL topic: "Excursions › Excursion planning guide › Page 3".
      title: p.parent_title ?? p.title,
      section: p.parent_title ? [p.title, sections].filter(Boolean).join(" › ") : sections,
      text: around.length ? mergeOverlapping(around.map((a) => a.text)) : p.text,
      source: p.source,
      isSchool: p.school_id !== null,
      url: p.url,
      reviewed: p.reviewed_date,
      score: p.score,
    };
  });
}

/** Neighbouring chunks share a short overlap; drop the repeated words when joining. */
function mergeOverlapping(texts: string[]): string {
  let out = texts[0] ?? "";
  for (const next of texts.slice(1)) {
    const tail = out.slice(-300);
    let cut = 0;
    for (let n = Math.min(tail.length, next.length); n > 30; n--) {
      if (tail.endsWith(next.slice(0, n))) { cut = n; break; }
    }
    out += "\n\n" + next.slice(cut);
  }
  return out;
}
