import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { config, defaultProjectConfig } from './config.js';
import { normalizeBrand, normalizeElements, PRESETS } from './badge.js';
import { normalizeCampaigns, normalizeOverrides } from './campaigns.js';

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
CREATE TABLE IF NOT EXISTS config_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  config TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_versions_project ON config_versions(project_id, id DESC);
`);
// Počítadlo uložení: klient posiela číslo, s ktorým projekt načítal, a server odmietne
// uloženie nad starším stavom (dve otvorené okná by si inak potichu prepísali zmeny).
if (!db.prepare('PRAGMA table_info(projects)').all().some((c) => c.name === 'rev')) {
  db.exec('ALTER TABLE projects ADD COLUMN rev INTEGER NOT NULL DEFAULT 0');
}

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
    config: normalizeConfig(JSON.parse(r.config), r.slug), // doplní kľúče pridané v novších verziách (safety, profiles…)
    last_summary: r.last_summary ? JSON.parse(r.last_summary) : null,
  };
}

/**
 * Exportné profily: každý je jeden výstupný feed s vlastnou URL (/feeds/<slug>.xml).
 * Projekt bez profilov (staršie verzie) dostane predvolený so slugom projektu, takže
 * pôvodná URL feedu ostáva v platnosti.
 */
export function normalizeProfiles(list, projectSlug) {
  const out = (Array.isArray(list) ? list : []).filter((p) => p && validSlug(p.slug)).map((p) => ({
    id: typeof p.id === 'string' && /^[a-z0-9]{1,16}$/.test(p.id) ? p.id : crypto.randomBytes(4).toString('hex'),
    slug: p.slug,
    name: String(p.name || p.slug).trim().slice(0, 80) || p.slug,
    channel: p.channel === 'google' ? 'google' : 'meta',
    enabled: p.enabled !== false,
    imageMode: ['original', 'clean', 'percent'].includes(p.imageMode) ? p.imageMode : 'project', // Google používa vždy pôvodnú fotku, pozri imageModeOf
    rules: Array.isArray(p.rules) ? p.rules : [],
  }));
  if (!out.length && projectSlug) {
    out.push({ id: 'main', slug: projectSlug, name: 'Meta', channel: 'meta', enabled: true, imageMode: 'project', rules: [] });
  }
  return out;
}

export function normalizeConfig(cfg, projectSlug) {
  const base = defaultProjectConfig();
  const c = cfg || {};
  const campaigns = normalizeCampaigns(c.campaigns);
  const badge = { ...base.images.badge, ...((c.images || {}).badge || {}) };
  return {
    profiles: normalizeProfiles(c.profiles, projectSlug),
    brand: normalizeBrand(c.brand),
    campaigns,
    products: normalizeOverrides(c.products, campaigns),
    groups: normalizeOverrides(c.groups, campaigns),
    rules: Array.isArray(c.rules) ? c.rules : base.rules,
    images: {
      ...base.images,
      ...(c.images || {}),
      // Uložená konfigurácia z čias pred badge nemá `base` ani `badge`, zato má kľúče výmeny pozadia:
      // vtedy obrázky znamenali výmenu pozadia a tak to aj ostane. Všetko ostatné je pôvodná fotka.
      base: c.images?.base === 'photo' || c.images?.base === 'background' ? c.images.base
        : c.images && !('badge' in c.images) && ('provider' in c.images || 'background' in c.images) ? 'background' : 'photo',
      ratio: ['1:1', '4:5', '7:8'].includes(c.images?.ratio) ? c.images.ratio : '1:1',
      margin: Math.min(0.3, Math.max(0, Number(c.images?.margin) || 0)),
      trim: c.images?.trim === true,
      badge: {
        ...badge,
        preset: PRESETS.includes(badge.preset) ? badge.preset : 'card',
        elements: normalizeElements(badge.elements),
        when: Array.isArray(badge.when) ? badge.when : [],
      },
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
      .run(name, slug, source_url, interval_minutes, enabled ? 1 : 0, JSON.stringify(normalizeConfig(cfg, slug)));
    const id = Number(res.lastInsertRowid);
    versions.record(id);
    return this.get(id);
  },
  update(id, { name, slug, source_url, interval_minutes, enabled, config: cfg }) {
    versions.record(id); // projekt z čias pred históriou: odlož aj stav pred prvou úpravou
    db.prepare(
      'UPDATE projects SET name=?, slug=?, source_url=?, interval_minutes=?, enabled=?, config=?, rev=rev+1 WHERE id=?'
    ).run(name, slug, source_url, interval_minutes, enabled ? 1 : 0, JSON.stringify(normalizeConfig(cfg, slug)), id);
    versions.record(id);
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

/** História konfigurácie: po každom uložení, ktoré niečo zmenilo, sa odloží kópia (posledných 30). */
export const versions = {
  record(projectId) {
    const cur = db.prepare('SELECT config FROM projects WHERE id = ?').get(projectId);
    if (!cur) return;
    const last = db.prepare('SELECT config FROM config_versions WHERE project_id = ? ORDER BY id DESC LIMIT 1').get(projectId);
    if (last && last.config === cur.config) return;
    db.prepare('INSERT INTO config_versions (project_id, config) VALUES (?, ?)').run(projectId, cur.config);
    db.prepare(
      'DELETE FROM config_versions WHERE project_id = ? AND id NOT IN (SELECT id FROM config_versions WHERE project_id = ? ORDER BY id DESC LIMIT 30)'
    ).run(projectId, projectId);
  },
  list(projectId) {
    return db.prepare('SELECT id, created_at, config FROM config_versions WHERE project_id = ? ORDER BY id DESC').all(projectId).map((v) => {
      const c = JSON.parse(v.config);
      return { id: v.id, created_at: v.created_at, rules: (c.rules || []).length, profiles: (c.profiles || []).map((p) => p.slug) };
    });
  },
  get(projectId, id) {
    const v = db.prepare('SELECT config FROM config_versions WHERE project_id = ? AND id = ?').get(projectId, id);
    return v ? JSON.parse(v.config) : null;
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
