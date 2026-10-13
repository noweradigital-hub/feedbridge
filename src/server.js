import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { projects, runs, versions, validSlug, normalizeProfiles, normalizeConfig } from './db.js';
import { triggerRun, isRunning, startScheduler } from './runner.js';
import { previewProject } from './feed/pipeline.js';
import { parseFeed } from './feed/parse.js';
import { fetchSource } from './feed/pipeline.js';
import { renderPreview, validAssetName, originalJpeg, imagePlan } from './images.js';
import { resolveCampaign, own, MAX_OVERRIDES } from './campaigns.js';
import { generateImage } from './magnific.js';
import sharp from 'sharp';
import { applyRules, fieldValue, resolvePricing } from './feed/rules.js';

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
// Originál z cache ako JPEG: potrebuje ho externý výrez, ktorý si fotku sťahuje sám (Magnific).
// Sú to verejné produktové fotky e-shopov, adresa je odtlačok obsahu.
app.get('/src/:file', async (req, res) => {
  const m = /^([0-9a-f]{40})\.jpg$/.exec(req.params.file);
  const jpg = m ? await originalJpeg(m[1]).catch(() => null) : null;
  if (!jpg) return res.status(404).end();
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(jpg);
});
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

const feedFile = (slug) => path.join(config.feedsDir, `${slug}.xml`);

function publicProject(p) {
  // feed_url a has_feed pri profiloch sú len na čítanie, pri ukladaní ich normalizeProfiles zahodí
  const profiles = p.config.profiles.map((pr) => ({
    ...pr, feed_url: `${config.publicUrl}/feeds/${pr.slug}.xml`, has_feed: fs.existsSync(feedFile(pr.slug)),
  }));
  return {
    ...p,
    config: { ...p.config, profiles },
    feed_url: profiles[0]?.feed_url,
    running: isRunning(p.id),
    has_feed: profiles.some((pr) => pr.has_feed),
  };
}

/**
 * Každý zápis musí povedať, nad ktorou revíziou projektu vznikol. Staršia (iné okno, karta
 * otvorená pred aktualizáciou, medzitým hromadná úprava produktov) sa odmietne, inak by potichu
 * prepísala novšie nastavenie.
 */
function assertFresh(body, project) {
  if (!Number.isInteger(body?.rev) || body.rev !== project.rev) {
    throw new HttpError(409, 'Projekt medzitým niekto zmenil alebo je stránka otvorená príliš dlho. Načítaj ju znova, aby si neprepísal novšie nastavenie.');
  }
}

/** Slug feedu musí byť jedinečný naprieč všetkými projektmi a profilmi (je to názov súboru a verejná URL). */
function slugTaken(slug, exceptProjectId) {
  return projects.list().some((o) => o.id !== exceptProjectId && (o.slug === slug || o.config.profiles.some((pr) => pr.slug === slug)));
}

/**
 * Skontroluje profily z požiadavky. Existujúci profil (podľa id) si drží slug, lebo na jeho URL
 * je napojený reklamný kanál. Nový profil musí mať voľný slug.
 */
function readProfiles(input, projectSlug, existing) {
  if (input === undefined) return existing ? existing.config.profiles : undefined; // klient profily neposlal, nemeníme
  if (!Array.isArray(input) || !input.length) throw new HttpError(400, 'Projekt musí mať aspoň jeden exportný profil');
  for (const p of input) if (!p || !validSlug(String(p.slug || ''))) throw new HttpError(400, `Slug profilu „${p?.slug ?? ''}“: 2-60 znakov, len a-z, 0-9 a pomlčka`);
  const list = normalizeProfiles(input, projectSlug);
  const old = new Map((existing?.config.profiles || []).map((p) => [p.id, p]));
  const seenSlug = new Set();
  const seenId = new Set();
  for (const p of list) {
    if (seenSlug.has(p.slug)) throw new HttpError(409, `Slug profilu „${p.slug}“ je v projekte dvakrát`);
    if (seenId.has(p.id)) throw new HttpError(400, 'Dva profily majú rovnaké id');
    seenSlug.add(p.slug); seenId.add(p.id);
    const before = old.get(p.id);
    if (before) {
      if (before.slug !== p.slug) throw new HttpError(409, `Slug profilu „${before.slug}“ sa nedá zmeniť, je na ňom URL feedu. Pridaj nový profil.`);
    } else if ([...old.values()].some((o) => o.slug === p.slug) || slugTaken(p.slug, existing?.id)) {
      throw new HttpError(409, `Slug „${p.slug}“ už používa iný feed`);
    }
  }
  return list;
}

