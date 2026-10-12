import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { parseFeed } from './parse.js';
import { applyRules, checkItem, fieldValue } from './rules.js';
import { buildFeedXml } from './xml.js';
import { ensureImage, pruneImages, mapLimit } from '../images.js';
import { safeFetch } from '../net.js';

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

/** Len pravidlá, bez obrázkov - pre náhľad v UI. */
export async function previewProject(project, { limit = 60 } = {}) {
  const xml = await fetchSource(project.source_url);
  const { items } = parseFeed(xml);
  const rows = [];
  let excluded = 0;
  let invalid = 0;
  const seen = new Set();
  for (const original of items) {
    const { item, excluded: ex, changed } = applyRules(original, project.config.rules);
    if (ex) { excluded++; }
    const { errors: issues, warnings: notes } = ex ? { errors: [], warnings: [] } : checkItem(item);
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
  return { total: items.length, excluded, invalid, rows };
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

/** Plný beh: stiahni, spracuj, vygeneruj obrázky, zapíš feed. force = obíď poistku poklesu. */
export async function runProject(project, log = () => {}, { force = false } = {}) {
  const summary = {
    total: 0, excluded: 0, written: 0, invalid: 0, notes: 0,
    images: { generated: 0, cached: 0, failed: 0, skipped: 0 },
    warnings: [],
  };
  const cfg = project.config;
  const slug = project.slug;

  log(`Sťahujem zdrojový feed: ${project.source_url}`);
  const xml = await fetchSource(project.source_url);
  const { channel, items } = parseFeed(xml);
  summary.total = items.length;
  log(`Načítaných položiek: ${items.length}`);
  if (!items.length) throw new Error('Zdrojový feed neobsahuje žiadne položky - feed neprepisujem.');

  // 1) pravidlá
  const processed = [];
  for (const original of items) {
    const { item, excluded } = applyRules(original, cfg.rules);
    if (excluded) { summary.excluded++; continue; }
    processed.push({ item, original });
  }
  log(`Po pravidlách: ${processed.length} položiek (vylúčených ${summary.excluded})`);
  const file = path.join(config.feedsDir, `${slug}.xml`);
  if (force) log('Poistka poklesu vypnutá (spustené s potvrdením)');
  else await checkDropGuard(distinctIds(processed.map((p) => p.item)), file, cfg.safety, log); // pred obrázkami, nech sa neplatí remove.bg zbytočne

  // 2) obrázky
  const used = new Set();
  const img = cfg.images;
  if (img.enabled) {
    log(`Spracúvam obrázky (provider: ${img.provider}, súbežne ${config.imageConcurrency})`);
    await mapLimit(processed, config.imageConcurrency, async ({ item }) => {
      const url = fieldValue(item, 'image_link');
      if (!url) { summary.images.skipped++; return; }
      try {
        const { file, cached } = await ensureImage(slug, url, item, img);
        used.add(file);
        if (cached) summary.images.cached++; else summary.images.generated++;
        if (img.keepOriginalAsAdditional) {
          const extra = Array.isArray(item.additional_image_link) ? item.additional_image_link : [];
          item.additional_image_link = [url, ...extra.filter((u) => u !== url)].slice(0, 10);
        }
        item.image_link = `${config.publicUrl}/img/${file}`;
      } catch (e) {
        summary.images.failed++;
        if (summary.warnings.length < 50) summary.warnings.push(`Obrázok ${fieldValue(item, 'id')}: ${e.message}`);
      }
    });
    log(`Obrázky: nových ${summary.images.generated}, z cache ${summary.images.cached}, chýb ${summary.images.failed}`);
  }

  // 3) validácia a zápis
  const seen = new Set();
  for (const { item } of processed) {
    const { errors, warnings } = checkItem(item);
    const id = fieldValue(item, 'id').trim();
    if (id && seen.has(id)) errors.push(`duplicitné id "${id}"`);
    seen.add(id);
    if (errors.length) summary.invalid++;
    if (warnings.length) summary.notes++;
    if ((errors.length || warnings.length) && summary.warnings.length < 50) {
      summary.warnings.push(`Položka ${fieldValue(item, 'id') || '?'}: ${[...errors, ...warnings.map((w) => `${w} (odporúčané)`)].join(', ')}`);
    }
  }
  const out = buildFeedXml(channel, processed.map((p) => p.item));
  await fs.writeFile(file + '.tmp', out);
  await fs.rename(file + '.tmp', file);
  summary.written = processed.length;
  log(`Feed zapísaný: ${processed.length} položiek, ${(out.length / 1024).toFixed(0)} kB`);

  {
    // aj pri vypnutých obrázkoch: staré súbory doslúžia retenčnú dobu a potom zmiznú
    const removed = await pruneImages(slug, used, config.imageRetentionDays);
    if (removed) log(`Zmazaných ${removed} obrázkov nepoužívaných dlhšie než ${config.imageRetentionDays} dní`);
  }
  return summary;
}
