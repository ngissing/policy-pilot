import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export const DATA_DIR = path.resolve(process.env.POLICYPILOT_DATA_DIR ?? "data");
export const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, "policypilot.db"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

db.exec(`
CREATE TABLE IF NOT EXISTS schools (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  school_type TEXT,
  suburb TEXT,
  region TEXT,
  website TEXT,
  about TEXT,
  join_code TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin','staff')),
  is_owner INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- school_id NULL = Department (PAL) document, shared by every school.
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  school_id INTEGER REFERENCES schools(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('pal','upload','web')),
  title TEXT NOT NULL,
  filename TEXT,
  url TEXT,
  mime TEXT,
  file_path TEXT,
  category TEXT,
  doc_type TEXT,
  audience TEXT,
  summary TEXT,
  overview TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','ready','error')),
  error TEXT,
  needs_ai INTEGER NOT NULL DEFAULT 0,
  reviewed_date TEXT,
  next_review TEXT,
  pal_slug TEXT UNIQUE,
  meta TEXT,
  content_hash TEXT,
  body TEXT,
  word_count INTEGER,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS documents_school ON documents(school_id, status);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  school_id INTEGER,
  idx INTEGER NOT NULL,
  section TEXT,
  text TEXT NOT NULL,
  embedding BLOB
);
CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(document_id);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  title, section, text,
  content='', contentless_delete=1, tokenize='porter unicode61'
);

-- Which PAL topics a school document relates to (used for change alerts).
CREATE TABLE IF NOT EXISTS doc_links (
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  pal_slug TEXT NOT NULL,
  score REAL NOT NULL,
  PRIMARY KEY (document_id, pal_slug)
);

CREATE TABLE IF NOT EXISTS pal_topics (
  slug TEXT PRIMARY KEY,
  title TEXT,
  sitemap_lastmod TEXT,
  document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  content_hash TEXT,
  last_crawled TEXT,
  retired_at TEXT,
  first_seen TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pal_changes (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('new','updated','retired')),
  description TEXT,
  changed_on TEXT,
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (slug, kind, changed_on)
);

CREATE TABLE IF NOT EXISTS change_acks (
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  change_id INTEGER NOT NULL REFERENCES pal_changes(id) ON DELETE CASCADE,
  PRIMARY KEY (school_id, change_id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  school_id INTEGER,
  status TEXT NOT NULL DEFAULT 'running',
  done INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  result TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'all',
  document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  sources TEXT,
  followups TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Candidate documents found on a school's website, waiting to be imported.
CREATE TABLE IF NOT EXISTS discoveries (
  id INTEGER PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  found_on TEXT,
  score REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','imported','dismissed')),
  document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (school_id, url)
);

-- A school's own decisions on the policy checklist.
CREATE TABLE IF NOT EXISTS checklist_marks (
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('linked','not_applicable')),
  PRIMARY KEY (school_id, item_key)
);
`);

export type Row = Record<string, any>;

export function one<T = Row>(sql: string, ...params: any[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
export function all<T = Row>(sql: string, ...params: any[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}
export function run(sql: string, ...params: any[]) {
  return db.prepare(sql).run(...params);
}
export function tx<T>(fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function getSetting(key: string): string | null {
  return one<{ value: string }>("SELECT value FROM settings WHERE key = ?", key)?.value ?? null;
}
export function setSetting(key: string, value: string | null) {
  if (value === null) run("DELETE FROM settings WHERE key = ?", key);
  else run("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
}

// Columns added after the first release.
function addColumn(table: string, column: string, definition: string) {
  if (!all<{ name: string }>(`PRAGMA table_info(${table})`).some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
addColumn("users", "answer_length", "TEXT NOT NULL DEFAULT 'normal'");
// PAL attachments (guides, fact sheets) are documents that belong to a PAL topic.
addColumn("documents", "parent_id", "INTEGER REFERENCES documents(id) ON DELETE CASCADE");
db.exec("CREATE INDEX IF NOT EXISTS documents_parent ON documents(parent_id)");

// Jobs left "running" by a previous process are dead.
run("UPDATE jobs SET status = 'failed', message = 'Interrupted by a restart', finished_at = datetime('now') WHERE status = 'running'");
run("UPDATE documents SET status = 'queued' WHERE status = 'processing'");
