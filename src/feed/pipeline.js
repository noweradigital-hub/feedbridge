import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { parseFeed } from './parse.js';
import { applyRules, checkItem, fieldValue, channelOf, CHANNELS } from './rules.js';
import { buildFeedXml } from './xml.js';
import { ensureImage, pruneImages, mapLimit } from '../images.js';
import { safeFetch } from '../net.js';
import { resolveCampaign } from '../campaigns.js';

export async function fetchSource(url) {
  if (!/^https?:\/\//i.test(url || '')) throw new Error('Zdrojový feed musí byť http(s) URL');
  const res = await safeFetch(url, {
    headers: { 'User-Agent': 'FeedBridge/1.0', Accept: 'application/xml,text/xml,*/*' },
    timeoutMs: 90000,
    maxBytes: 100 * 1024 * 1024,
  });
  if (!res.ok) throw new Error(`Zdrojový feed vrátil HTTP ${res.status}`);
  return res.body.toString('utf8');
}

/** Zapnuté exportné profily projektu (každý = jeden výstupný feed s vlastnou URL). */
export function activeProfiles(project) {
  return (project.config.profiles || []).filter((p) => p.enabled !== false);
}

/** Google nesmie dostať promo grafiku ako hlavný obrázok, preto vždy pôvodná fotka. */
export function imageModeOf(profile) {
  if (channelOf(profile.channel) === 'google') return 'original';
  // clean = upravený formát bez cien a akcií, percent = akcia a % zľavy bez cien
  return ['original', 'clean', 'percent'].includes(profile.imageMode) ? profile.imageMode : 'project';
}

/** Zdrojové ID a skupina variantov položky: na ne sú naviazané nastavenia produktov (pravidlá môžu id prepísať). */
const sourceOf = (original) => ({ id: fieldValue(original, 'id').trim(), group: fieldValue(original, 'item_group_id').trim() });

const rulesFor = (project, profile) => [...(project.config.rules || []), ...(profile.rules || [])];

/** Len pravidlá, bez obrázkov - pre náhľad v UI. `profile` = slug profilu, inak prvý. */
export async function previewProject(project, { limit = 60, profile: slug } = {}) {
  const all = project.config.profiles || [];
  const profile = all.find((p) => p.slug === slug) || all[0];
  if (!profile) throw new Error('Projekt nemá žiadny exportný profil');
  const xml = await fetchSource(project.source_url);
  const { items } = parseFeed(xml);
  const rules = rulesFor(project, profile);
  const rows = [];
  let excluded = 0;
  let invalid = 0;
  const seen = new Set();
  for (const original of items) {
    const { item, excluded: ex, changed } = applyRules(original, rules, profile.channel);
    if (ex) { excluded++; }
    const { errors: issues, warnings: notes } = ex ? { errors: [], warnings: [] } : checkItem(item, profile.channel);
    if (!ex) {
      const id = fieldValue(item, 'id').trim();
      if (id && seen.has(id)) issues.push(`duplicitné id "${id}"`);
      seen.add(id);
    }
    if (issues.length) invalid++;
    if (rows.length < limit) {
      rows.push({ original, result: ex ? null : item, excluded: ex, changed, issues, notes });
    }
  }
  return { total: items.length, excluded, invalid, rows, profile: profile.slug, channel: channelOf(profile.channel) };
}

export class GuardError extends Error {
  constructor(message) { super(message); this.guard = true; }
}

/** Počet unikátnych neprázdnych ID v publikovanom feede (Meta páruje produkty podľa id). */
async function previousIdCount(file) {
  let xml;
  try { xml = await fs.readFile(file, 'utf8'); } catch { return null; } // feed ešte neexistuje
  const ids = new Set();
  for (const m of xml.matchAll(/<g:id>([^<]*)<\/g:id>/g)) if (m[1].trim()) ids.add(m[1].trim());
  return ids.size || (xml.match(/<item>/g) || []).length;
}

function distinctIds(items) {
  return new Set(items.map((it) => fieldValue(it, 'id').trim()).filter(Boolean)).size;
}

/**
 * Poistka proti zmazaniu katalógu v Mete: naplánovaný feed v režime "nahradiť"
 * odstráni produkty, ktoré vo feede chýbajú. Prázdny feed alebo veľký pokles
 * (zlé pravidlo, orezaný zdroj) preto bez potvrdenia (force) nezapíšeme.
 */
async function checkDropGuard(count, file, safety, log) {
  if (!count) throw new GuardError('Poistka: po pravidlách nezostala žiadna položka s ID, feed neprepisujem. Skontroluj pravidlá „Vylúčiť“, pravidlá nad poľom id a zdroj, alebo spusti beh s potvrdením.');
  // 0 = vypnuté (ako drop_guard v nwr-product-feeds); prázdne/neplatné pole = predvolených 50 %
  const raw = safety?.maxDropPct;
  const maxDrop = raw === '' || raw == null || !Number.isFinite(Number(raw)) ? 50 : Math.min(100, Math.max(0, Number(raw)));
  const prev = await previousIdCount(file);
  if (!prev || maxDrop === 0) return;
  const drop = Math.round((1 - count / prev) * 100);
  if (count < prev * (1 - maxDrop / 100)) {
    throw new GuardError(`Poistka: ${count} unikátnych ID oproti ${prev} v poslednom feede (pokles o ${drop} %, limit ${maxDrop} %). Feed neprepisujem; skontroluj pravidlá a zdroj, alebo spusti beh s potvrdením.`);
  }
  if (drop > 0) log(`Pokles oproti poslednému feedu: ${prev} → ${count} (${drop} %, limit ${maxDrop} %)`);
}

const emptyImages = () => ({ generated: 0, cached: 0, failed: 0, skipped: 0 });

/** Obrázky, na ktoré odkazuje práve zverejnený feed (aby ich upratovanie nezmazalo, keď profil tento raz nezapísal). */
async function publishedImages(file) {
  const out = new Set();
  let xml;
  try { xml = await fs.readFile(file, 'utf8'); } catch { return out; }
  const prefix = `${config.publicUrl}/img/`;
  for (const m of xml.matchAll(/<g:image_link>([^<]+)<\/g:image_link>/g)) {
    if (m[1].startsWith(prefix)) out.add(m[1].slice(prefix.length));
  }
  return out;
}

/** Jeden profil: pravidlá projektu + profilu, poistka, obrázky, validácia pre kanál, atomický zápis. */
async function runProfile(project, profile, items, channel, ps, used, log, forced, at) {
  const cfg = project.config;
  const file = path.join(config.feedsDir, `${profile.slug}.xml`);
  const rules = rulesFor(project, profile);
  const processed = [];
  const sources = new Map(); // položka po pravidlách -> zdrojové ID a skupina
  for (const original of items) {
    const { item, excluded } = applyRules(original, rules, profile.channel);
    if (excluded) { ps.excluded++; continue; }
    processed.push(item);
    sources.set(item, sourceOf(original));
  }
  log(`Po pravidlách: ${processed.length} položiek (vylúčených ${ps.excluded})`);
  if (forced) log('Poistka poklesu vypnutá (spustené s potvrdením)');
  else await checkDropGuard(distinctIds(processed), file, cfg.safety, log); // pred obrázkami, nech sa neplatí výrez zbytočne

  const img = cfg.images;
  const mode = imageModeOf(profile);
  if (img.enabled && mode !== 'original') {
    log(`Spracúvam obrázky (${{ clean: 'bez cien a akcií', percent: 'len akcia a % zľavy' }[mode] || 's cenami a akciami'}, súbežne ${config.imageConcurrency})`);
    await mapLimit(processed, config.imageConcurrency, async (item) => {
      const url = fieldValue(item, 'image_link');
      if (!url) { ps.images.skipped++; return; }
      try {
        const plan = mode === 'clean' ? null : resolveCampaign(item, sources.get(item), cfg, at);
        if (plan?.campaign) ps.campaigns[plan.campaign.id] = (ps.campaigns[plan.campaign.id] || 0) + 1;
        const ctx = { brand: cfg.brand, at, overlay: mode !== 'clean', campaign: plan?.campaign, layout: plan?.layout, hidePrices: plan?.hidePrices || mode === 'percent' };
        const { file: out, cached } = await ensureImage(project.slug, url, item, img, ctx);
        if (!out) { ps.images.skipped++; return; } // bez badge ostáva pôvodná fotka
        used.add(out);
        if (cached) ps.images.cached++; else ps.images.generated++;
        if (img.keepOriginalAsAdditional) {
          const extra = Array.isArray(item.additional_image_link) ? item.additional_image_link : [];
          item.additional_image_link = [url, ...extra.filter((u) => u !== url)].slice(0, CHANNELS[channelOf(profile.channel)].additionalImages);
        }
        item.image_link = `${config.publicUrl}/img/${out}`;
      } catch (e) {
        ps.images.failed++;
        if (ps.warnings.length < 50) ps.warnings.push(`Obrázok ${fieldValue(item, 'id')}: ${e.message}`);
      }
    });
    log(`Obrázky: nových ${ps.images.generated}, z cache ${ps.images.cached}, chýb ${ps.images.failed}`);
  }

  const seen = new Set();
  for (const item of processed) {
    const { errors, warnings } = checkItem(item, profile.channel);
    const id = fieldValue(item, 'id').trim();
    if (id && seen.has(id)) errors.push(`duplicitné id "${id}"`);
    seen.add(id);
    if (errors.length) ps.invalid++;
    if (warnings.length) ps.notes++;
    if ((errors.length || warnings.length) && ps.warnings.length < 50) {
      ps.warnings.push(`Položka ${id || '?'}: ${[...errors, ...warnings.map((w) => `${w} (odporúčané)`)].join(', ')}`);
    }
  }
  const out = buildFeedXml(channel, processed);
  await fs.writeFile(file + '.tmp', out);
  await fs.rename(file + '.tmp', file);
  ps.written = processed.length;
  log(`Feed zapísaný: ${processed.length} položiek, ${(out.length / 1024).toFixed(0)} kB`);
}

/**
 * Plný beh: zdroj sa stiahne raz a každý zapnutý profil z neho dostane vlastný feed.
 * Zlyhanie zdroja vyhodí chybu (nič sa neprepíše). Zlyhanie jedného profilu (napr. poistka)
 * ostatné nezastaví: je v summary.profiles[slug].error a súhrnne v summary.error / summary.guard.
 * force = true (všetky profily) alebo pole slugov, ktorým sa má poistka poklesu odpustiť.
 */
export async function runProject(project, log = () => {}, { force = false } = {}) {
  const profiles = activeProfiles(project);
  if (!profiles.length) throw new Error('Projekt nemá žiadny zapnutý exportný profil');
  const isForced = (slug) => force === true || (Array.isArray(force) && force.includes(slug));
  const summary = { total: 0, excluded: 0, written: 0, invalid: 0, notes: 0, images: emptyImages(), warnings: [], profiles: {} };

  log(`Sťahujem zdrojový feed: ${project.source_url}`);
  const xml = await fetchSource(project.source_url);
  const { channel, items } = parseFeed(xml);
  summary.total = items.length;
  log(`Načítaných položiek: ${items.length}`);
  if (!items.length) throw new Error('Zdrojový feed neobsahuje žiadne položky - feed neprepisujem.');

  const used = new Set();
  const many = profiles.length > 1;
  const at = Date.now(); // jeden okamih pre celý beh: platnosť zliav a akcií sa v strede behu nezmení
  summary.at = at; // podľa neho plánovač zistí, či medzitým začala alebo skončila akcia
  for (const profile of profiles) {
    const ps = { name: profile.name, channel: channelOf(profile.channel), excluded: 0, written: 0, invalid: 0, notes: 0, images: emptyImages(), campaigns: {}, warnings: [] };
    summary.profiles[profile.slug] = ps;
    const plog = many ? (m) => log(`[${profile.slug}] ${m}`) : log;
    try {
      await runProfile(project, profile, items, channel, ps, used, plog, isForced(profile.slug), at);
    } catch (e) {
      ps.error = e.message;
      if (e.guard) ps.guard = true;
      plog(`CHYBA: ${e.message}`);
      // profil ostáva pri starom feede, jeho obrázky sa preto stále používajú
      for (const f of await publishedImages(path.join(config.feedsDir, `${profile.slug}.xml`))) used.add(f);
    }
    for (const k of ['excluded', 'written', 'invalid', 'notes']) summary[k] += ps[k];
    for (const k of Object.keys(summary.images)) summary.images[k] += ps.images[k];
    for (const w of ps.warnings) if (summary.warnings.length < 80) summary.warnings.push(many ? `[${profile.slug}] ${w}` : w);
  }
  // profily, ktoré sú vypnuté, ale majú zverejnený feed, si svoje obrázky tiež držia
  for (const p of project.config.profiles || []) {
    if (p.enabled === false) for (const f of await publishedImages(path.join(config.feedsDir, `${p.slug}.xml`))) used.add(f);
  }

  const removed = await pruneImages(project.slug, used, config.imageRetentionDays);
  if (removed) log(`Zmazaných ${removed} obrázkov nepoužívaných dlhšie než ${config.imageRetentionDays} dní`);

  const failed = Object.entries(summary.profiles).filter(([, p]) => p.error);
  if (failed.length) {
    summary.error = failed.map(([slug, p]) => (many ? `${slug}: ${p.error}` : p.error)).join(' | ');
    const guarded = failed.filter(([, p]) => p.guard).map(([slug]) => slug);
    if (guarded.length) { summary.guard = true; summary.guardProfiles = guarded; }
  }
  return summary;
}
