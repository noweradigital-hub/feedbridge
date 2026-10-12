import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { projects, runs, validSlug } from './db.js';
import { triggerRun, isRunning, startScheduler } from './runner.js';
import { previewProject } from './feed/pipeline.js';
import { parseFeed } from './feed/parse.js';
import { fetchSource } from './feed/pipeline.js';
import { renderPreview, validAssetName } from './images.js';
import sharp from 'sharp';
import { applyRules, fieldValue } from './feed/rules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });
app.use(express.json({ limit: '2mb' }));

// ---------------------------------------------------------------- verejné časti (Meta si sťahuje feed a obrázky)
app.get('/feeds/:file', (req, res) => {
  const m = /^([a-z0-9-]+)\.xml$/.exec(req.params.file);
  if (!m) return res.status(404).end();
  const file = path.join(config.feedsDir, `${m[1]}.xml`);
  if (!fs.existsSync(file)) return res.status(404).send('Feed ešte nebol vygenerovaný');
  res.set('Content-Type', 'application/xml; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=300');
  fs.createReadStream(file).pipe(res);
});
app.use('/img', express.static(config.imagesDir, { maxAge: '7d', immutable: true, index: false, dotfiles: 'ignore' }));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------- admin (Basic auth)
function safeEq(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Basic ')) {
    const [u, ...rest] = Buffer.from(h.slice(6), 'base64').toString().split(':');
    if (safeEq(u, config.adminUser) && safeEq(rest.join(':'), config.adminPassword)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="FeedBridge"');
  res.status(401).send('Prihlásenie je povinné');
}
app.use(['/api', '/admin'], auth);
app.use('/admin', express.static(path.join(__dirname, '..', 'public')));
app.get('/', (_req, res) => res.redirect('/admin/'));

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const wrap = (fn) => (req, res) =>
  Promise.resolve()
    .then(() => fn(req, res))
    .catch((e) => res.status(e.status || 500).json({ error: e.message }));

function publicProject(p) {
  return {
    ...p,
    feed_url: `${config.publicUrl}/feeds/${p.slug}.xml`,
    running: isRunning(p.id),
    has_feed: fs.existsSync(path.join(config.feedsDir, `${p.slug}.xml`)),
  };
}

function readBody(body, existing) {
  const existingId = existing?.id;
  const name = String(body.name || '').trim();
  const slug = String(body.slug || '').trim().toLowerCase();
  if (!name) throw new HttpError(400, 'Názov je povinný');
  if (!validSlug(slug)) throw new HttpError(400, 'Slug: 2-60 znakov, len a-z, 0-9 a pomlčka');
  const other = projects.getBySlug(slug);
  if (other && other.id !== existingId) throw new HttpError(409, 'Slug už používa iný projekt');
  // URL feedu je nastavená v Mete; zmena slugu by ju potichu odpojila
  if (existing && slug !== existing.slug) {
    throw new HttpError(409, 'Slug sa po vytvorení nedá zmeniť, je na ňom URL feedu v Mete. Pre novú URL použi Duplikovať.');
  }
  const interval = Math.max(15, Math.min(1440, parseInt(body.interval_minutes, 10) || 180));
  return {
    name, slug,
    source_url: String(body.source_url || '').trim(),
    interval_minutes: interval,
    enabled: body.enabled !== false,
    config: body.config,
  };
}

app.get('/api/projects', (_req, res) => res.json(projects.list().map(publicProject)));

app.post('/api/projects', wrap((req, res) => {
  const data = readBody(req.body);
  res.status(201).json(publicProject(projects.create(data)));
}));

app.get('/api/projects/:id', wrap((req, res) => {
  const p = projects.get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Projekt neexistuje' });
  res.json(publicProject(p));
}));

app.put('/api/projects/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  const old = projects.get(id);
  if (!old) return res.status(404).json({ error: 'Projekt neexistuje' });
  const data = readBody(req.body, old);
  res.json(publicProject(projects.update(id, data)));
}));

app.post('/api/projects/:id/duplicate', wrap((req, res) => {
  const p = projects.get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Projekt neexistuje' });
  let slug = `${p.slug}-kopia`;
  for (let i = 2; projects.getBySlug(slug); i++) slug = `${p.slug}-kopia-${i}`;
  const copy = projects.create({
    name: `${p.name} (kópia)`, slug, source_url: '', interval_minutes: p.interval_minutes,
    enabled: false, config: p.config,
  });
  res.status(201).json(publicProject(copy));
}));

app.delete('/api/projects/:id', wrap((req, res) => {
  const p = projects.get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Projekt neexistuje' });
  projects.remove(p.id);
  fs.rmSync(path.join(config.feedsDir, `${p.slug}.xml`), { force: true });
  fs.rmSync(path.join(config.imagesDir, p.slug), { recursive: true, force: true });
  res.json({ ok: true });
}));

app.post('/api/projects/:id/run', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!projects.get(id)) return res.status(404).json({ error: 'Projekt neexistuje' });
  if (isRunning(id)) return res.status(409).json({ error: 'Projekt sa práve spracúva' });
  // force = používateľ potvrdil zápis napriek poistke poklesu; beh v pozadí, UI si stav ťahá cez /runs
  triggerRun(id, { force: req.body?.force === true }).catch((e) => console.error(e));
  res.status(202).json({ started: true });
}));

