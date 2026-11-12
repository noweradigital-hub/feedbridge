import zlib from 'node:zlib';
import { fieldValue, formatPrice, parsePrice, resolvePricing, stripHtml } from './rules.js';

/**
 * Feed pre ChatGPT (OpenAI Product Feed Spec, súborové nahrávanie):
 * https://developers.openai.com/commerce/specs/file-upload/products
 * Jeden riadok JSON na variant, celý súbor gzip (jsonl.gz). OpenAI si feed nesťahuje,
 * nahráva sa k nim cez SFTP; dovtedy sa súbor stiahne z /feeds/<slug>.jsonl.gz.
 * Položky v pipeline majú stále názvy polí ako Google/Meta, na formát OpenAI sa
 * prevádzajú až tu, pri zápise.
 */

export const OPENAI_AVAILABILITY = ['in_stock', 'out_of_stock', 'pre_order', 'backorder', 'unknown'];
const CONDITION = { new: 'new', refurbished: 'refurbished', used: 'used', used_like_new: 'used', used_good: 'used', used_fair: 'used', cpo: 'refurbished', open_box_new: 'new' };
const GENDER = { male: 'male', female: 'female', unisex: 'unisex' };
const AGE = ['newborn', 'infant', 'toddler', 'kids', 'adult'];
const VARIANT_KEYS = ['color', 'size', 'material', 'pattern'];

const val = (item, f) => fieldValue(item, f).trim();
const isUrl = (s) => /^https?:\/\/\S+$/i.test(s || '');
// dvakrát: popis z e-shopu býva aj s escapovaným HTML (&lt;p&gt;), po prvom dekódovaní z neho sú značky
const plain = (s) => stripHtml(stripHtml(s));

/** GTIN: 8, 12, 13 alebo 14 číslic so správnou kontrolnou číslicou, inak ho OpenAI odmietne. */
export function validGtin(s) {
  if (!/^(\d{8}|\d{12,14})$/.test(s)) return false;
  const d = [...s].map(Number);
  const check = d.pop();
  const sum = d.reverse().reduce((a, n, i) => a + n * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

/** Vlastnosti, ktorými sa variant líši: farba, veľkosť, materiál, vzor a Meta pole additional_variant_attribute. */
export function variantDict(item) {
  const out = Object.fromEntries(VARIANT_KEYS.map((k) => [k, val(item, k)]).filter(([, v]) => v));
  const extra = Array.isArray(item.additional_variant_attribute) ? item.additional_variant_attribute : [item.additional_variant_attribute];
  for (const raw of extra) {
    if (typeof raw !== 'string') continue;
    for (const part of raw.split(',')) {
      const i = part.indexOf(':');
      const k = part.slice(0, i).trim().toLowerCase();
      const v = part.slice(i + 1).trim();
      if (i > 0 && k && v && !Object.hasOwn(out, k)) out[k] = v;
    }
  }
  return out;
}

/** Normalizované nastavenia ChatGPT profilu (predajca, vrátenie tovaru, krajina). */
export function normalizeOpenAI(o = {}) {
  const url = (v) => (isUrl(String(v || '').trim()) ? String(v).trim().slice(0, 500) : '');
  const days = Number(o.returnDays);
  return {
    sellerName: String(o.sellerName || '').trim().slice(0, 120),
    sellerUrl: url(o.sellerUrl),
    returnPolicy: url(o.returnPolicy),
    returnDays: Number.isInteger(days) && days >= 0 && days <= 365 ? days : 14,
    country: /^[A-Za-z]{2}$/.test(String(o.country || '').trim()) ? String(o.country).trim().toUpperCase() : 'SK',
  };
}

/** Jedna položka (polia Google/Meta) -> riadok OpenAI. */
export function toOpenAI(item, settings, at = Date.now()) {
  const s = normalizeOpenAI(settings);
  const out = {
    item_id: val(item, 'id'),
    title: plain(val(item, 'title')),
    description: plain(val(item, 'description')),
    url: val(item, 'link'),
    brand: val(item, 'brand'),
    seller_name: s.sellerName,
    image_url: val(item, 'image_link'),
    availability: val(item, 'availability'),
  };
  const regular = parsePrice(val(item, 'price'));
  if (regular) out.price = formatPrice(regular.amount, regular.currency);
  const { selling } = resolvePricing(item, {}, at); // zľava len v čase platnosti a nižšia než bežná cena
  if (regular && selling && selling.amount < regular.amount) out.sale_price = formatPrice(selling.amount, selling.currency || regular.currency);

  const extra = Array.isArray(item.additional_image_link) ? item.additional_image_link.filter((u) => typeof u === 'string' && isUrl(u.trim())).map((u) => u.trim()) : [];
  if (extra.length) out.additional_image_urls = extra.slice(0, 20);
  const cond = CONDITION[val(item, 'condition').toLowerCase()];
  if (cond) out.condition = cond;
  const gtin = val(item, 'gtin').replace(/[\s-]/g, '');
  if (validGtin(gtin)) out.gtin = gtin;
  const mpn = val(item, 'mpn');
  if (mpn) out.mpn = mpn;
  const type = val(item, 'product_type');
  const gpc = val(item, 'google_product_category');
  const category = type || (/\D/.test(gpc) ? gpc : '');
  if (category) out.product_category = category;
  for (const f of ['color', 'size', 'material']) { const v = val(item, f); if (v) out[f] = v; }
  const gender = GENDER[val(item, 'gender').toLowerCase()];
  if (gender) out.gender = gender;
  const age = val(item, 'age_group').toLowerCase();
  if (AGE.includes(age)) out.age_group = age;

  const group = val(item, 'item_group_id');
  if (group && group !== out.item_id) {
    out.group_id = group;
    // variant bez známej vlastnosti ostane v skupine, ale bez sľubu variant_dict (checkItem na to upozorní)
    const variant = variantDict(item);
    if (Object.keys(variant).length) { out.listing_has_variations = true; out.variant_dict = variant; }
  }

  if (s.sellerUrl) out.seller_url = s.sellerUrl;
  out.is_eligible_search = true;
  out.is_eligible_checkout = false; // platba v ChatGPT je samostatná integrácia; nákup sa dokončí na e-shope
  if (s.returnDays > 0) {
    out.accepts_returns = true;
    out.return_deadline_in_days = s.returnDays;
  }
  if (s.returnPolicy) out.return_policy = s.returnPolicy;
  out.target_countries = [s.country];
  out.store_country = s.country;
  return out;
}

/** Celý feed ako jsonl.gz (Buffer). */
export function buildOpenAIFeed(items, settings, at = Date.now()) {
  const lines = items.map((it) => JSON.stringify(toOpenAI(it, settings, at)));
  return zlib.gzipSync(Buffer.from(lines.join('\n') + (lines.length ? '\n' : ''), 'utf8'));
}

/** Riadky zverejneného jsonl.gz súboru (pre poistku poklesu a záložku Výstup). */
export function readOpenAIFeed(buf) {
  const text = zlib.gunzipSync(buf).toString('utf8');
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* poškodený riadok preskočíme */ }
  }
  return rows;
}
