// Cenový badge: stará cena prečiarknutá, nová zvýraznená, voliteľne zľava a štítok kampane.
// Vracia SVG vrstvu cez celé plátno; text je vo vektorových krivkách (src/text.js).
// Rozmery sú navrhnuté pre plátno 1080 px a škálujú sa; čitateľnosť sa posudzuje na dlaždici ~150 px.
import { layoutText, sizeForDigitHeight, fontOf, lineMetrics } from './text.js';
import { resolvePricing, testWhen } from './feed/rules.js';

/** Zmena vzhľadu, ktorá má prerobiť už vygenerované obrázky = zvýšiť toto číslo. */
export const BADGE_VERSION = 1; // pôvodné presety card a strip
export const LAYOUT_VERSION = 1; // Layout 1-3 podľa návrhu vo Figme

/** Layouty podľa návrhu: kde sedia ceny, ako sa ukáže akcia a čo je pod nimi. Zľava je vždy vpravo hore. */
export const LAYOUTS = {
  'layout-1': { label: 'Layout 1', prices: 'left', campaign: 'tag', backdrop: null },
  'layout-2': { label: 'Layout 2', prices: 'right', campaign: 'text', backdrop: 'scrim' },
  'layout-3': { label: 'Layout 3', prices: 'right', campaign: 'text', backdrop: 'panel' },
};
export const PRESETS = ['card', 'strip', ...Object.keys(LAYOUTS)];
export const isLayout = (preset) => Object.hasOwn(LAYOUTS, preset);

// ---------------------------------------------------------------- farby

const WHITE = '#ffffff';
const INK = '#14171c';
export const isHex = (c) => /^#[0-9a-f]{6}$/i.test(c || '');

function luminance(hex) {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
/** Biela alebo takmer čierna, podľa toho, čo je na podklade čitateľnejšie. */
export const onColor = (bg) => (contrast(WHITE, bg) >= contrast(INK, bg) ? WHITE : INK);

export function normalizeBrand(brand) {
  const b = brand || {};
  return {
    primary: isHex(b.primary) ? b.primary.toLowerCase() : '#14171c',
    accent: isHex(b.accent) ? b.accent.toLowerCase() : '#e11d48',
    font: fontOf(b.font),
  };
}

const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hexOf = (rgb) => '#' + rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
/** Zmieša dve farby; t = podiel druhej. */
export const mix = (a, b, t) => hexOf(rgbOf(a).map((v, i) => v * (1 - t) + rgbOf(b)[i] * t));

/**
 * Keď je text na podklade slabo čitateľný, text sa nechá a podklad sa po malých krokoch
 * stmaví (alebo zosvetlí), kým kontrast nedosiahne `min`. Dizajn tak ostane, len je čitateľný.
 */
export function tuneBackground(bg, fg, min = 3) {
  const toward = luminance(fg) > 0.5 ? '#000000' : WHITE;
  let out = bg;
  for (let i = 0; i < 20 && contrast(fg, out) < min; i++) out = mix(out, toward, 0.06);
  return out;
}

/** primary | primary-dark | accent | white | black | #rrggbb | auto (= null, dopočíta sa) */
function colorOf(token, brand) {
  if (token === 'primary') return brand.primary;
  if (token === 'primary-dark') return mix(brand.primary, '#31363b', 0.52); // tlmený tmavší odtieň hlavnej farby
  if (token === 'accent') return brand.accent;
  if (token === 'white') return WHITE;
  if (token === 'black') return INK;
  return isHex(token) ? token.toLowerCase() : null;
}

// ---------------------------------------------------------------- ceny

const CURRENCY = {
  EUR: { symbol: '€' }, CZK: { symbol: 'Kč' }, PLN: { symbol: 'zł' }, HUF: { symbol: 'Ft' },
  USD: { symbol: '$', before: true }, GBP: { symbol: '£', before: true },
};

/** 1299.5 -> "1 299,50"; pri trim sa ",00" vynechá */
function formatAmount(amount, trim) {
  const fixed = amount.toFixed(2);
  let [int, dec] = fixed.split('.');
  if (int.length > 4) int = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' '); // 12 990, ale 1299
  return trim && dec === '00' ? int : `${int},${dec}`;
}