function readBody(body, existing) {
  const existingId = existing?.id;
  const name = String(body.name || '').trim();
  const slug = String(body.slug || '').trim().toLowerCase();
  if (!name) throw new HttpError(400, 'Názov je povinný');
  if (!validSlug(slug)) throw new HttpError(400, 'Slug: 2-60 znakov, len a-z, 0-9 a pomlčka');
  if (slugTaken(slug, existingId)) throw new HttpError(409, 'Slug už používa iný projekt alebo profil');
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
    config: { ...(body.config || {}), profiles: readProfiles(body.config?.profiles, slug, existing) },
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
  assertFresh(req.body, old);
  const data = readBody(req.body, old);
  // Bežiaci beh pracuje so starým zoznamom profilov: keby sme mu profil medzitým zmazali,
  // zapísal by feed späť a jeho uvoľnený slug by už mohol patriť inému projektu.
  const keptSlugs = new Set(data.config.profiles.map((p) => p.slug));
  if (isRunning(id) && old.config.profiles.some((p) => !keptSlugs.has(p.slug))) {
    throw new HttpError(409, 'Projekt sa práve spracúva. Profil sa dá zmazať až po dokončení behu.');
  }
  const updated = projects.update(id, data);
  // odstránený profil: jeho feed zmizne, aby kanál nedostával potichu zastarané dáta
  const kept = new Set(updated.config.profiles.map((p) => p.slug));
  for (const p of old.config.profiles) if (!kept.has(p.slug)) fs.rmSync(feedFile(p.slug), { force: true });
  res.json(publicProject(updated));
}));

app.post('/api/projects/:id/duplicate', wrap((req, res) => {
  const p = projects.get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Projekt neexistuje' });
  // slug má najviac 60 znakov: dlhý základ sa skráti, aby sa prípona zmestila
  const fit = (base, suffix) => base.slice(0, 60 - suffix.length).replace(/-+$/, '') + suffix;
  let slug = fit(p.slug, '-kopia');
  for (let i = 2; slugTaken(slug); i++) slug = fit(p.slug, `-kopia-${i}`);
  // kópia dostane vlastné URL: prvý profil slug projektu, ďalšie s príponou kanála
  const taken = new Set([slug]);
  const profiles = p.config.profiles.map((pr, i) => {
    let s = slug;
    if (i > 0) {
      s = fit(slug, `-${pr.channel}`);
      for (let n = 2; taken.has(s) || slugTaken(s); n++) s = fit(slug, `-${pr.channel}-${n}`);
    }
    taken.add(s);
    return { ...pr, id: undefined, slug: s };
  });
  const copy = projects.create({
    name: `${p.name} (kópia)`, slug, source_url: '', interval_minutes: p.interval_minutes,
    enabled: false, config: { ...p.config, profiles },
  });
  res.status(201).json(publicProject(copy));
}));

app.delete('/api/projects/:id', wrap((req, res) => {
  const p = projects.get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Projekt neexistuje' });
  if (isRunning(p.id)) throw new HttpError(409, 'Projekt sa práve spracúva. Zmazať sa dá až po dokončení behu.');
  projects.remove(p.id);
  for (const pr of p.config.profiles) fs.rmSync(feedFile(pr.slug), { force: true });
  fs.rmSync(path.join(config.imagesDir, p.slug), { recursive: true, force: true });
  res.json({ ok: true });
}));

app.post('/api/projects/:id/run', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!projects.get(id)) return res.status(404).json({ error: 'Projekt neexistuje' });
  if (isRunning(id)) return res.status(409).json({ error: 'Projekt sa práve spracúva' });
  // force = používateľ potvrdil zápis napriek poistke poklesu; beh v pozadí, UI si stav ťahá cez /runs
  const f = req.body?.force;
  const force = f === true ? true : Array.isArray(f) ? f.filter((x) => typeof x === 'string') : false; // true = všetky profily, pole = len vymenované
  triggerRun(id, { force }).catch((e) => console.error(e));
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
  if (draft.config.profiles !== p.config.profiles) draft.config.profiles = normalizeProfiles(draft.config.profiles, p.slug); // neuložené profily z UI
  res.json(await previewProject(draft, { limit: Number(req.body?.limit) || 60, profile: req.body?.profile }));
}));

