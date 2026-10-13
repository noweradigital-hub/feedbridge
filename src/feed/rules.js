/**
 * Pravidlový engine. Projekt má usporiadaný zoznam pravidiel, ktoré sa aplikujú
 * na každú položku feedu v danom poradí.
 *
 * Typy pravidiel:
 *  exclude   { when }                                   -> položka vypadne z feedu
 *  set       { field, value, when, onlyIfEmpty }        -> nastaví pole zo šablóny, napr. "{brand} - {title}"
 *  replace   { field, find, with, regex, when }         -> nájdi/nahraď v poli
 *  clean_html{ field, when }                            -> odstráni HTML, entity, zbytočné medzery
 *  truncate  { field, length, when }                    -> skráti na celé slovo
 *  price     { field, mode: percent|add|round, value }  -> úprava ceny (price / sale_price)
 *  remove    { field, when }                            -> zmaže pole
 *
 * Podmienky (when): pole objektov { field, op, value }, všetky musia platiť (AND).
 * ops: eq neq contains ncontains regex empty nempty gt lt gte lte in
 * Dopočítané polia: price_num, sale_price_num, discount_pct, currency
 */

export const RULE_TYPES = ['exclude', 'set', 'replace', 'clean_html', 'truncate', 'price', 'remove'];

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function stripHtml(s) {
  return String(s ?? '')
    .replace(/<\s*br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6])>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * "29,90 EUR", "1 234,50 CZK", "1,234.50 USD", "EUR 12.90" -> { amount, currency }.
 * Zámerne prísne: čomu sa nedá jednoznačne rozumieť, to je null. Cena sa môže vypáliť
 * do obrázka a zle prečítaná suma ("1,234,567" ako 1,23) je horšia než žiadna.
 * Skupiny po troch čísliciach sú tisíce; desatinná časť má 1-2 číslice.
 */