/** Prvky layoutov 1-3: či sa kreslia a akú majú farbu podkladu a textu (odkaz na značku alebo hex). */
export const ELEMENT_DEFAULTS = {
  price: { show: true, bg: 'primary', text: 'white' }, // nová cena
  old: { show: true, bg: 'primary-dark', text: 'white' }, // pôvodná cena, prečiarknutá
  discount: { show: true, bg: '#f03636', text: 'white' }, // pilulka so zľavou
  campaign: { show: true }, // štítok alebo názov akcie; farbu určuje akcia
};
export function normalizeElements(el) {
  const out = {};
  for (const [k, d] of Object.entries(ELEMENT_DEFAULTS)) {
    const v = el?.[k] || {};
    out[k] = { show: v.show !== false };
    if ('bg' in d) { out[k].bg = typeof v.bg === 'string' && v.bg ? v.bg : d.bg; out[k].text = typeof v.text === 'string' && v.text ? v.text : d.text; }
  }
  return out;
}

export const BADGE_DEFAULTS = {
  enabled: false,
  preset: 'card', // card = karta v rohu | strip = pás pod fotkou | layout-1..3 = podľa návrhu
  elements: normalizeElements(), // len pre layout-1..3
  position: 'bottom-left', // card: top|bottom + left|center|right; strip: top|bottom
  scale: 1, // 0.8 - 1.3
  surface: 'primary', // podklad
  text: 'auto', // stará cena, štítok
  highlight: 'auto', // nová cena
  showDiscount: false,
  label: '', // napr. "Black Friday"
  decimals: 'always', // always = 23,00 € | auto = 23 €, ak sú obe ceny celé
  priceField: 'sale_price',
  // Referenčná (prečiarknutá) cena. Pri oznámení zľavy má ísť o najnižšiu cenu za 30 dní
  // pred zľavou; ak ju zdroj posiela v inom poli, nastav ho sem.
  referenceField: 'price',
  minDiscount: 1, // % - pod touto zľavou sa badge nezobrazí
  showWithoutSale: false, // produkty bez zľavy: badge len s aktuálnou cenou
  when: [],
};

/**
 * Rozhodne, či položka dostane badge, a pripraví všetko, čo určuje jeho vzhľad.
 * Výsledok ide celý do kľúča cache: zmena ceny, farby či textu = nový obrázok.
 * Vráti null, ak sa badge nemá kresliť.
 */
/**
 * Farba prvku: podklad a text. Pevne zvolený text sa nemení; ak je na podklade zle čitateľný,
 * doladí sa podklad. Text "auto" sa vyberie podľa podkladu.
 */
function pair(el, brand, notes, what, min = 3) {
  let bg = colorOf(el.bg, brand) || brand.primary;
  const chosen = colorOf(el.text, brand);
  const fg = chosen || onColor(bg);
  if (contrast(fg, bg) < min) {
    bg = tuneBackground(bg, fg, min);
    notes.push(`${what}: podklad bol voči textu príliš svetlý, mierne sa stmavil kvôli čitateľnosti.`);
  }
  return { bg, fg };
}

/**
 * Rozhodne, čo sa na obrázok položky nakreslí, a pripraví všetko, čo určuje vzhľad.
 * Výsledok ide celý do kľúča cache: zmena ceny, farby či textu = nový obrázok.
 * ctx = { campaign: {name,color,textColor}|null, layout: prepis layoutu, hidePrices: bool }
 * (akcia a nastavenie produktu, pozri campaigns.js). Vráti null, ak sa nemá kresliť nič.
 */
