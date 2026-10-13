// Akcie (Black Friday, Vianoce, Výpredaj…) a nastavenia na úrovni produktu.
// Akcia má názov a farbu; produkt ju dostane ručným priradením alebo podmienkou. Nastavenie
// produktu (akcia, layout, skrytie cien) má prednosť pred akciou a tá pred predvoľbou projektu.
import crypto from 'node:crypto';
import { isHex, LAYOUTS } from './badge.js';
import { testWhen } from './feed/rules.js';

export const DEFAULT_CAMPAIGNS = [
  { id: 'black-friday', name: 'Black Friday', color: '#000000' },
  { id: 'vianoce', name: 'Vianoce', color: '#a3162a' },
  { id: 'vypredaj', name: 'Výpredaj', color: '#ff9000' },
];

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']); // ID z požiadavky nesmie siahnuť na prototyp objektu
const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const layoutOr = (v) => (Object.hasOwn(LAYOUTS, v) ? v : '');

/** undefined = projekt z čias pred akciami: dostane tri predvolené (nikomu nepriradené, nič nemenia). */
export function normalizeCampaigns(list) {
  const src = Array.isArray(list) ? list : DEFAULT_CAMPAIGNS;
  const seen = new Set();
  const out = [];
  for (const c of src) {
    if (!c || typeof c !== 'object') continue;
    const name = String(c.name || '').trim().slice(0, 40);
    if (!name) continue;
    let id = typeof c.id === 'string' && /^[a-z0-9][a-z0-9-]{0,40}$/.test(c.id) ? c.id : crypto.randomBytes(4).toString('hex');
    while (seen.has(id)) id = crypto.randomBytes(4).toString('hex');
    seen.add(id);
    out.push({
      id,
      name,
      color: isHex(c.color) ? c.color.toLowerCase() : '#000000',
      textColor: isHex(c.textColor) ? c.textColor.toLowerCase() : 'auto',
      enabled: c.enabled !== false,
      from: isDay(c.from) ? c.from : '', // platí od tohto dňa vrátane (Europe/Bratislava)
      to: isDay(c.to) ? c.to : '', // do tohto dňa vrátane
      layout: layoutOr(c.layout), // '' = podľa projektu
      when: Array.isArray(c.when) ? c.when.filter((w) => w && w.field) : [], // prázdne = len ručne priradené produkty
    });
    if (out.length >= 50) break;
  }
  return out;
}

export const MAX_OVERRIDES = 5000;
/** Bezpečné čítanie z mapy podľa ID z feedu: ID "constructor" nesmie vrátiť funkciu z prototypu. */
export const own = (map, key) => (map && key && Object.hasOwn(map, key) ? map[key] : undefined);

/**
 * Nastavenia produktov alebo skupín variantov, kľúč = ID zo ZDROJOVÉHO feedu (pred pravidlami).
 * Ukladajú sa len odchýlky:
 *  campaign: id akcie | 'none' (žiadna akcia) | 'auto' (podľa podmienok akcií)
 *  layout:   'layout-N' | 'default' (podľa akcie/projektu)
 *  prices:   'hide' | 'show'
 * Hodnoty 'auto', 'default' a 'show' sú výslovné predvoľby: majú zmysel pri variante, ktorý
 * tým prebíja nastavenie celého produktu. Inde ich /assign neukladá.
 */
export function normalizeOverrides(map, campaigns) {
  const ids = new Set(campaigns.map((c) => c.id));
  const out = Object.create(null);
  if (!map || typeof map !== 'object' || Array.isArray(map)) return {};
  let n = 0;
  for (const key of Object.keys(map)) {
    const v = map[key];
    if (!v || typeof v !== 'object' || !key || key.length > 120 || UNSAFE_KEYS.has(key)) continue;
    const o = {};
    if (v.campaign === 'none' || v.campaign === 'auto' || ids.has(v.campaign)) o.campaign = v.campaign; // zmazaná akcia = späť na automatiku
    if (v.layout === 'default' || layoutOr(v.layout)) o.layout = v.layout;
    if (v.prices === 'hide' || v.prices === 'show') o.prices = v.prices;
    if (!Object.keys(o).length) continue;
    out[key] = o;
    if (++n >= MAX_OVERRIDES) break;
  }
  return { ...out };
}

/** Dnešný deň v Bratislave ako YYYY-MM-DD; porovnáva sa ako text, takže letný čas nič nepokazí. */
export function bratislavaDay(at = Date.now()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Bratislava', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
}

export const campaignActive = (c, day) => c.enabled !== false && (!c.from || day >= c.from) && (!c.to || day <= c.to);

/**
 * Čo platí pre položku: { campaign, layout, hidePrices, source }.
 *  source: 'manual' (priradená ručne), 'rule' (podmienka akcie), 'none'.
 * Ručné priradenie akcie, ktorá práve neplatí (dátum, vypnutá), znamená žiadnu akciu:
 * produkt sa po skončení Black Friday nemá potichu presunúť do inej. Zrušením priradenia
 * (späť na "automaticky") začnú znova platiť podmienky; 'none' ich blokuje.
 * Pri podmienkach vyhráva prvá akcia v zozname, ktorej podmienky sedia.
 */
export function resolveCampaign(item, source, cfg, at = Date.now()) {
  const campaigns = cfg.campaigns || [];
  const override = { ...(own(cfg.groups, source?.group) || {}), ...(own(cfg.products, source?.id) || {}) };
  const day = bratislavaDay(at);
  // podmienky akcií vidia zľavu rovnako ako obrázok: rovnaké polia cien a rovnaký okamih behu
  const ctx = { pricing: { priceField: cfg.images?.badge?.priceField, referenceField: cfg.images?.badge?.referenceField }, at };
  let campaign = null;
  let from = 'none';
  if (override.campaign === 'none') {
    from = 'manual';
  } else if (override.campaign && override.campaign !== 'auto') {
    const c = campaigns.find((x) => x.id === override.campaign);
    campaign = c && campaignActive(c, day) ? c : null;
    from = 'manual';
  } else {
    campaign = campaigns.find((c) => campaignActive(c, day) && c.when.length > 0 && testWhen(item, c.when, ctx)) || null;
    if (campaign) from = 'rule';
  }
  return {
    campaign,
    layout: (override.layout && override.layout !== 'default' ? override.layout : '') || (override.layout === 'default' ? '' : campaign?.layout) || '',
    hidePrices: override.prices === 'hide',
    source: from,
    override,
  };
}

/** Dni, v ktorých niektorá akcia začína alebo končí: vtedy treba prepočítať hneď po polnoci. */
export function hasBoundary(campaigns, sinceDay, today) {
  if (sinceDay >= today) return false;
  return (campaigns || []).some((c) => c.enabled !== false
    && ((c.from && c.from > sinceDay && c.from <= today) || (c.to && c.to >= sinceDay && c.to < today)));
}
