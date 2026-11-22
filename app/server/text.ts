import * as cheerio from "cheerio";
import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";

/**
 * Documents are normalised to a light markdown: "#", "##", "###" headings,
 * paragraphs separated by blank lines, "- " list items, and "| a | b |" table rows.
 * PDFs carry "<!-- page N -->" markers so answers can cite page numbers.
 */

export const SUPPORTED = [".pdf", ".docx", ".txt", ".md", ".html", ".htm"];

export function kindFromName(name: string, mime?: string): string | null {
  const lower = name.toLowerCase();
  const ext = SUPPORTED.find((e) => lower.endsWith(e));
  if (ext) return ext === ".htm" ? ".html" : ext;
  if (mime?.includes("pdf")) return ".pdf";
  if (mime?.includes("wordprocessingml")) return ".docx";
  if (mime?.includes("html")) return ".html";
  if (mime?.startsWith("text/")) return ".txt";
  return null;
}

export async function extract(buf: Buffer, kind: string): Promise<string> {
  switch (kind) {
    case ".pdf": {
      // verbosity 0: only real errors, not the font warnings many school PDFs trigger.
      const pdf = await getDocumentProxy(new Uint8Array(buf), { verbosity: 0 });
      const { text } = await extractText(pdf, { mergePages: false });
      return (text as string[])
        .map((t, i) => `<!-- page ${i + 1} -->\n${tidyPdfPage(t)}`)
        .join("\n\n");
    }
    case ".docx": {
      const { value } = await mammoth.convertToHtml({ buffer: buf });
      return htmlToMarkdown(value);
    }
    case ".html":
      return htmlToMarkdown(buf.toString("utf8"), { mainOnly: true });
    default:
      return buf.toString("utf8").replace(/\r\n/g, "\n");
  }
}