export function resolveBadge(item, badgeCfg, brandCfg, at = Date.now(), ctx = {}) {
  const b = { ...BADGE_DEFAULTS, ...(badgeCfg || {}) };
  if (!b.enabled || !testWhen(item, b.when)) return null;
  const brand = normalizeBrand(brandCfg);
  const { selling, reference: ref, exactPct, pct } = resolvePricing(item, { priceField: b.priceField, referenceField: b.referenceField }, at);
  const onSale = exactPct + 1e-9 >= Math.max(1, Number(b.minDiscount) || 1); // skutočná zľava, nie zaokrúhlená (epsilon: 10 % vyjde ako 9,999…)
  const current = selling;
  const preset = PRESETS.includes(ctx.layout) ? ctx.layout : PRESETS.includes(b.preset) ? b.preset : 'card';
  const campaign = ctx.campaign || null;
  const hasPrice = !!current && current.amount > 0 && (onSale || !!b.showWithoutSale);
  const notes = [];
  const scale = Math.min(1.3, Math.max(0.8, Number(b.scale) || 1));

  const cur = current ? CURRENCY[(current.currency || ref?.currency || '').toUpperCase()] || { symbol: current.currency || '' } : {};
  const trim = b.decimals === 'auto' && !!current && (!onSale || Number.isInteger(ref.amount)) && Number.isInteger(current.amount);
  const money = (p) => ({ number: formatAmount(p.amount, trim), symbol: cur.symbol, before: !!cur.before });

  if (isLayout(preset)) {
    // Cena, zľava a akcia sa rozhodujú nezávisle: produkt v akcii bez zľavy má len štítok,
    // produkt so skrytými cenami má štítok a zľavu, zľavnený produkt bez akcie ceny a zľavu.
    const el = normalizeElements(b.elements);
    const showPrice = hasPrice && el.price.show && !ctx.hidePrices;
    const showOld = showPrice && onSale && el.old.show;
    const showPill = onSale && el.discount.show;
    const showCampaign = !!campaign && el.campaign.show;
    if (!showPrice && !showPill && !showCampaign) return null;
    const campBg = showCampaign ? (isHex(campaign.color) ? campaign.color.toLowerCase() : '#000000') : null;
    return {
      v: LAYOUT_VERSION,
      preset,
      scale,
      font: brand.font,
      now: showPrice ? money(current) : null,
      old: showOld ? money(ref) : null,
      pill: showPill ? `-${pct}%` : null,
      price: showPrice ? pair(el.price, brand, notes, 'Nová cena') : null,
      oldStyle: showOld ? pair(el.old, brand, notes, 'Pôvodná cena') : null,
      pillStyle: showPill ? pair(el.discount, brand, notes, 'Zľava') : null,
      campaign: showCampaign ? {
        name: String(campaign.name || '').trim().slice(0, 40),
        bg: campBg,
        // veľký tučný nápis: svetlý text ostáva aj na sýtych farbách (oranžová z návrhu), tmavý až na naozaj svetlom podklade
        fg: isHex(campaign.textColor) ? campaign.textColor.toLowerCase() : contrast('#f1f1f1', campBg) >= 2 ? '#f1f1f1' : onColor(campBg),
      } : null,
      notes,
    };
  }

  if (!hasPrice || ctx.hidePrices) return null; // pôvodné presety sú cenové: bez ceny (alebo so skrytými cenami) sa nekreslia
  const surface = colorOf(b.surface, brand) || brand.primary;
  let text = colorOf(b.text, brand) || onColor(surface);
  if (contrast(text, surface) < 4.5) { text = onColor(surface); notes.push('Farba textu bola na podklade zle čitateľná, použila sa kontrastná.'); }
  let highlight = colorOf(b.highlight, brand) || text;
  if (contrast(highlight, surface) < 3) { highlight = onColor(surface); notes.push('Farba novej ceny bola na podklade zle čitateľná, použila sa kontrastná.'); }
  // štítok zľavy: akcent značky, ak sa od podkladu dá odlíšiť, inak inverzia textu
  const chipBg = contrast(brand.accent, surface) >= 1.8 ? brand.accent : text;

  const pos = String(b.position || 'bottom-left');
  return {
    v: BADGE_VERSION,
    preset,
    position: preset === 'strip' ? (pos.startsWith('top') ? 'top' : 'bottom')
      : `${pos.startsWith('top') ? 'top' : 'bottom'}-${pos.endsWith('right') ? 'right' : pos.endsWith('center') ? 'center' : 'left'}`,
    scale,
    font: brand.font,
    surface, text, highlight, chipBg, chipFg: onColor(chipBg),
    now: money(current),
    old: onSale ? money(ref) : null,
    discount: onSale && b.showDiscount ? `−${pct} %` : null,
    label: String(campaign?.name || b.label || '').trim().slice(0, 40), // akcia produktu má prednosť pred pevným štítkom
    notes,
  };
}

// ---------------------------------------------------------------- kreslenie