app.get('/api/projects/:id/runs', (req, res) => res.json(runs.list(Number(req.params.id))));
app.get('/api/runs/:id', (req, res) => {
  const r = runs.get(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Beh neexistuje' });
  res.json(r);
});

// Náhľad pravidiel: používa konfiguráciu z UI (aj neuloženú), ak je v tele
app.post('/api/projects/:id/preview', wrap(async (req, res) => {
  const p = projects.get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Projekt neexistuje' });
  const draft = { ...p };
  if (req.body?.config) draft.config = { ...p.config, ...req.body.config };
  if (req.body?.source_url) draft.source_url = req.body.source_url;
  res.json(await previewProject(draft, { limit: Number(req.body?.limit) || 60 }));
}));

// Náhľad obrázka: ?index=N -> vyrenderuje N-tú položku zdrojového feedu s aktuálnym nastavením obrázkov
app.post('/api/projects/:id/preview-image', wrap(async (req, res) => {
  const p = projects.get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Projekt neexistuje' });
  const images = { ...p.config.images, ...(req.body?.images || {}) };
  const sourceUrl = req.body?.source_url || p.source_url;
  const { items } = parseFeed(await fetchSource(sourceUrl));
  const rules = req.body?.rules || p.config.rules;
  const idx = Math.min(items.length - 1, Math.max(0, parseInt(req.body?.index, 10) || 0));
  const { item } = applyRules(items[idx], rules);
  const url = fieldValue(item, 'image_link');
  if (!url) return res.status(422).json({ error: 'Položka nemá image_link' });
  const jpg = await renderPreview(url, item, images);
  res.set('Content-Type', 'image/jpeg');
  res.set('X-Item-Title', encodeURIComponent(fieldValue(item, 'title')));
  res.send(jpg);
}));

// Zverejnený výstup projektu (to, čo práve vidí Meta) pre galériu v UI
app.get('/api/projects/:id/output', wrap((req, res) => {
  const p = projects.get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Projekt neexistuje' });
  const file = path.join(config.feedsDir, `${p.slug}.xml`);
  if (!fs.existsSync(file)) return res.json({ generated_at: null, items: [] });
  const { items } = parseFeed(fs.readFileSync(file, 'utf8'));
  res.json({
    generated_at: fs.statSync(file).mtime.toISOString(),
    items: items.map((it) => ({
      id: fieldValue(it, 'id'), title: fieldValue(it, 'title'), price: fieldValue(it, 'price'),
      sale_price: fieldValue(it, 'sale_price'), availability: fieldValue(it, 'availability'),
      image_link: fieldValue(it, 'image_link'),
      original_image: Array.isArray(it.additional_image_link) ? it.additional_image_link[0] || '' : '',
      labels: Object.fromEntries(Object.entries(it).filter(([k]) => k.startsWith('custom_label')).map(([k]) => [k, fieldValue(it, k)])),
    })),
  });
}));

// ---------------------------------------------------------------- knižnica pozadí a grafiky
const listAssets = () => fs.readdirSync(config.assetsDir).filter(validAssetName).sort().map((name) => ({
  name, size: fs.statSync(path.join(config.assetsDir, name)).size, url: `/api/assets/${name}`,
}));
const assetPath = (name) => {
  if (!validAssetName(name)) throw new HttpError(400, 'Názov: malé písmená, číslice, pomlčky, prípona jpg/png/webp');
  return path.join(config.assetsDir, name);
};

app.get('/api/assets', wrap((_req, res) => res.json(listAssets())));

app.get('/api/assets/:name', wrap((req, res) => {
  const file = assetPath(req.params.name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Súbor neexistuje' });
  res.set('Cache-Control', 'private, max-age=60');
  res.sendFile(file);
}));

app.put('/api/assets/:name', express.raw({ type: () => true, limit: '20mb' }), wrap(async (req, res) => {
  const file = assetPath(req.params.name);
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Prázdny súbor');
  let meta;
  try { meta = await sharp(req.body).metadata(); } catch { throw new HttpError(400, 'Súbor nie je obrázok'); }
  if (!['jpeg', 'png', 'webp'].includes(meta.format)) throw new HttpError(400, 'Podporované sú JPEG, PNG a WebP');
  fs.writeFileSync(file + '.tmp', req.body);
  fs.renameSync(file + '.tmp', file);
  res.status(201).json({ name: req.params.name, width: meta.width, height: meta.height });
}));

app.delete('/api/assets/:name', wrap((req, res) => {
  fs.rmSync(assetPath(req.params.name), { force: true });
  res.json({ ok: true });
}));

app.use((err, _req, res, _next) => res.status(400).json({ error: err.message }));

export function start() {
  return app.listen(config.port, () => {
    console.log(`FeedBridge beží na ${config.publicUrl}  (admin: ${config.publicUrl}/admin/)`);
    if (config.passwordGenerated) {
      console.log(`Heslo nebolo nastavené (ADMIN_PASSWORD). Dočasné heslo pre "${config.adminUser}": ${config.adminPassword}`);
    }
    startScheduler();
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) start();

export default app;