function tidyPdfPage(t: string): string {
  return t
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/-\n(?=[a-z])/g, "")
    // Join wrapped lines; keep breaks after sentence ends and before bullets.
    .replace(/([^\n.:;!?])\n(?![\n•\-–\d])/g, "$1 ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const STRIP =
  "script, style, noscript, svg, nav, header, footer, aside, form, iframe, button, [role=navigation], [role=banner], [role=contentinfo], .breadcrumb, .cookie, .skip-link, .rpl-u-visually-hidden, .visually-hidden, .sr-only, .screen-reader-text";

export function htmlToMarkdown(html: string, opts: { mainOnly?: boolean; root?: string } = {}): string {
  const $ = cheerio.load(html);
  $(STRIP).remove();
  let root = opts.root ? $(opts.root) : $("body").length ? $("body") : $.root();
  if (opts.mainOnly) {
    const main = $("main, article, [role=main], #content, .content").first();
    if (main.length && main.text().trim().length > 200) root = main;
  }
  const out: string[] = [];
  const text = (el: any) => $(el).text().replace(/\s+/g, " ").trim();

  const walk = (el: any) => {
    $(el)
      .children()
      .each((_, child) => {
        const tag = (child as any).tagName?.toLowerCase();
        if (!tag) return;
        if (/^h[1-6]$/.test(tag)) {
          const t = text(child);
          if (t) out.push(`${"#".repeat(Math.min(3, Number(tag[1])))} ${t}`);
        } else if (tag === "p" || tag === "blockquote" || tag === "dd" || tag === "dt") {
          const t = text(child);
          if (t) out.push(t);
        } else if (tag === "ul" || tag === "ol") {
          $(child)
            .children("li")
            .each((i, li) => {
              const nested = $(li).children("ul, ol");
              const own = $(li).clone().children("ul, ol").remove().end();
              const t = own.text().replace(/\s+/g, " ").trim();
              if (t) out.push(`${tag === "ol" ? `${i + 1}.` : "-"} ${t}`);
              nested.find("li").each((_, sub) => {
                const s = text(sub);
                if (s) out.push(`  - ${s}`);
              });
            });
        } else if (tag === "table") {
          $(child)
            .find("tr")
            .each((_, tr) => {
              const cells = $(tr)
                .children("th, td")
                .map((_, c) => text(c))
                .get()
                .filter(Boolean);
              if (cells.length) out.push(`| ${cells.join(" | ")} |`);
            });
        } else if (tag === "br" || tag === "hr" || tag === "img") {
          // skip
        } else if ($(child).children().length === 0) {
          const t = text(child);
          if (t.length > 1) out.push(t);
        } else {
          walk(child);
        }
      });
  };
  walk(root);

  // Paragraphs separated by blank lines; consecutive list items/table rows stay together.
  const lines: string[] = [];
  for (const line of out) {
    const prev = lines[lines.length - 1];
    const tight = prev !== undefined && /^(\s*-|\d+\.|\|)/.test(line) && /^(\s*-|\d+\.|\|)/.test(prev);
    if (lines.length && !tight) lines.push("");
    lines.push(line);
  }
  return lines.join("\n").trim();
}

// ─── Chunking ────────────────────────────────────────────────────────────────

export interface Chunk { section: string; text: string }

const TARGET_WORDS = 220;
const OVERLAP_WORDS = 40;

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** Split normalised markdown into retrieval chunks that carry their heading path. */
export function chunkMarkdown(md: string, opts: { baseSection?: string } = {}): Chunk[] {
  const chunks: Chunk[] = [];
  const path: string[] = [];
  let page: number | null = null;
  let buf: string[] = [];
  let bufWords = 0;

  const section = () => {
    const parts = [opts.baseSection, ...path].filter(Boolean) as string[];
    const label = parts.join(" › ");
    return page !== null ? (label ? `${label} (page ${page})` : `Page ${page}`) : label;
  };
  const flush = () => {
    const text = buf.join("\n\n").trim();
    if (text && words(text) >= 8) chunks.push({ section: section(), text });
    // Carry a short tail forward so ideas that straddle a boundary are still found.
    const tail = text.split(/\s+/).slice(-OVERLAP_WORDS).join(" ");
    buf = tail && words(text) > TARGET_WORDS ? [tail] : [];
    bufWords = buf.length ? OVERLAP_WORDS : 0;
  };

  for (const block of md.split(/\n{2,}/)) {
    const b = block.trim();
    if (!b) continue;
    const pageMark = b.match(/^<!-- page (\d+) -->\s*([\s\S]*)$/);
    if (pageMark) {
      if (bufWords) flush();
      buf = [];
      bufWords = 0;
      page = Number(pageMark[1]);
      if (pageMark[2].trim()) {
        buf.push(pageMark[2].trim());
        bufWords = words(pageMark[2]);
      }
      continue;
    }
    const heading = b.match(/^(#{1,3}) (.+)$/);
    if (heading && !b.includes("\n")) {
      if (bufWords) flush();
      buf = [];
      bufWords = 0;
      const level = heading[1].length;
      path.length = level - 1;
      path[level - 1] = heading[2].trim();
      continue;
    }
    const w = words(b);
    if (w > TARGET_WORDS * 1.5) {
      // Very long paragraph: split on sentences.
      for (const sentence of b.split(/(?<=[.!?])\s+/)) {
        buf.push(sentence);
        bufWords += words(sentence);
        if (bufWords >= TARGET_WORDS) flush();
      }
      continue;
    }
    if (bufWords + w > TARGET_WORDS && bufWords > 0) flush();
    buf.push(b);
    bufWords += w;
  }
  if (bufWords) flush();
  return chunks;
}

export function firstHeading(md: string): string | null {
  const m = md.match(/^#{1,2} (.{4,120})$/m);
  return m ? m[1].trim() : null;
}

const SMALL_WORDS = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "with"]);

export function titleFromFilename(name: string): string {
  return name
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[A-Za-z]+/g, (w, i: number) => (i > 0 && SMALL_WORDS.has(w.toLowerCase()) ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1)));
}

export function wordCount(s: string) {
  return words(s);
}
