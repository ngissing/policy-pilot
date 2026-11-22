import fs from "node:fs";
import path from "node:path";
import { db, DATA_DIR } from "./db.ts";

const BACKUP_DIR = path.join(DATA_DIR, "backups");
const KEEP = 7;

/** A consistent copy of the whole database, written while the app keeps running. */
export function snapshot(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.rmSync(file, { force: true });
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
}

/**
 * Daily copy kept next to the database (last 7 days). It protects against mistakes and corruption,
 * not against losing the volume itself — for that, download a copy from Settings now and then.
 */
export function scheduleDailyBackups() {
  const runOnce = () => {
    try {
      const file = path.join(BACKUP_DIR, `policypilot-${new Date().toISOString().slice(0, 10)}.db`);
      if (!fs.existsSync(file)) snapshot(file);
      const old = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".db")).sort().slice(0, -KEEP);
      for (const f of old) fs.rmSync(path.join(BACKUP_DIR, f), { force: true });
    } catch (err) {
      console.error("Daily backup failed:", err);
    }
  };
  setTimeout(runOnce, 5 * 60_000).unref();
  setInterval(runOnce, 6 * 3_600_000).unref();
}