export function parsePrice(v) {
  if (typeof v !== 'string') return null;
  const m = /^\s*([A-Za-z]{3})?\s*(\d{1,3}(?:[ \u00a0.,']\d{3})+|\d+)(?:[.,](\d{1,2}))?\s*([A-Za-z]{3})?\s*$/.exec(v);
  if (!m) return null;
  const n = Number(`${m[2].replace(/[^\d]/g, '')}.${m[3] || '0'}`);
  if (!Number.isFinite(n)) return null;
  return { amount: n, currency: (m[4] || m[1] || '').toUpperCase() };
}

export function formatPrice(amount, currency) {
  return `${amount.toFixed(2)}${currency ? ' ' + currency : ''}`;
}

/**
 * Zľava s obdobím platnosti (sale_price_effective_date = "začiatok/koniec" v ISO 8601):
 * mimo obdobia sa zľavová cena neberie, inak by sa sľubovala zľava, ktorá ešte alebo už neplatí.
 */
function saleActive(item, at) {
  const raw = scalar(item.sale_price_effective_date).trim();
  if (!raw) return true;
  const [from, to] = raw.split('/').map((x) => Date.parse(x.trim()));
  if (Number.isNaN(from) || Number.isNaN(to)) return true; // nečitateľný rozsah nechávame na zdroj
  return at >= from && at <= to;
}

/**
 * Jediné miesto, kde sa rozhoduje o cene a zľave položky. Používajú ho podmienky pravidiel
 * (discount_pct), akcie aj obrázok, takže sa nikdy nerozídu.
 *  selling   = skutočná predajná cena (zľavová, ak platí a je nižšia než bežná; inak bežná)
 *  reference = cena na porovnanie (prečiarknutá)
 *  exactPct  = skutočná zľava voči referenčnej cene, pct = zaokrúhlená NADOL (99,9 % nie je 100 %)
 */
export function resolvePricing(item, { priceField = 'sale_price', referenceField = 'price' } = {}, at = Date.now()) {
  const pf = priceField || 'sale_price'; // prázdne pole v nastavení = predvolené, vrátane kontroly platnosti zľavy
  const regular = parsePrice(scalar(item.price));
  const sale = pf === 'sale_price' && !saleActive(item, at) ? null : parsePrice(scalar(item[pf]));
  const reference = parsePrice(scalar(item[referenceField || 'price']));
  const same = (x, y) => !x?.currency || !y?.currency || x.currency === y.currency; // rôzne meny sa nedajú porovnať
  const saleValid = !!sale && sale.amount > 0 && same(sale, regular) && (!regular || sale.amount < regular.amount);
  const selling = saleValid ? sale : regular;
  let exactPct = 0;
  if (saleValid && reference && same(sale, reference) && sale.amount < reference.amount) exactPct = (1 - sale.amount / reference.amount) * 100;
  return { selling, reference, exactPct, pct: Math.floor(exactPct + 1e-9) };
}

function scalar(v) {
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : '';
  return typeof v === 'string' ? v : '';
}

/**
 * Hodnota poľa vrátane dopočítaných. ctx = { pricing: { priceField, referenceField }, at }:
 * kto rozhoduje o grafike (akcie), posiela rovnaké polia a čas ako obrázok, aby discount_pct sedel s tým, čo je na ňom.
 */
export function fieldValue(item, field, ctx) {
  switch (field) {
    case 'price_num': {
      const p = parsePrice(scalar(item.price));
      return p ? String(p.amount) : '';
    }
    case 'sale_price_num': {
      const p = parsePrice(scalar(item.sale_price));
      return p ? String(p.amount) : '';
    }
    case 'currency': {
      const p = parsePrice(scalar(item.price));
      return p ? p.currency : '';
    }
    case 'discount_pct':
      return String(resolvePricing(item, ctx?.pricing, ctx?.at).pct); // rovnaký výpočet ako na obrázku (platnosť zľavy, mena, zaokrúhlenie nadol)
    default:
      return scalar(item[field]);
  }
}

export function testCondition(item, cond, ctx) {
  const raw = fieldValue(item, cond.field, ctx);
  const val = String(cond.value ?? '');
  let a = raw.toLowerCase();
  let b = val.toLowerCase();
  if (cond.field === 'availability' && ['eq', 'neq', 'in'].includes(cond.op)) {
    // podmienka "in_stock" aj "in stock" platí pred aj po normalizácii na formát Mety (contains/regex ostávajú doslovné)
    a = metaAvailability(a);
    b = cond.op === 'in' ? b.split(',').map((x) => metaAvailability(x.trim())).join(',') : metaAvailability(b);
  }
  switch (cond.op) {
    case 'eq': return a === b;
    case 'neq': return a !== b;
    case 'contains': return a.includes(b);
    case 'ncontains': return !a.includes(b);
    case 'regex':
      try { return new RegExp(val, 'i').test(raw); } catch { return false; }
    case 'empty': return raw.trim() === '';
    case 'nempty': return raw.trim() !== '';
    case 'in': return b.split(',').map((x) => x.trim()).filter(Boolean).includes(a);
    case 'gt': case 'lt': case 'gte': case 'lte': {
      const x = parseFloat(raw.replace(',', '.'));
      const y = parseFloat(val.replace(',', '.'));
      if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
      return cond.op === 'gt' ? x > y : cond.op === 'lt' ? x < y : cond.op === 'gte' ? x >= y : x <= y;
    }
    default: return false;
  }
}

export function testWhen(item, when, ctx) {
  if (!Array.isArray(when) || !when.length) return true;
  return when.every((c) => c && c.field && testCondition(item, c, ctx));
}

const FILTERS = {
  upper: (s) => s.toUpperCase(),
  lower: (s) => s.toLowerCase(),
  title: (s) => s.toLowerCase().replace(/(^|\s)(\S)/g, (_, a, b) => a + b.toUpperCase()),
  trim: (s) => s.trim(),
  strip_html: (s) => stripHtml(s),
  first_word: (s) => s.trim().split(/\s+/)[0] || '',
  last_category: (s) => s.split(/\s*>\s*/).pop() || '',
  first_category: (s) => s.split(/\s*>\s*/)[0] || '',
};

/** Šablóna: "{brand} - {title|title} ({product_type|last_category}) {description|strip_html|truncate:120}" */
export function renderTemplate(tpl, item) {
  return String(tpl ?? '')
    .replace(/\{([a-z0-9_]+)((?:\|[a-z_]+(?::[^|}]*)?)*)\}/gi, (_, field, filters) => {
      let v = fieldValue(item, field);
      for (const f of filters.split('|').filter(Boolean)) {
        const [name, arg] = f.split(':');
        if (name === 'truncate') v = truncateWords(v, parseInt(arg, 10) || 100);
        else if (name === 'default') { if (!v) v = arg ?? ''; }
        else if (FILTERS[name]) v = FILTERS[name](v);
      }
      return v;
    })
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:!?)])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .replace(/(^|\s)[–\-|,]\s*$/g, '')
    .trim();
}