const esc = (n) => Number(n.toFixed(1));

/** Cena ako skupina kriviek: číslo + menší symbol meny na tej istej účiarí. */
function priceRun(money, digitPx, font, weight) {
  const size = sizeForDigitHeight(digitPx, font, weight);
  const num = layoutText(money.number, { family: font, weight, size });
  const sym = money.symbol ? layoutText(money.symbol, { family: font, weight, size: size * 0.84 }) : null;
  const gap = sym ? size * (money.before ? 0.05 : 0.12) : 0;
  const width = num.width + (sym ? gap + sym.width : 0);
  return {
    width, digitPx, size,
    path(x, baseline, fill) {
      const d = money.before && sym
        ? sym.d(x, baseline) + num.d(x + sym.width + gap, baseline)
        : num.d(x, baseline) + (sym ? sym.d(x + num.width + gap, baseline) : '');
      return `<path d="${d}" fill="${fill}"/>`;
    },
  };
}

function textRun(text, digitPx, font, weight, tracking = 0) {
  const size = sizeForDigitHeight(digitPx, font, weight);
  const t = layoutText(text, { family: font, weight, size, tracking: size * tracking });
  return { width: t.width, digitPx, size, path: (x, baseline, fill) => `<path d="${t.d(x, baseline)}" fill="${fill}"/>` };
}

/** Stará cena s rovnou čiarou cez stred číslic (rovnaká farba ako text, mierny presah). */
function struck(run, x, baseline, fill, k) {
  const over = run.size * 0.04;
  const y = baseline - run.digitPx * 0.52;
  return run.path(x, baseline, fill)
    + `<rect x="${esc(x - over)}" y="${esc(y - 3 * k)}" width="${esc(run.width + 2 * over)}" height="${esc(6 * k)}" rx="${esc(1.5 * k)}" fill="${fill}"/>`;
}

function chip(text, digitPx, font, spec, k) {
  const run = textRun(text, digitPx, font, 800);
  const padX = 14 * k, padY = 10 * k;
  const w = run.width + 2 * padX, h = digitPx + 2 * padY;
  return {
    width: w, height: h,
    draw: (x, baseline) => `<rect x="${esc(x)}" y="${esc(baseline - digitPx - padY)}" width="${esc(w)}" height="${esc(h)}" rx="${esc(10 * k)}" fill="${spec.chipBg}"/>`
      + run.path(x + padX, baseline, spec.chipFg),
  };
}

function cardLayout(spec, W) {
  let k = (W / 1080) * spec.scale;
  const build = () => {
    const font = spec.font;
    const rows = [];
    if (spec.label) rows.push({ kind: 'label', h: 36 * k, run: textRun(spec.label.toUpperCase(), 36 * k, font, 800, 0.04) });
    if (spec.old) {
      const run = priceRun(spec.old, 70 * k, font, 600);
      const c = spec.discount ? chip(spec.discount, 56 * k, font, spec, k) : null;
      rows.push({ kind: 'old', h: (c ? Math.max(70 * k, c.height) : 70 * k), textH: 70 * k, run, chip: c, width: run.width + (c ? 24 * k + c.width : 0) });
    }
    rows.push({ kind: 'now', h: 116 * k, run: priceRun(spec.now, 116 * k, font, 800) });
    for (const r of rows) r.width ??= r.run.width;
    const padX = 40 * k, padY = 38 * k, gap = 24 * k;
    const w = Math.max(...rows.map((r) => r.width)) + 2 * padX;
    const h = rows.reduce((a, r) => a + r.h, 0) + gap * (rows.length - 1) + 2 * padY;
    return { rows, padX, padY, gap, w, h, k };
  };
  let L = build();
  const inset = 48 * (W / 1080);
  const maxW = W - 2 * inset;
  if (L.w > maxW) { k *= maxW / L.w; L = build(); } // dlhá cena: zmenší sa celý badge, nikdy nepretečie
  return { ...L, inset };
}

function cardRect(spec, W, H, position = spec.position) {
  const L = cardLayout(spec, W);
  const [vert, horiz] = position.split('-');
  const x = horiz === 'right' ? W - L.inset - L.w : horiz === 'center' ? (W - L.w) / 2 : L.inset;
  const y = vert === 'top' ? L.inset : H - L.inset - L.h;
  return { x, y, w: L.w, h: L.h };
}