// Náhľad obrázka: ?index=N -> vyrenderuje N-tú položku zdrojového feedu s aktuálnym nastavením obrázkov
// Náhľad sa pri ladení vzhľadu volá často: zdrojový feed si chvíľu pamätáme, nech nebúšime do e-shopu
const previewSource = new Map();
async function sourceItemsCached(url) {
  const hit = previewSource.get(url);
  if (hit && Date.now() - hit.at < 120_000) return hit.items;
  const { items } = parseFeed(await fetchSource(url));
  previewSource.clear(); // stačí posledný zdroj
  previewSource.set(url, { at: Date.now(), items });
  return items;
}

const sourceOf = (original) => ({ id: fieldValue(original, 'id').trim(), group: fieldValue(original, 'item_group_id').trim() });

/** Konfigurácia projektu s neuloženými zmenami z UI (len časti, ktoré vplývajú na obrázok). */
function draftConfig(p, body) {
  const merged = { ...p.config };
  for (const k of ['rules', 'brand', 'campaigns', 'products', 'groups']) if (body[k] !== undefined) merged[k] = body[k];
  if (body.images) merged.images = { ...p.config.images, ...body.images, badge: { ...p.config.images.badge, ...(body.images.badge || {}) } };
  return normalizeConfig(merged, p.slug);
}

/**
 * Náhľad obrázka s aktuálnym (aj neuloženým) nastavením. Položka sa vyberá podľa `id`
 * (zdrojové ID) alebo `index`; sale=true posunie výber na najbližšiu položku so zľavou.
 * `override` = skúšobné nastavenie produktu, ktoré ešte nie je uložené.
 */
app.post('/api/projects/:id/preview-image', wrap(async (req, res) => {
  const p = projects.get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Projekt neexistuje' });
  const body = req.body || {};
  const cfg = draftConfig(p, body);
  const items = await sourceItemsCached(body.source_url || p.source_url);
  if (!items.length) return res.status(422).json({ error: 'Zdrojový feed je prázdny' });
  let idx = Math.min(items.length - 1, Math.max(0, parseInt(body.index, 10) || 0));
  if (body.id !== undefined) {
    idx = items.findIndex((it) => fieldValue(it, 'id').trim() === String(body.id));
    if (idx < 0) return res.status(404).json({ error: 'Produkt s týmto ID už v zdrojovom feede nie je' });
  }
  let item = applyRules(items[idx], cfg.rules).item;
  if (body.sale && body.id === undefined) {
    for (let n = 0; n < items.length; n++) {
      const j = (idx + n) % items.length;
      const cand = applyRules(items[j], cfg.rules).item;
      if (resolvePricing(cand).pct > 0) { idx = j; item = cand; break; }
    }
  }
  const url = fieldValue(item, 'image_link');
  if (!url) return res.status(422).json({ error: 'Položka nemá image_link' });
  const src = sourceOf(items[idx]);
  if (body.override && typeof body.override === 'object') cfg.products = normalizeConfig({ ...cfg, products: { ...cfg.products, [src.id]: body.override } }, p.slug).products;
  const at = Date.now();
  const plan = resolveCampaign(item, src, cfg, at);
  const ctx = { brand: cfg.brand, at, campaign: plan.campaign, layout: plan.layout, hidePrices: plan.hidePrices };
  const { jpg, badge, unchanged } = await renderPreview(url, item, cfg.images, ctx);
  res.set('X-Unchanged', unchanged ? '1' : '0');
  res.set('Content-Type', 'image/jpeg');
  res.set('X-Item-Title', encodeURIComponent(fieldValue(item, 'title')));
  res.set('X-Item-Index', String(idx));
  res.set('X-Badge', badge ? '1' : '0');
  if (plan.campaign) res.set('X-Campaign', encodeURIComponent(plan.campaign.name));
  if (badge?.notes.length) res.set('X-Badge-Notes', encodeURIComponent(badge.notes.join(' ')));
  res.send(jpg);
}));

/**
 * Produkty zo zdrojového feedu s tým, čo pre ne platí: cena, zľava, akcia (a odkiaľ sa vzala),
 * vlastné nastavenie produktu a skupiny variantov. `orphans` = nastavenia produktov, ktoré vo feede už nie sú.
 */