export function truncateWords(s, max) {
  s = String(s ?? '');
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:–-]+$/, '') + '…';
}

function setScalar(item, field, value) {
  if (field === 'additional_image_link') {
    item[field] = value ? [value] : [];
  } else {
    item[field] = value;
  }
}

/**
 * Aplikuje pravidlá na jednu položku.
 * Vráti { item, excluded: null | {rule, index}, changes: [polia, ktoré sa zmenili] }
 */
export function applyRules(original, rules, channel = 'meta') {
  const item = structuredClone(original);
  const changed = new Set();
  for (let i = 0; i < (rules || []).length; i++) {
    const r = rules[i];
    if (!r || r.enabled === false) continue;
    if (!testWhen(item, r.when)) continue;
    switch (r.type) {
      case 'exclude':
        return { item, excluded: { index: i, note: r.note || '' }, changed: [...changed] };
      case 'set': {
        if (!r.field) break;
        if (r.onlyIfEmpty && fieldValue(item, r.field).trim() !== '') break;
        setScalar(item, r.field, renderTemplate(r.value, item));
        changed.add(r.field);
        break;
      }
      case 'replace': {
        if (!r.field || r.find === undefined || r.find === '') break;
        const cur = fieldValue(item, r.field);
        let next = cur;
        if (r.regex) {
          try { next = cur.replace(new RegExp(r.find, 'gi'), r.with ?? ''); } catch { /* neplatný regex ignorujeme */ }
        } else {
          next = cur.split(r.find).join(r.with ?? '');
        }
        if (next !== cur) { setScalar(item, r.field, next.replace(/\s{2,}/g, ' ').trim()); changed.add(r.field); }
        break;
      }
      case 'clean_html': {
        if (!r.field) break;
        const cur = fieldValue(item, r.field);
        const next = stripHtml(cur);
        if (next !== cur) { setScalar(item, r.field, next); changed.add(r.field); }
        break;
      }
      case 'truncate': {
        if (!r.field) break;
        const cur = fieldValue(item, r.field);
        const next = truncateWords(cur, Number(r.length) || 150);
        if (next !== cur) { setScalar(item, r.field, next); changed.add(r.field); }
        break;
      }
      case 'price': {
        const field = r.field === 'sale_price' ? 'sale_price' : 'price';
        const p = parsePrice(fieldValue(item, field));
        if (!p) break;
        const v = parseFloat(String(r.value ?? '0').replace(',', '.')) || 0;
        let amount = p.amount;
        if (r.mode === 'percent') amount = amount * (1 + v / 100);
        else if (r.mode === 'add') amount = amount + v;
        else if (r.mode === 'round') amount = v > 0 ? Math.round(amount / v) * v : Math.round(amount);
        item[field] = formatPrice(Math.max(0, amount), p.currency);
        changed.add(field);
        break;
      }
      case 'remove': {
        if (r.field && r.field in item) { delete item[r.field]; changed.add(r.field); }
        break;
      }
      default: break;
    }
  }
  for (const f of normalizeForChannel(item, channel)) changed.add(f);
  return { item, excluded: null, changed: [...changed] };
}

// ---------------------------------------------------------------- kanály (Meta, Google)

// Google formát (in_stock, backorder…) -> hodnoty, ktoré uvádza Meta špecifikácia
const AVAILABILITY_MAP = {
  in_stock: 'in stock', out_of_stock: 'out of stock', preorder: 'preorder',
  backorder: 'available for order', available_for_order: 'available for order',
};
const TO_GOOGLE = {
  'in stock': 'in_stock', 'out of stock': 'out_of_stock', preorder: 'preorder',
  'available for order': 'backorder', discontinued: 'out_of_stock',
};
// polia, ktoré pozná len Meta; v Google feede by boli hlásené ako neznáme atribúty
const META_ONLY = ['quantity_to_sell_on_facebook', 'status', 'visibility', 'fb_product_category', 'internal_label', 'additional_variant_attribute'];

