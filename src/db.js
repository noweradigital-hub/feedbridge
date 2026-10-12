import { DatabaseSync } from 'node:sqlite';
import { config, defaultProjectConfig } from './config.js';

const db = new DatabaseSync(config.dbFile);
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  source_url TEXT NOT NULL DEFAULT '',
  interval_minutes INTEGER NOT NULL DEFAULT 180,
  enabled INTEGER NOT NULL DEFAULT 1,
  config TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_run_at TEXT,
  last_status TEXT,
  last_summary TEXT
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  summary TEXT,
  log TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id, id DESC);
`);

/**
 * Beh prerušený reštartom/pádom procesu by ostal navždy "running".
 * Volá sa pri štarte; predpokladá jediný proces nad DB.
 */
export function recoverStaleRuns() {
  const stale = db.prepare("SELECT id, project_id FROM runs WHERE status = 'running'").all();
  if (!stale.length) return 0;
  const summary = JSON.stringify({ error: 'Beh bol prerušený reštartom servera' });
  for (const r of stale) {
    db.prepare(
      "UPDATE runs SET status = 'error', finished_at = datetime('now'), summary = ?, log = COALESCE(log || char(10), '') || ? WHERE id = ?"
    ).run(summary, 'CHYBA: beh bol prerušený reštartom servera', r.id);
    db.prepare("UPDATE projects SET last_status = 'error', last_summary = ? WHERE id = ?").run(summary, r.project_id);
  }
  return stale.length;
}
recoverStaleRuns();

function rowToProject(r) {
  if (!r) return null;
  return {
    ...r,
    enabled: !!r.enabled,
    config: normalizeConfig(JSON.parse(r.config)), // doplní kľúče pridané v novších verziách (safety…)
    last_summary: r.last_summary ? JSON.parse(r.last_summary) : null,
  };
}

export function normalizeConfig(cfg) {
  const base = defaultProjectConfig();
  const c = cfg || {};
  return {
    rules: Array.isArray(c.rules) ? c.rules : base.rules,
    images: {
      ...base.images,
      ...(c.images || {}),
      background: { ...base.images.background, ...((c.images || {}).background || {}) },
      backgrounds: Array.isArray((c.images || {}).backgrounds) ? c.images.backgrounds : [],
    },
    safety: { ...base.safety, ...(c.safety || {}) },
  };
}

export function validSlug(s) {
  return typeof s === 'string' && /^[a-z0-9][a-z0-9-]{1,60}$/.test(s);
}

export const projects = {
  list() {
    return db.prepare('SELECT * FROM projects ORDER BY name COLLATE NOCASE').all().map(rowToProject);
  },
  get(id) {
    return rowToProject(db.prepare('SELECT * FROM projects WHERE id = ?').get(id));
  },
  getBySlug(slug) {
    return rowToProject(db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug));
  },
  create({ name, slug, source_url = '', interval_minutes = 180, enabled = true, config: cfg }) {
    const res = db
      .prepare('INSERT INTO projects (name, slug, source_url, interval_minutes, enabled, config) VALUES (?,?,?,?,?,?)')
      .run(name, slug, source_url, interval_minutes, enabled ? 1 : 0, JSON.stringify(normalizeConfig(cfg)));
    return this.get(Number(res.lastInsertRowid));
  },
  update(id, { name, slug, source_url, interval_minutes, enabled, config: cfg }) {
    db.prepare(
      'UPDATE projects SET name=?, slug=?, source_url=?, interval_minutes=?, enabled=?, config=? WHERE id=?'
    ).run(name, slug, source_url, interval_minutes, enabled ? 1 : 0, JSON.stringify(normalizeConfig(cfg)), id);
    return this.get(id);
  },
  remove(id) {
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  },
  setRunResult(id, status, summary) {
    db.prepare("UPDATE projects SET last_run_at = datetime('now'), last_status = ?, last_summary = ? WHERE id = ?").run(
      status,
      JSON.stringify(summary),
      id
    );
  },
};

export const runs = {
  start(projectId) {
    const res = db
      .prepare("INSERT INTO runs (project_id, started_at, status) VALUES (?, datetime('now'), 'running')")
      .run(projectId);
    return Number(res.lastInsertRowid);
  },
  finish(id, status, summary, log) {
    db.prepare("UPDATE runs SET finished_at = datetime('now'), status = ?, summary = ?, log = ? WHERE id = ?").run(
      status,
      JSON.stringify(summary),
      log,
      id
    );
    // drž len posledných 100 behov na projekt
    const r = db.prepare('SELECT project_id FROM runs WHERE id = ?').get(id);
    if (r) {
      db.prepare(
        'DELETE FROM runs WHERE project_id = ? AND id NOT IN (SELECT id FROM runs WHERE project_id = ? ORDER BY id DESC LIMIT 100)'
      ).run(r.project_id, r.project_id);
    }
  },
  list(projectId, limit = 30) {
    return db
      .prepare('SELECT id, started_at, finished_at, status, summary FROM runs WHERE project_id = ? ORDER BY id DESC LIMIT ?')
      .all(projectId, limit)
      .map((r) => ({ ...r, summary: r.summary ? JSON.parse(r.summary) : null }));
  },
  get(id) {
    const r = db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
    return r ? { ...r, summary: r.summary ? JSON.parse(r.summary) : null } : null;
  },
};

export default db;