const money = (p) => (p ? `${p.amount.toFixed(2)}${p.currency ? ' ' + p.currency : ''}` : '');

app.get('/api/projects/:id/products', wrap(async (req, res) => {
  const p = projects.get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Projekt neexistuje' });
  const cfg = p.config;
  const items = await sourceItemsCached(p.source_url);
  const at = Date.now();
  const seen = new Set();
  const groupsSeen = new Set();
  const list = items.map((original) => {
    const src = sourceOf(original);
    seen.add(src.id);
    if (src.group) groupsSeen.add(src.group);
    const { item, excluded } = applyRules(original, cfg.rules);
    const pricing = resolvePricing(item, { priceField: cfg.images.badge.priceField, referenceField: cfg.images.badge.referenceField }, at);
    const plan = resolveCampaign(item, src, cfg, at);
    const ctx = { brand: cfg.brand, at, campaign: plan.campaign, layout: plan.layout, hidePrices: plan.hidePrices };
    return {
      id: src.id,
      group: src.group,
      title: fieldValue(original, 'title'),
      image: fieldValue(original, 'image_link'),
      // ceny tak, ako ich uvidí obrázok (vrátane vlastných polí ceny v nastavení), nie surové polia feedu
      price: money(pricing.pct > 0 ? pricing.reference : pricing.selling) || fieldValue(item, 'price'),
      sale_price: pricing.pct > 0 ? money(pricing.selling) : '',
      pct: pricing.pct,
      excluded: !!excluded,
      campaign: plan.campaign?.id || null,
      source: plan.source,
      own: own(cfg.products, src.id) || {},
      inherited: own(cfg.groups, src.group) || {},
      layout: plan.layout || cfg.images.badge.preset,
      graphic: !excluded && cfg.images.enabled && !!imagePlan(item, cfg.images, ctx).badge,
    };
  });
  res.json({
    items: list,
    orphans: {
      products: Object.keys(cfg.products).filter((k) => !seen.has(k)),
      groups: Object.keys(cfg.groups).filter((k) => !groupsSeen.has(k)),
    },
  });
}));

/**
 * Hromadné nastavenie produktov nad aktuálne uloženým stavom (telo musí niesť `rev`).
 * Mení sa len to, čo je v `set`: campaign (auto | none | id akcie), layout ('' | layout-N),
 * prices (auto | hide). `groups` = celé produkty s variantmi, `reset` = varianty, ktorým sa
 * tie isté položky vymažú, aby ich nastavenie celého produktu neprebíjalo staré vlastné.
 * `explicit: true` uloží aj predvolenú hodnotu (variant ňou prebíja nastavenie celého produktu).
 * Všetko je jeden zápis a jeden záznam v histórii.
 */
app.post('/api/projects/:id/assign', wrap((req, res) => {
  const p = projects.get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Projekt neexistuje' });
  const body = req.body || {};
  assertFresh(body, p);
  const keys = (v) => (Array.isArray(v) ? [...new Set(v.map(String).filter(Boolean))] : []);
  const ids = keys(body.ids), groups = keys(body.groups), reset = keys(body.reset);
  const set = body.set && typeof body.set === 'object' ? body.set : null;
  if (!set || (!ids.length && !groups.length)) throw new HttpError(400, 'Chýba výber produktov alebo to, čo sa má nastaviť');
  if (ids.length + groups.length + reset.length > MAX_OVERRIDES) throw new HttpError(400, 'Priveľa produktov naraz');
  for (const k of [...ids, ...groups, ...reset]) {
    if (k.length > 120 || ['__proto__', 'constructor', 'prototype'].includes(k)) throw new HttpError(400, `ID „${k.slice(0, 40)}“ sa nedá použiť ako kľúč nastavenia`);
  }
  if (set.campaign !== undefined && !['auto', 'none'].includes(set.campaign) && !p.config.campaigns.some((c) => c.id === set.campaign)) {
    throw new HttpError(400, 'Táto akcia v projekte neexistuje');
  }
  const explicit = body.explicit === true;
  const patch = (map, list, clearOnly) => {
    const out = Object.assign(Object.create(null), map); // kľúče sú ID z požiadavky, nesmú siahnuť na prototyp
    for (const k of list) {
      const cur = { ...(own(map, k) || {}) };
      const put = (field, value, isDefault, marker) => {
        if (value === undefined) return;
        if (clearOnly || (isDefault && !explicit)) delete cur[field];
        else cur[field] = isDefault ? marker : value;
      };
      put('campaign', set.campaign, set.campaign === 'auto', 'auto');
      put('layout', set.layout, !set.layout || set.layout === 'default', 'default');
      put('prices', set.prices, set.prices !== 'hide', 'show');
      out[k] = cur; // prázdne záznamy vyhodí normalizácia
    }
    return { ...out };
  };
  const products = patch(patch(p.config.products, reset, true), ids, false);
  const grouped = patch(p.config.groups, groups, false);
  const filled = (m) => Object.values(m).filter((v) => Object.keys(v).length).length;
  if (filled(products) > MAX_OVERRIDES || filled(grouped) > MAX_OVERRIDES) {
    throw new HttpError(400, `Projekt môže mať najviac ${MAX_OVERRIDES} vlastných nastavení produktov. Použi radšej podmienku v akcii.`);
  }
  res.json(publicProject(projects.update(p.id, { ...p, config: { ...p.config, products, groups: grouped } })));
}));