function card(spec, W, H) {
  const L = cardLayout(spec, W);
  const k = L.k;
  const [, horiz] = spec.position.split('-');
  const { x, y } = cardRect(spec, W, H);
  const r = 20 * k;
  let out = `<rect x="${esc(x)}" y="${esc(y + 3 * k)}" width="${esc(L.w)}" height="${esc(L.h)}" rx="${esc(r)}" fill="#000" fill-opacity="0.11" filter="url(#bs)"/>`
    + `<rect x="${esc(x)}" y="${esc(y)}" width="${esc(L.w)}" height="${esc(L.h)}" rx="${esc(r)}" fill="${spec.surface}"/>`;
  let top = y + L.padY;
  for (const row of L.rows) {
    const rx = horiz === 'right' ? x + L.w - L.padX - row.width : horiz === 'center' ? x + (L.w - row.width) / 2 : x + L.padX;
    if (row.kind === 'label') out += row.run.path(rx, top + row.h, spec.text);
    else if (row.kind === 'old') {
      const baseline = top + (row.h + row.textH) / 2; // text aj štítok zľavy vycentrované na výšku riadka
      out += struck(row.run, rx, baseline, spec.text, k);
      if (row.chip) out += row.chip.draw(rx + row.run.width + 24 * k, top + (row.h + 56 * k) / 2);
    } else out += row.run.path(rx, top + row.h, spec.highlight);
    top += row.h + L.gap;
  }
  return { svg: out, blur: 6 * k };
}

/** Výška pásu v px pre plátno šírky W. Pri pôvodnej fotke je to päta POD fotkou, fotku nezakrýva. */
export const stripHeight = (spec, W) => Math.round(216 * (W / 1080) * spec.scale);

/**
 * Pás cez celú šírku: vpravo veľká nová cena, vľavo blok rovnakej výšky (štítok kampane
 * nad starou cenou), takže horné a dolné hrany oboch strán lícujú. Bez štítka sedí stará
 * cena na rovnakej účiarí ako nová.
 */
function strip(spec, W, H) {
  const k0 = W / 1080;
  const padX = 48 * k0;
  const maxW = W - 2 * padX;
  const barH = stripHeight(spec, W);
  const y = spec.position === 'top' ? 0 : H - barH;
  const mid = y + barH / 2;
  const font = spec.font;
  const build = (k, kl) => {
    const now = priceRun(spec.now, 124 * k, font, 800);
    const two = !!(spec.old && (spec.label || spec.discount)); // dva riadky vľavo: hore štítok alebo zľava, dole stará cena
    const old = spec.old ? priceRun(spec.old, (two ? (spec.label ? 64 : 58) : 72) * kl, font, 600) : null;
    const label = spec.label ? textRun(spec.label.toUpperCase(), 46 * kl, font, 800, 0.05) : null;
    const c = spec.discount ? chip(spec.discount, (label ? 50 : 34) * kl, font, spec, kl) : null; // nad starou cenou: 34 + 20 + medzera 12 + 58 = výška novej ceny
    const chipOnTop = !!c && !label;
    const oldRow = (old ? old.width : 0) + (c && !chipOnTop ? 22 * kl + c.width : 0);
    const left = Math.max(label ? label.width : 0, chipOnTop ? c.width : 0, oldRow);
    return { now, old, c, label, chipOnTop, left, kl, total: left + (left ? 48 * k : 0) + now.width };
  };
  // Keď sa obsah nezmestí, najprv ustúpi ľavý blok (až na 70 %), až potom nová cena:
  // hlavná cena má mať naprieč produktmi rovnakú veľkosť.
  let k = k0 * spec.scale;
  let L = build(k, k);
  if (L.total > maxW) L = build(k, k * Math.max(0.7, (maxW - L.now.width - 48 * k) / Math.max(1, L.left)));
  if (L.total > maxW) { k *= maxW / L.total; L = build(k, L.kl * (maxW / L.total)); }

  let out = `<rect x="0" y="${esc(y)}" width="${W}" height="${esc(barH)}" fill="${spec.surface}"/>`;
  const nowBase = mid + L.now.digitPx / 2;
  const nowTop = nowBase - L.now.digitPx;
  const nowX = L.left ? W - padX - L.now.width : (W - L.now.width) / 2; // samotná cena ide do stredu
  if (L.label) out += L.label.path(padX, nowTop + L.label.digitPx, spec.text); // horná hrana lícuje s novou cenou
  if (L.chipOnTop) out += L.c.draw(padX, nowTop + L.c.height - 10 * L.kl); // štítok zľavy hore, jeho horná hrana lícuje
  let x = padX;
  if (L.old) { out += struck(L.old, x, nowBase, spec.text, L.kl); x += L.old.width + 22 * L.kl; }
  if (L.c && !L.chipOnTop) out += L.c.draw(x, nowBase - ((L.old ? L.old.digitPx : L.now.digitPx) - 50 * L.kl) / 2);
  out += L.now.path(nowX, nowBase, spec.highlight);
  return { svg: out, blur: 0 };
}

