// One-off: fetch PAL's public guides without starting the full server (no AI key loaded, so no AI cost).
import { run, all } from "../server/db.ts";
import { loadIndex } from "../server/embed.ts";
import { syncAttachments } from "../server/pal.ts";
loadIndex();
const jobId = Number(run("INSERT INTO jobs(kind, message) VALUES ('pal_sync', 'Adding PAL guides…')").lastInsertRowid);
const r = await syncAttachments(jobId);
run("UPDATE jobs SET status = 'done', finished_at = datetime('now'), result = ?, message = ? WHERE id = ?",
  JSON.stringify(r), `Guides: ${r.added} added, ${r.skipped} forms and templates skipped.`, jobId);
console.log(JSON.stringify(r));
const topics = all<any>("SELECT meta FROM documents WHERE source='pal' AND parent_id IS NULL AND status='ready'");
let pub = 0, withAny = 0;
for (const t of topics) { const a = JSON.parse(t.meta).attachments ?? []; pub += a.length; if (a.length) withAny++; }
console.log(`public file links: ${pub} across ${withAny} topics`);
console.log(all<any>("SELECT d.title, p.title AS topic, d.word_count FROM documents d JOIN documents p ON p.id = d.parent_id ORDER BY d.word_count DESC").map((x) => `${x.word_count}\t${x.title}  [${x.topic}]`).join("\n"));
process.exit(0);