// História konfigurácie a návrat k staršej verzii
app.get('/api/projects/:id/versions', wrap((req, res) => {
  const p = projects.get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Projekt neexistuje' });
  res.json(versions.list(p.id));
}));

app.post('/api/projects/:id/versions/:vid/restore', wrap((req, res) => {
  const p = projects.get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Projekt neexistuje' });
  const old = versions.get(p.id, Number(req.params.vid));
  if (!old) return res.status(404).json({ error: 'Verzia neexistuje' });
  if (isRunning(p.id)) throw new HttpError(409, 'Projekt sa práve spracúva. Skús to po dokončení behu.');
  // Vracajú sa pravidlá a nastavenia. Zoznam profilov a ich URL ostáva dnešný: profil,
  // ktorý v starej verzii bol, dostane svoje vtedajšie pravidlá, novší ostane bez zmeny.
  const byId = new Map((old.profiles || []).map((pr) => [pr.id, pr]));
  const profiles = p.config.profiles.map((pr) => {
    const o = byId.get(pr.id);
    return o ? { ...pr, name: o.name, enabled: o.enabled, imageMode: o.imageMode, rules: o.rules } : pr;
  });
  const restored = projects.update(p.id, { ...p, config: { ...old, profiles } });
  res.json(publicProject(restored));
}));

// Zverejnený výstup projektu (to, čo práve vidí Meta) pre galériu v UI
app.get('/api/projects/:id/output', wrap((req, res) => {
  const p = projects.get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Projekt neexistuje' });
  const profile = p.config.profiles.find((pr) => pr.slug === req.query.profile) || p.config.profiles[0];
  const file = feedFile(profile.slug);
  if (!fs.existsSync(file)) return res.json({ profile: profile.slug, generated_at: null, items: [] });
  const { items } = parseFeed(fs.readFileSync(file, 'utf8'));
  res.json({
    profile: profile.slug,
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

// Vygeneruje pozadie z textu (Magnific) a uloží ho do knižnice
app.post('/api/assets/generate', wrap(async (req, res) => {
  const prompt = String(req.body?.prompt || '').trim();
  const name = String(req.body?.name || '').trim().toLowerCase();
  if (prompt.length < 10) throw new HttpError(400, 'Popíš pozadie aspoň pár slovami');
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(name)) throw new HttpError(400, 'Názov: malé písmená, číslice a pomlčky');
  const file = assetPath(`${name}.jpg`);
  if (fs.existsSync(file)) throw new HttpError(409, 'Pozadie s týmto názvom už existuje');
  let raw;
  try { raw = await generateImage(prompt); } catch (e) { throw new HttpError(502, e.message); }
  const jpg = await sharp(raw).resize(2000, 2000, { fit: 'cover' }).jpeg({ quality: 90 }).toBuffer();
  try {
    fs.writeFileSync(file, jpg, { flag: 'wx' }); // dve súbežné požiadavky s rovnakým názvom: druhá neprepíše prvú
  } catch (e) {
    if (e.code === 'EEXIST') throw new HttpError(409, 'Pozadie s týmto názvom už existuje');
    throw e;
  }
  res.status(201).json({ name: `${name}.jpg`, size: jpg.length, url: `/api/assets/${name}.jpg` });
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
