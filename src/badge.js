// Cenový badge: stará cena prečiarknutá, nová zvýraznená, voliteľne zľava a štítok kampane.
// Vracia SVG vrstvu cez celé plátno; text je vo vektorových krivkách (src/text.js).
// Rozmery sú navrhnuté pre plátno 1080 px a škálujú sa; čitateľnosť sa posudzuje na dlaždici ~150 px.
import { layoutText, sizeForDigitHeight, fontOf } from './text.js';
import { parsePrice, fieldValue, testWhen } from './feed/rules.js';

/** Zmena vzhľadu, ktorá má prerobiť už vygenerované obrázky = zvýšiť toto číslo. */
export const BADGE_VERSION = 1;

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

/** primary | accent | white | black | #rrggbb | auto (= null, dopočíta sa) */
function colorOf(token, brand) {
  if (token === 'primary') return brand.primary;
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

export const BADGE_DEFAULTS = {
  enabled: false,
  preset: 'card', // card = karta v rohu | strip = pás cez celú šírku
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
 * Zľava s obdobím platnosti (sale_price_effective_date = "začiatok/koniec" v ISO 8601):
 * mimo obdobia sa zľavová cena neberie, inak by obrázok sľuboval zľavu, ktorá ešte alebo už neplatí.
 */
function saleActive(item, at) {
  const raw = fieldValue(item, 'sale_price_effective_date').trim();
  if (!raw) return true;
  const [from, to] = raw.split('/').map((x) => Date.parse(x.trim()));
  if (Number.isNaN(from) || Number.isNaN(to)) return true; // nečitateľný rozsah nechávame na zdroj
  return at >= from && at <= to;
}

export function resolveBadge(item, badgeCfg, brandCfg, at = Date.now()) {
  const b = { ...BADGE_DEFAULTS, ...(badgeCfg || {}) };
  if (!b.enabled || !testWhen(item, b.when)) return null;
  const brand = normalizeBrand(brandCfg);
  const regular = parsePrice(fieldValue(item, 'price'));
  const priceField = b.priceField || 'sale_price';
  const now = priceField === 'sale_price' && !saleActive(item, at) ? null : parsePrice(fieldValue(item, priceField));
  const ref = parsePrice(fieldValue(item, b.referenceField || 'price'));
  const same = (x, y) => !x?.currency || !y?.currency || x.currency === y.currency; // rôzne meny sa nedajú porovnať
  // Skutočná predajná cena: zľavová, ak platí a je nižšia než bežná; inak bežná.
  // Tá sa ukáže vždy, aj keď zľava nedosiahne hranicu pre prečiarknutie.
  const saleValid = now && now.amount > 0 && same(now, regular) && (!regular || now.amount < regular.amount);
  const selling = saleValid ? now : regular;
  let exact = 0;
  if (saleValid && ref && same(now, ref) && now.amount < ref.amount) exact = (1 - now.amount / ref.amount) * 100;
  const onSale = exact + 1e-9 >= Math.max(1, Number(b.minDiscount) || 1); // skutočná zľava, nie zaokrúhlená (epsilon: 10 % vyjde ako 9,999…)
  const pct = Math.floor(exact + 1e-9); // zľavu nikdy nezaokrúhľujeme nahor (99,9 % nie je 100 %)
  const current = selling;
  if (!onSale && !(b.showWithoutSale && current && current.amount > 0)) return null;

  const cur = CURRENCY[(current.currency || ref?.currency || '').toUpperCase()] || { symbol: current.currency || '' };
  const trim = b.decimals === 'auto' && (!onSale || Number.isInteger(ref.amount)) && Number.isInteger(current.amount);
  const money = (p) => ({ number: formatAmount(p.amount, trim), symbol: cur.symbol, before: !!cur.before });

  const notes = [];
  const surface = colorOf(b.surface, brand) || brand.primary;
  let text = colorOf(b.text, brand) || onColor(surface);
  if (contrast(text, surface) < 4.5) { text = onColor(surface); notes.push('Farba textu bola na podklade zle čitateľná, použila sa kontrastná.'); }
  let highlight = colorOf(b.highlight, brand) || text;
  if (contrast(highlight, surface) < 3) { highlight = onColor(surface); notes.push('Farba novej ceny bola na podklade zle čitateľná, použila sa kontrastná.'); }
  // štítok zľavy: akcent značky, ak sa od podkladu dá odlíšiť, inak inverzia textu
  const chipBg = contrast(brand.accent, surface) >= 1.8 ? brand.accent : text;

  const preset = b.preset === 'strip' ? 'strip' : 'card';
  const pos = String(b.position || 'bottom-left');
  return {
    v: BADGE_VERSION,
    preset,
    position: preset === 'strip' ? (pos.startsWith('top') ? 'top' : 'bottom')
      : `${pos.startsWith('top') ? 'top' : 'bottom'}-${pos.endsWith('right') ? 'right' : pos.endsWith('center') ? 'center' : 'left'}`,
    scale: Math.min(1.3, Math.max(0.8, Number(b.scale) || 1)),
    font: brand.font,
    surface, text, highlight, chipBg, chipFg: onColor(chipBg),
    now: money(current),
    old: onSale ? money(ref) : null,
    discount: onSale && b.showDiscount ? `−${pct} %` : null,
    label: String(b.label || '').trim().slice(0, 40),
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

/** SVG vrstva s badge pre plátno W×H. */
export function renderBadge(spec, W, H) {
  const { svg, blur } = spec.preset === 'strip' ? strip(spec, W, H) : card(spec, W, H);
  const defs = blur ? `<defs><filter id="bs" x="-20%" y="-30%" width="140%" height="170%"><feGaussianBlur stdDeviation="${esc(blur)}"/></filter></defs>` : '';
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${defs}${svg}</svg>`);
}