// ---------------------------------------------------------------- Layout 1-3 (návrh vo Figme)
// Miery sú v jednotkách návrhu (plátno široké 1400) a prepočítavajú sa na šírku plátna.
// Text je zadaný veľkosťou písma a boxy majú výšku riadka ako v CSS, takže sedia s Figmou.

const moneyText = (m) => (m.before ? `${m.symbol}${m.number}` : `${m.number} ${m.symbol}`.trim());

/** Box s textom. opts.strike = prečiarknutie cez celý text vrátane medzery pred a za (ako v návrhu). */
function textBox(text, { size, weight, padX, padY, radius, bg, fg, font, strike = false, height = 0 }) {
  const run = layoutText(text, { family: font, weight, size });
  const m = lineMetrics(font, weight, size);
  const space = strike ? size * 0.26 : 0;
  const h = height || m.lineHeight + 2 * padY;
  const w = run.width + 2 * space + 2 * padX;
  return {
    w, h,
    draw(x, y) {
      const baseline = y + (h - m.lineHeight) / 2 + m.baseline;
      let out = `<rect x="${esc(x)}" y="${esc(y)}" width="${esc(w)}" height="${esc(h)}" rx="${esc(Math.min(radius, h / 2))}" fill="${bg}"/>`
        + `<path d="${run.d(x + padX + space, baseline)}" fill="${fg}"/>`;
      if (strike) out += `<rect x="${esc(x + padX)}" y="${esc(baseline - m.strikeY - m.strikeSize / 2)}" width="${esc(run.width + 2 * space)}" height="${esc(Math.max(m.strikeSize, size * 0.06))}" fill="${fg}"/>`;
      return out;
    },
  };
}

/**
 * Text, ktorý sa musí zmestiť do šírky: najprv sa zmenší (najviac na 55 %), potom skráti
 * s výpustkou. Keď na neho miesto nie je vôbec, vráti null a nekreslí sa.
 */
function fittedText(text, { size, weight, font, maxWidth }) {
  if (!(maxWidth > size)) return null;
  const measure = (t, s) => layoutText(t, { family: font, weight, size: s });
  let used = size;
  let run = measure(text, used);
  if (run.width > maxWidth) { used = Math.max(size * 0.55, size * (maxWidth / run.width)); run = measure(text, used); }
  let shown = text;
  while (run.width > maxWidth && shown.length > 1) {
    shown = shown.slice(0, -1).trimEnd();
    run = measure(`${shown}…`, used);
  }
  if (run.width > maxWidth) return null;
  return { run, size: used, text: shown === text ? text : `${shown}…` };
}

let gradientSeq = 0;