export const CHANNELS = {
  meta: {
    label: 'Meta',
    required: ['id', 'title', 'description', 'link', 'image_link', 'price', 'availability', 'condition'],
    titleMax: 200, descriptionMax: 9999, additionalImages: 20,
    availability: ['in stock', 'out of stock', 'preorder', 'available for order', 'discontinued'],
  },
  google: {
    label: 'Google',
    required: ['id', 'title', 'description', 'link', 'image_link', 'price', 'availability'],
    titleMax: 150, descriptionMax: 5000, additionalImages: 10,
    availability: ['in_stock', 'out_of_stock', 'preorder', 'backorder'],
  },
};
export const channelOf = (name) => (name === 'google' ? 'google' : 'meta');

function metaAvailability(v) {
  return AVAILABILITY_MAP[String(v).trim().toLowerCase().replace(/\s+/g, '_')] ?? v;
}

/** Zjednotí hodnoty polí na formát kanála. Vráti zoznam zmenených polí. */
export function normalizeForChannel(item, channel = 'meta') {
  const ch = channelOf(channel);
  const changed = [];
  const av = fieldValue(item, 'availability').trim().toLowerCase();
  if (av) {
    const meta = metaAvailability(av);
    const target = ch === 'google' ? TO_GOOGLE[meta] : AVAILABILITY_MAP[av.replace(/\s+/g, '_')];
    if (target && target !== item.availability) { item.availability = target; changed.push('availability'); }
  }
  const cond = fieldValue(item, 'condition').trim();
  if (cond && cond !== cond.toLowerCase()) { item.condition = cond.toLowerCase(); changed.push('condition'); }
  if (ch === 'google') {
    for (const f of META_ONLY) if (f in item) { delete item[f]; changed.push(f); }
  }
  const max = CHANNELS[ch].additionalImages;
  if (Array.isArray(item.additional_image_link) && item.additional_image_link.length > max) {
    item.additional_image_link = item.additional_image_link.slice(0, max);
    changed.push('additional_image_link');
  }
  return changed;
}

const CONDITIONS = ['new', 'refurbished', 'used', 'used_like_new', 'used_good', 'used_fair', 'cpo', 'open_box_new'];

/**
 * Kontrola položky pre daný kanál: errors = položka bude odmietnutá (počíta sa do "invalid"),
 * warnings = odporúčané polia, položka prejde.
 */
export function checkItem(item, channel = 'meta') {
  const ch = channelOf(channel);
  const spec = CHANNELS[ch];
  const errors = [];
  const warnings = [];
  for (const f of spec.required) {
    if (fieldValue(item, f).trim() === '') errors.push(`chýba ${f}`);
  }
  const t = fieldValue(item, 'title');
  if (t.length > spec.titleMax) errors.push(`title > ${spec.titleMax} znakov`);
  const d = fieldValue(item, 'description');
  if (d.length > spec.descriptionMax) errors.push(`description > ${spec.descriptionMax} znakov`);
  const p = parsePrice(fieldValue(item, 'price'));
  if (fieldValue(item, 'price') && !p) errors.push('price v neplatnom formáte');
  if (p && !p.currency) errors.push('price bez meny');
  const av = fieldValue(item, 'availability');
  if (av && !spec.availability.includes(av.toLowerCase())) errors.push(`availability "${av}" nie je platná hodnota`);
  const cond = fieldValue(item, 'condition');
  if (cond && !CONDITIONS.includes(cond.toLowerCase())) errors.push(`condition "${cond}" nie je platná hodnota`);
  if (!['brand', 'gtin', 'mpn'].some((f) => fieldValue(item, f).trim() !== '')) warnings.push('chýba brand (ani gtin/mpn)');
  if (ch === 'google' && ['preorder', 'backorder'].includes(av.toLowerCase()) && !fieldValue(item, 'availability_date').trim()) {
    errors.push('chýba availability_date (Google ho pri predobjednávke a tovare na objednávku vyžaduje)');
  }
  return { errors, warnings };
}

export function validateItem(item, channel = 'meta') {
  return checkItem(item, channel).errors;
}