function layout(spec, W, H) {
  const L = LAYOUTS[spec.preset];
  const u = W / 1400; // jednotka návrhu
  const k = u * spec.scale; // veľkosť prvkov; okraje sa so "scale" nemenia
  const font = spec.font;
  const insetL = 46 * u, insetR = 50 * u, top = 52 * u;
  const upper = (t) => t.toLocaleUpperCase('sk');
  let out = '';
  let defs = '';

  // zľava vpravo hore
  const pill = spec.pill ? textBox(spec.pill, { size: 95.5 * k, weight: 700, padX: 54 * k, padY: 15 * k, radius: 999, font, bg: spec.pillStyle.bg, fg: spec.pillStyle.fg }) : null;

  // ceny: pôvodná nad novou, zarovnané podľa layoutu
  const now = spec.now ? textBox(moneyText(spec.now), { size: 110.4 * k, weight: 700, padX: 30 * k, padY: 20 * k, radius: 20 * k, font, bg: spec.price.bg, fg: spec.price.fg }) : null;
  // pôvodná cena je oproti návrhu o stupeň väčšia a tučnejšia: na malej dlaždici by 63 px Regular nebolo čitateľné
  const old = spec.old ? textBox(moneyText(spec.old), { size: 70 * k, weight: 600, padX: 20 * k, padY: 10 * k, radius: 20 * k, font, bg: spec.oldStyle.bg, fg: spec.oldStyle.fg, strike: true }) : null;
  const stackW = Math.max(now?.w || 0, old?.w || 0);
  const nowY = H - 59 * u - (now?.h || 0);
  const stackX = (box) => (L.prices === 'left' ? insetL : W - insetR - box.w);

  const c = spec.campaign;
  if (c && L.backdrop) {
    // prechod vo farbe akcie: dole plná farba, smerom hore sa stráca
    const id = `fg${++gradientSeq}`;
    const panel = L.backdrop === 'panel';
    const x = panel ? 24 * u : 0, w = W - 2 * x;
    const h = (panel ? 473 : 352) * u, y = H - h - (panel ? 30 * u : 0);
    const r = panel ? 40 * u : 0;
    defs += `<linearGradient id="${id}" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${c.bg}"/><stop offset="${panel ? 0.94 : 1}" stop-color="${c.bg}" stop-opacity="0"/></linearGradient>`;
    // zaoblené sú len dolné rohy panelu
    out += panel
      ? `<path d="M${esc(x)} ${esc(y)}H${esc(x + w)}V${esc(y + h - r)}a${esc(r)} ${esc(r)} 0 0 1 ${esc(-r)} ${esc(r)}H${esc(x + r)}a${esc(r)} ${esc(r)} 0 0 1 ${esc(-r)} ${esc(-r)}Z" fill="url(#${id})"/>`
      : `<rect x="0" y="${esc(y)}" width="${W}" height="${esc(h)}" fill="url(#${id})"/>`;
    const textX = (panel ? 24 + 72 : 80) * u;
    const maxWidth = W - insetR - stackW - (stackW ? 40 * u : 0) - textX;
    const t = fittedText(upper(c.name), { size: 87.7 * k, weight: 700, font, maxWidth });
    if (t) out += `<path d="${t.run.d(textX, H - 100 * u)}" fill="${c.fg}"/>`;
  } else if (c) {
    // štítok akcie: vľavo hore; keď nie sú ceny, sadne si na ich miesto vľavo dole (4. rám návrhu)
    const padX = 42 * k;
    const free = W - insetL - insetR - 2 * padX;
    const t = fittedText(upper(c.name), { size: 63.4 * k, weight: 700, font, maxWidth: now ? free - (pill ? pill.w + 30 * u : 0) : free });
    if (t) {
      const tag = textBox(t.text, { size: t.size, weight: 700, padX, padY: 0, height: 146 * k, radius: 30 * k, font, bg: c.bg, fg: c.fg });
      out += tag.draw(insetL, now ? top : H - 39 * u - tag.h);
    }
  }

  if (pill) out += pill.draw(W - insetR - pill.w, top);
  if (now) out += now.draw(stackX(now), nowY);
  if (old) out += old.draw(stackX(old), (now ? nowY : H - 59 * u) - 22 * u - old.h);
  return { svg: out, defs };
}

/** SVG vrstva s badge pre plátno W×H. */
export function renderBadge(spec, W, H) {
  let svg, defs = '';
  if (isLayout(spec.preset)) ({ svg, defs } = layout(spec, W, H));
  else {
    const r = spec.preset === 'strip' ? strip(spec, W, H) : card(spec, W, H);
    svg = r.svg;
    if (r.blur) defs = `<filter id="bs" x="-20%" y="-30%" width="140%" height="170%"><feGaussianBlur stdDeviation="${esc(r.blur)}"/></filter>`;
  }
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${defs ? `<defs>${defs}</defs>` : ''}${svg}</svg>`);
}
