import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { config } from './config.js';
import { testWhen } from './feed/rules.js';
import { safeFetch } from './net.js';
import { removeBackground as magnificRemoveBackground } from './magnific.js';
import { resolveBadge, renderBadge, isHex, stripHeight } from './badge.js';

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const DAY = 86_400_000;

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}
const touch = (file) => fs.utimes(file, new Date(), new Date()).catch(() => {});

// Rovnaký súbor (napr. varianty so spoločnou fotkou) sa vyrába len raz, ostatní čakajú na ten istý Promise.
const inflight = new Map();
function once(key, fn) {
  let p = inflight.get(key);
  if (!p) {
    p = Promise.resolve().then(fn).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

// Zápis cez unikátny .tmp + rename, aby exists() nikdy nevidel napoly zapísaný súbor.
async function writeAtomic(file, buf) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

// ---------------------------------------------------------------- originály

// Obrázky z e-shopov sú nedôveryhodný vstup: malý súbor môže mať obrovské rozmery
// a pri dekódovaní zabrať gigabajty pamäte. Všetko cudzie preto otvárame s týmto limitom.
const MAX_PIXELS = 50_000_000;
const untrusted = (input) => sharp(input, { limitInputPixels: MAX_PIXELS });

/**
 * Stiahne (alebo vezme z cache) súbor z URL. Vráti { file, hash }, kde hash je odtlačok obsahu
 * a file je súbor pomenovaný týmto odtlačkom, takže sa pod rukami nikdy nezmení.
 * Záznam o URL (sidecar .json) sa po `origCacheHours` overuje podmieneným GET: fotka vymenená
 * pod rovnakou URL dostane nový hash a tým aj nový výrez a nový výstupný obrázok.
 * Pri výpadku zdroja (sieť, 5xx) sa použije posledná známa verzia.
 */
export async function fetchCached(url, kind) {
  const dir = path.join(config.cacheDir, kind);
  const metaFile = path.join(dir, sha1(url) + '.json');
  const blob = (hash) => path.join(dir, 'c-' + hash);
  const read = async () => {
    try {
      const m = JSON.parse(await fs.readFile(metaFile, 'utf8'));
      return m?.hash && (await exists(blob(m.hash))) ? m : null;
    } catch { return null; }
  };
  const handle = (m, extra) => ({ file: blob(m.hash), hash: m.hash, ...extra });
  const isFresh = (m) => m && Date.now() - m.checkedAt < config.origCacheHours * 3_600_000;

  const hit = await read();
  if (isFresh(hit)) return handle(hit);
  return once(metaFile, async () => {
    const old = await read(); // iný volajúci ho medzitým mohol dokončiť
    if (isFresh(old)) return handle(old);
    // používaná cache nesmie vypadnúť pri upratovaní, ani keď je zdroj dlho nedostupný
    const useStale = async () => { await Promise.all([touch(blob(old.hash)), touch(metaFile)]); return handle(old, { stale: true }); };
    const opts = { timeoutMs: 30000, maxBytes: 25 * 1024 * 1024 };
    const plain = { 'User-Agent': 'FeedBridge/1.0' };
    const conditional = { ...plain };
    if (old?.etag) conditional['If-None-Match'] = old.etag;
    else if (old?.lastModified) conditional['If-Modified-Since'] = old.lastModified;
    let res;
    try {
      res = await safeFetch(url, { ...opts, headers: conditional });
      // ETag patrí konkrétnej cieľovej adrese; ak presmerovanie teraz vedie inam, 304 nič nehovorí
      if (res.status === 304 && (!old || res.url !== old.finalUrl)) res = await safeFetch(url, { ...opts, headers: plain });
    } catch (e) {
      if (old && e.code !== 'EBLOCKED') return useStale(); // výpadok siete
      throw e;
    }
    if (res.status !== 304 && !res.ok) {
      // 5xx je dočasný výpadok; 4xx znamená, že fotka zmizla, starú verziu už nepodsúvame
      if (old && res.status >= 500) return useStale();
      throw new Error(`Stiahnutie obrázka zlyhalo (${res.status}): ${url}`);
    }
    if (res.status === 304 && !old) throw new Error(`Stiahnutie obrázka zlyhalo (304 bez cache): ${url}`);
    const unchanged = res.status === 304;
    const hash = unchanged ? old.hash : sha1(res.body);
    if (unchanged || (await exists(blob(hash)))) await touch(blob(hash));
    else await writeAtomic(blob(hash), res.body);
    const meta = {
      hash,
      finalUrl: res.url,
      etag: unchanged ? old.etag : res.headers.get('etag') || '',
      lastModified: unchanged ? old.lastModified : res.headers.get('last-modified') || '',
      checkedAt: Date.now(),
    };
    await writeAtomic(metaFile, JSON.stringify(meta));
    return handle(meta);
  });
}

// ---------------------------------------------------------------- vyrezanie produktu

/** Lokálne a zadarmo: vyplní od okrajov všetko "takmer biele" a spraví z toho priehľadnosť. */
async function cutoutWhiteKey(buf, threshold) {
  // výstup má najviac 2000 px, väčší vstup len zbytočne žerie pamäť pri vypĺňaní
  const fit = () => untrusted(buf).rotate().resize(2400, 2400, { fit: 'inside', withoutEnlargement: true });
  const base = fit();
  const meta = await untrusted(buf).metadata();
  if (meta.hasAlpha) {
    const { data: a } = await fit().ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
    let transparent = 0;
    for (let i = 0; i < a.length; i += 97) if (a[i] < 250) transparent++;
    if (transparent > 20) return fit().png().toBuffer(); // už je vystrihnutý
  }
  const { data, info } = await base
    .flatten({ background: '#ffffff' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const t = threshold;
  const isBg = (i) => data[i] >= t && data[i + 1] >= t && data[i + 2] >= t;
  const bg = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;
  const push = (x, y) => {
    const p = y * w + x;
    if (bg[p] || !isBg(p * 3)) return;
    bg[p] = 1;
    stack[sp++] = p;
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (sp > 0) {
    const p = stack[--sp];
    const x = p % w;
    const y = (p - x) / w;
    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }
  const alpha = Buffer.alloc(w * h);
  for (let p = 0; p < w * h; p++) alpha[p] = bg[p] ? 0 : 255;
  // jemné zjemnenie hrany, aby výrez nebol "zubatý"
  // blur vráti 3 kanály aj pri 1-kanálovom vstupe, preto extractChannel(0)
  const soft = await sharp(alpha, { raw: { width: w, height: h, channels: 1 } })
    .blur(0.8)
    .extractChannel(0)
    .raw()
    .toBuffer();
  return sharp(data, { raw: { width: w, height: h, channels: 3 } })
    .joinChannel(soft, { raw: { width: w, height: h, channels: 1 } })
    .png()
    .toBuffer();
}

async function cutoutRemoveBg(buf) {
  if (!config.removeBgKey) throw new Error('Chýba REMOVEBG_API_KEY');
  const form = new FormData();
  form.append('image_file', new Blob([buf]), 'image.jpg');
  form.append('size', 'auto');
  form.append('format', 'png');
  const res = await fetch('https://api.remove.bg/v1.0/removebg', {
    method: 'POST',
    headers: { 'X-Api-Key': config.removeBgKey },
    body: form,
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) throw new Error(`remove.bg ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

// rembg drží model v pamäti a pri viacerých súbežných požiadavkách spadne na limit,
// preto idú požiadavky po jednej. Po páde sa kontajner sám reštartuje (asi minútu), preto opakovanie.
let rembgQueue = Promise.resolve();
const REMBG_RETRY_MS = Number(process.env.REMBG_RETRY_MS || 30000);

async function cutoutRembg(buf) {
  if (!config.rembgUrl) throw new Error('Chýba REMBG_URL (napr. http://rembg:7000/api/remove)');
  const job = rembgQueue.then(async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        const form = new FormData();
        form.append('file', new Blob([buf]), 'image.jpg');
        form.append('model', config.rembgModel);
        const res = await fetch(config.rembgUrl, { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
        if (!res.ok) throw Object.assign(new Error(`rembg ${res.status}: ${(await res.text()).slice(0, 200)}`), { final: res.status < 500 });
        return Buffer.from(await res.arrayBuffer());
      } catch (e) {
        if (e.final || attempt >= 3) throw e.final ? e : new Error(`rembg nedostupný (${e.cause?.code || e.message})`);
        await new Promise((r) => setTimeout(r, REMBG_RETRY_MS));
      }
    }
  });
  rembgQueue = job.catch(() => {});
  return job;
}

function cutoutFile(orig, s) {
  const provider = s.provider || 'whitekey';
  const key = sha1(`${orig.hash}|${provider}|${provider === 'whitekey' ? Number(s.whiteThreshold) || 238 : ''}`);
  return path.join(config.cacheDir, 'cutouts', key + '.png');
}

/** Výrez produktu (PNG s alfou), cacheovaný podľa obsahu originálu + poskytovateľa. */
async function getCutout(orig, s) {
  const provider = s.provider || 'whitekey';
  const file = cutoutFile(orig, s);
  if (await exists(file)) return fs.readFile(file);
  return once(file, async () => {
    if (await exists(file)) return fs.readFile(file);
    const src = await fs.readFile(orig.file);
    let buf;
    if (provider === 'removebg') buf = await cutoutRemoveBg(src);
    else if (provider === 'magnific') buf = await magnificRemoveBackground(`${config.publicUrl}/src/${orig.hash}.jpg`); // API si fotku sťahuje samo, WebP nevie
    else if (provider === 'rembg') buf = await cutoutRembg(src);
    else if (provider === 'none') buf = await untrusted(src).rotate().png().toBuffer();
    else buf = await cutoutWhiteKey(src, Number(s.whiteThreshold) || 238);
    await writeAtomic(file, buf);
    return buf;
  });
}

const AI_PROVIDERS = ['removebg', 'rembg', 'magnific'];
const BORDER_TOLERANCE = 10; // o koľko sa smie pixel okraja líšiť od mediánu, aby sa rátal ako pozadie

/**
 * Originál z cache ako JPEG na verejnej adrese /src/<hash>.jpg. Potrebuje ho provider,
 * ktorý si fotku sťahuje sám a nevie WebP. Vráti null, ak taký originál v cache nie je.
 */
export async function originalJpeg(hash) {
  if (!/^[0-9a-f]{40}$/.test(hash)) return null;
  const file = path.join(config.cacheDir, 'orig', 'c-' + hash);
  if (!(await exists(file))) return null;
  // prevod sa robí raz a ukladá: adresa je verejná, opakované volania nesmú zaťažovať procesor
  const converted = path.join(config.cacheDir, 'orig', 'j-' + hash + '.jpg');
  if (await exists(converted)) return fs.readFile(converted);
  return once(converted, async () => {
    const jpg = await untrusted(await fs.readFile(file)).rotate().flatten({ background: '#ffffff' })
      .resize(4096, 4096, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
    await writeAtomic(converted, jpg);
    return jpg;
  });
}

/**
 * auto: produktová fotka na čistom pozadí sa vystrihne, lifestyle fotka sa nechá celá
 * a položí sa na pozadie ako karta. Lokálny výrez (whitekey) vie len takmer bielu,
 * AI výrez zvládne akékoľvek jednofarebné štúdiové pozadie (béžové, sivé…).
 */
/**
 * Okraj fotky na zmenšenine 64×64: podiel takmer bielych pixelov, medián farby a podiel pixelov
 * blízko mediánu (jednofarebné štúdiové pozadie má 0.85-1.00, lifestyle fotka pod 0.55).
 */
async function borderStats(src, whiteThreshold = 238) {
  const n = 64;
  const px = await untrusted(src).rotate().flatten({ background: '#ffffff' }).resize(n, n, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const border = [[], [], []];
  let white = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (x > 1 && x < n - 2 && y > 1 && y < n - 2) continue; // len okrajový pás
      const i = (y * n + x) * 3;
      if (px[i] >= whiteThreshold && px[i + 1] >= whiteThreshold && px[i + 2] >= whiteThreshold) white++;
      for (let c = 0; c < 3; c++) border[c].push(px[i + c]);
    }
  }
  const total = border[0].length;
  const median = border.map((ch) => [...ch].sort((p, q) => p - q)[total >> 1]);
  let close = 0;
  for (let k = 0; k < total; k++) {
    if (border.every((ch, c) => Math.abs(ch[k] - median[c]) <= BORDER_TOLERANCE)) close++;
  }
  return { white: white / total, uniform: close / total, median };
}

async function resolveMode(orig, s) {
  if (s.mode === 'photo') return 'photo';
  if (s.mode !== 'auto') return 'cutout';
  const src = await fs.readFile(orig.file);
  const meta = await untrusted(src).metadata();
  if (meta.hasAlpha) {
    const n = 64;
    const a = await untrusted(src).rotate().resize(n, n, { fit: 'fill' }).ensureAlpha().extractChannel(3).raw().toBuffer();
    let clear = 0;
    for (const v of a) if (v < 250) clear++;
    if (clear > n) return 'cutout';
  }
  const st = await borderStats(src, Number(s.whiteThreshold) || 238);
  if (st.white >= 0.85) return 'cutout';
  if (!AI_PROVIDERS.includes(s.provider)) return 'photo';
  return st.uniform >= 0.8 ? 'cutout' : 'photo'; // jednofarebný okraj = štúdiová fotka
}

// ---------------------------------------------------------------- pozadie

function hex(c, fallback = '#ffffff') {
  return /^#[0-9a-f]{6}$/i.test(c || '') ? c : fallback;
}

export function validAssetName(name) {
  return typeof name === 'string' && /^[a-z0-9][a-z0-9._-]{0,80}\.(jpg|jpeg|png|webp)$/.test(name);
}

/** Zdrojový súbor obrázkového pozadia (knižnica alebo URL) + odtlačok do cache kľúča. */
async function backgroundSource(bg) {
  if (bg?.type !== 'image') return null;
  if (bg.asset) {
    if (!validAssetName(bg.asset)) throw new Error(`Neplatný názov pozadia: ${bg.asset}`);
    const file = path.join(config.assetsDir, bg.asset);
    let st;
    try { st = await fs.stat(file); } catch { throw new Error(`Pozadie „${bg.asset}“ v knižnici neexistuje`); }
    return { file, hash: `asset:${bg.asset}:${st.size}:${Math.round(st.mtimeMs)}` };
  }
  if (bg.url) return fetchCached(bg.url, 'bg');
  return null;
}

async function makeBackground(bg, size, source) {
  const type = bg?.type || 'color';
  if (type === 'gradient') {
    const angle = ((Number(bg.angle) || 160) * Math.PI) / 180;
    const x = Math.sin(angle) / 2, y = -Math.cos(angle) / 2;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <defs><linearGradient id="g" x1="${0.5 - x}" y1="${0.5 - y}" x2="${0.5 + x}" y2="${0.5 + y}">
      <stop offset="0" stop-color="${hex(bg.color)}"/><stop offset="1" stop-color="${hex(bg.color2)}"/></linearGradient></defs>
      <rect width="100%" height="100%" fill="url(#g)"/></svg>`;
    return sharp(Buffer.from(svg)).jpeg().toBuffer();
  }
  if (type === 'image' && source) {
    return untrusted(await fs.readFile(source.file)).rotate().resize(size, size, { fit: 'cover' }).jpeg().toBuffer();
  }
  return sharp({ create: { width: size, height: size, channels: 3, background: hex(bg?.color, '#f4efe9') } })
    .jpeg()
    .toBuffer();
}

function pickBackground(item, s) {
  for (const b of s.backgrounds || []) {
    if (b && b.background && testWhen(item, b.when)) return b.background;
  }
  return s.background;
}

// ---------------------------------------------------------------- kompozícia

/** base=background: pôvodná výmena pozadia; base=photo: pôvodná fotka. Badge je vrstva navrch oboch. */
const usesBackground = (s) => s.base === 'background';
const clampSize = (s) => Math.min(2000, Math.max(500, Number(s.size) || 1080));
const RATIOS = { '1:1': 1, '4:5': 1.25, '7:8': 8 / 7 };
/** Plátno pôvodnej fotky: šírka = veľkosť, výška podľa pomeru strán. Výmena pozadia je vždy štvorec. */
function canvasOf(s) {
  const w = clampSize(s);
  return { w, h: usesBackground(s) ? w : Math.round(w * (RATIOS[s.ratio] || 1)) };
}

function layout(s) {
  const size = clampSize(s);
  const padRaw = Number(s.padding);
  const pad = Math.min(0.4, Math.max(0, Number.isFinite(padRaw) ? padRaw : 0.1));
  return { size, box: Math.round(size * (1 - 2 * pad)), offset: Math.round((Number(s.offsetY) || 0) * size) };
}

// s textom (badge) bez podvzorkovania farieb, inak sú hrany číslic na farebnom podklade rozmazané
const jpeg = (img, s, sharpText = false) => img.jpeg({
  quality: Math.min(100, Math.max(50, Number(s.quality) || 88)), mozjpeg: true, ...(sharpText ? { chromaSubsampling: '4:4:4' } : {}),
}).toBuffer();

/** Výrez produktu na pozadí, voliteľne s tieňom pod produktom. */
async function composeCutout(cutoutBuf, bg, s, overlay = []) {
  const { size, box, offset } = layout(s);
  const trimmed = await untrusted(cutoutBuf).trim({ threshold: 5 }).toBuffer().catch(() => cutoutBuf);
  const prod = await untrusted(trimmed).resize(box, box, { fit: 'inside' }).png().toBuffer();
  const pm = await sharp(prod).metadata();
  const left = Math.round((size - pm.width) / 2);
  const top = Math.max(0, Math.min(size - pm.height, Math.round((size - pm.height) / 2 + offset)));

  const layers = [];
  if (s.shadow) {
    const sw = Math.round(pm.width * 0.8);
    const sh = Math.max(12, Math.round(pm.height * 0.07));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${sw + 80}" height="${sh + 80}">
      <defs><filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${Math.max(6, sh / 2)}"/></filter></defs>
      <ellipse cx="${(sw + 80) / 2}" cy="${(sh + 80) / 2}" rx="${sw / 2}" ry="${sh / 2}" fill="#000" fill-opacity="0.28" filter="url(#b)"/></svg>`;
    layers.push({
      input: Buffer.from(svg),
      left: Math.max(0, Math.round((size - (sw + 80)) / 2)),
      top: Math.max(0, Math.min(size - (sh + 80), Math.round(top + pm.height - sh))),
    });
  }
  layers.push({ input: prod, left, top }, ...overlay);
  return jpeg(sharp(bg).composite(layers), s, overlay.length > 0);
}

/** Celá fotka ako karta so zaoblenými rohmi (lifestyle zábery, kde výrez nedáva zmysel). */
async function composePhoto(photoBuf, bg, s, overlay = []) {
  const { size, box, offset } = layout(s);
  const raw = await untrusted(photoBuf).rotate().flatten({ background: '#ffffff' }).resize(box, box, { fit: 'inside' }).png().toBuffer();
  const pm = await sharp(raw).metadata();
  const r = Math.round(size * 0.03);
  const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${pm.width}" height="${pm.height}"><rect width="${pm.width}" height="${pm.height}" rx="${r}" ry="${r}"/></svg>`);
  const card = await sharp(raw).ensureAlpha().composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
  const left = Math.round((size - pm.width) / 2);
  const top = Math.max(0, Math.min(size - pm.height, Math.round((size - pm.height) / 2 + offset)));

  const layers = [];
  if (s.shadow) {
    const blur = Math.round(size * 0.02);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <defs><filter id="b" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${blur}"/></filter></defs>
      <rect x="${left}" y="${top + Math.round(size * 0.012)}" width="${pm.width}" height="${pm.height}" rx="${r}" ry="${r}" fill="#000" fill-opacity="0.3" filter="url(#b)"/></svg>`;
    layers.push({ input: Buffer.from(svg), left: 0, top: 0 });
  }
  layers.push({ input: card, left, top }, ...overlay);
  return jpeg(sharp(bg).composite(layers), s, overlay.length > 0);
}

/**
 * Pôvodná fotka na štvorcovom plátne bez zásahu do pozadia (základ pre cenový badge).
 * fit=contain: celá fotka; voľné miesto vyplní farba okraja fotky (štúdiové pozadie tak plynule
 * pokračuje), pri lifestyle fotke jej rozmazaná kópia s mäkkým prechodom. fit=cover: orez na stred.
 * reserve = výška pásu hore/dole, do ktorej fotka nezasahuje (päta s cenou produkt nezakryje).
 * Vráti PNG plátna.
 */
async function originalCanvas(photoBuf, s, reserve = { top: 0, bottom: 0 }) {
  const { w: size, h: height } = canvasOf(s);
  const areaH = height - reserve.top - reserve.bottom;
  const flat = () => untrusted(photoBuf).rotate().flatten({ background: '#ffffff' });
  const cover = s.fit === 'cover';
  let fg = await flat().resize(size, areaH, { fit: cover ? 'cover' : 'inside' }).png().toBuffer();
  const fm = await sharp(fg).metadata();
  const left = Math.round((size - fm.width) / 2);
  const top = reserve.top + Math.round((areaH - fm.height) / 2);
  if (fm.width === size && fm.height === height) return fg;
  let bg;
  const st = isHex(s.fill) ? null : await borderStats(photoBuf);
  if (isHex(s.fill) || st.uniform >= 0.8) {
    const background = isHex(s.fill) ? s.fill : { r: st.median[0], g: st.median[1], b: st.median[2] };
    bg = await sharp({ create: { width: size, height, channels: 3, background } }).png().toBuffer();
  } else {
    bg = await flat().resize(size, height, { fit: 'cover' }).blur(size / 27).modulate({ brightness: 0.94, saturation: 0.9 }).png().toBuffer();
    // ostrý šev medzi fotkou a rozmazaným okolím pôsobí lacno: voľné hrany fotky sa do okolia rozplynú
    const f = Math.round(size * 0.03);
    const sides = fm.width < size, ends = fm.height < areaH;
    if (sides || ends) {
      const stops = (a, b) => `<stop offset="0" stop-color="#fff" stop-opacity="${a}"/><stop offset="1" stop-color="#fff" stop-opacity="${b}"/>`;
      let m = `<rect width="${fm.width}" height="${fm.height}" fill="#fff"/>`;
      const erase = (x, y, w, h, x1, y1, x2, y2, id) => `<defs><linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stops(1, 0)}</linearGradient></defs>`
        + `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#000"/><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#${id})"/>`;
      if (sides) m += erase(0, 0, f, fm.height, 1, 0, 0, 0, 'l') + erase(fm.width - f, 0, f, fm.height, 0, 0, 1, 0, 'r');
      if (ends) m += erase(0, 0, fm.width, f, 0, 1, 0, 0, 't') + erase(0, fm.height - f, fm.width, f, 0, 0, 0, 1, 'b');
      const mask = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${fm.width}" height="${fm.height}">${m}</svg>`)).extractChannel(0).raw().toBuffer();
      fg = await sharp(fg).removeAlpha().joinChannel(mask, { raw: { width: fm.width, height: fm.height, channels: 1 } }).png().toBuffer();
    }
  }
  return sharp(bg).composite([{ input: fg, left, top }]).png().toBuffer();
}

async function composeOriginal(photoBuf, s, badge) {
  const { w: size, h: height } = canvasOf(s);
  if (!badge) return jpeg(sharp(await originalCanvas(photoBuf, s)), s);
  const strip = badge.preset === 'strip';
  const h = strip ? stripHeight(badge, size) : 0;
  const canvas = await originalCanvas(photoBuf, s, strip ? { top: badge.position === 'top' ? h : 0, bottom: badge.position === 'top' ? 0 : h } : undefined);
  return jpeg(sharp(canvas).composite([{ input: renderBadge(badge, size, height), left: 0, top: 0 }]), s, true);
}

async function render(orig, item, s, bgSource, badge) {
  const size = clampSize(s);
  if (!usesBackground(s)) return composeOriginal(await fs.readFile(orig.file), s, badge);
  const overlay = badge ? [{ input: renderBadge(badge, size, size), left: 0, top: 0 }] : []; // nad vymeneným pozadím leží badge navrchu
  const mode = await resolveMode(orig, s);
  const bg = await makeBackground(pickBackground(item, s), size, bgSource);
  if (mode === 'photo') return composePhoto(await fs.readFile(orig.file), bg, s, overlay);
  return composeCutout(await getCutout(orig, s), bg, s, overlay);
}

/**
 * Čo sa s položkou stane: badge (alebo null) a či sa obrázok vôbec generuje.
 * ctx = { brand, at, campaign, layout, hidePrices, overlay } - akcia a nastavenie produktu
 * (campaigns.js); overlay=false = čistý obrázok bez grafiky (profil "čistý").
 * Pri pôvodnej fotke bez badge sa obrázok nemení, pokiaľ nie je zapnutý jednotný formát.
 */
export function imagePlan(item, s, ctx = {}) {
  const badge = ctx.overlay === false ? null
    : resolveBadge(item, s.badge, ctx.brand, ctx.at, { campaign: ctx.campaign, layout: ctx.layout, hidePrices: ctx.hidePrices });
  return { badge, generate: usesBackground(s) || !!badge || !!s.applyToAll };
}

/** Vyrenderuje obrázok bez zapisovania do verejného priečinka (náhľad v UI). Vráti { jpg, badge }. */
export async function renderPreview(url, item, s, ctx = {}) {
  const orig = await fetchCached(url, 'orig');
  const { badge, generate } = imagePlan(item, s, ctx);
  if (!generate) {
    // produkt, ktorého obrázok sa vo feede nemení: náhľad ukáže pôvodnú fotku, nie vymyslený štvorec
    const size = clampSize(s);
    const jpg = await untrusted(await fs.readFile(orig.file)).rotate().flatten({ background: '#ffffff' })
      .resize(size, size, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
    return { jpg, badge: null, unchanged: true };
  }
  const bgSource = usesBackground(s) ? await backgroundSource(pickBackground(item, s)) : null;
  return { jpg: await render(orig, item, s, bgSource, badge), badge, unchanged: false };
}

/**
 * Vyrobí (alebo znovu použije) obrázok pre položku.
 * Vráti { file, cached } kde file je "slug/hash.jpg", alebo { file: null }, ak sa obrázok nemení.
 */
export async function ensureImage(slug, url, item, s, ctx = {}) {
  const { badge, generate } = imagePlan(item, s, ctx);
  if (!generate) return { file: null, cached: false };
  const background = usesBackground(s);
  const bgSpec = background ? pickBackground(item, s) : null;
  const [orig, bgSource] = await Promise.all([fetchCached(url, 'orig'), background ? backgroundSource(bgSpec) : null]);
  // Kľúč pre výmenu pozadia bez badge je zámerne rovnaký ako v starších verziách (obrázky sa neprerábajú).
  const key = background ? {
    src: orig.hash,
    provider: s.provider,
    mode: s.mode || 'cutout',
    th: s.provider === 'whitekey' || s.mode === 'auto' ? s.whiteThreshold : 0,
    // len tam, kde sa rozhodovanie auto režimu naozaj zmenilo; inak by sa prerobili všetky staršie obrázky
    ...(s.mode === 'auto' && AI_PROVIDERS.includes(s.provider) ? { auto: BORDER_TOLERANCE } : {}),
    size: s.size, padding: s.padding, offsetY: s.offsetY, shadow: s.shadow, quality: s.quality,
    bg: bgSpec,
    bgSrc: bgSource?.hash || '',
  } : {
    src: orig.hash, base: 'photo', size: s.size, fit: s.fit === 'cover' ? 'cover' : 'contain', fill: isHex(s.fill) ? s.fill : 'auto', quality: s.quality,
    ...(RATIOS[s.ratio] && s.ratio !== '1:1' ? { ratio: s.ratio } : {}), // štvorec má kľúč ako doteraz
  };
  if (badge) { const { notes: _n, ...look } = badge; key.badge = look; }
  const name = sha1(JSON.stringify(key)).slice(0, 24) + '.jpg';
  const dir = path.join(config.imagesDir, slug);
  const file = path.join(dir, name);
  if (background) touch(cutoutFile(orig, s)); // používaný výrez nesmie vypadnúť z cache, aj keď sa práve nečíta
  if (await exists(file)) return { file: `${slug}/${name}`, cached: true };
  let created = false; // true len pre volajúceho, ktorý súbor reálne vyrobil
  await once(file, async () => {
    if (await exists(file)) return;
    created = true;
    await fs.mkdir(dir, { recursive: true });
    await writeAtomic(file, await render(orig, item, s, bgSource, badge));
  });
  return { file: `${slug}/${name}`, cached: !created };
}

/**
 * Použitým obrázkom obnoví čas, nepoužívané zmaže až po `retentionDays` od posledného použitia.
 * Meta môže mať starú URL ešte v načítanom feede, hneď po behu sa preto nič nemaže.
 */
export async function pruneImages(slug, usedFiles, retentionDays = config.imageRetentionDays) {
  const dir = path.join(config.imagesDir, slug);
  let names = [];
  try { names = await fs.readdir(dir); } catch { return 0; }
  const limit = Date.now() - retentionDays * DAY;
  let removed = 0;
  for (const n of names) {
    const file = path.join(dir, n);
    if (usedFiles.has(`${slug}/${n}`)) { await touch(file); continue; }
    const st = await fs.stat(file).catch(() => null);
    if (st && st.mtimeMs < limit) {
      await fs.rm(file, { force: true });
      removed++;
    }
  }
  return removed;
}

/** Zmaže súbory z cache (originály, výrezy, pozadia), ktoré sa dlho nepoužili. */
export async function pruneCache(retentionDays = config.cacheRetentionDays) {
  const limit = Date.now() - retentionDays * DAY;
  let removed = 0;
  for (const kind of ['orig', 'cutouts', 'bg']) {
    const dir = path.join(config.cacheDir, kind);
    for (const n of await fs.readdir(dir).catch(() => [])) {
      const file = path.join(dir, n);
      const st = await fs.stat(file).catch(() => null);
      if (st && st.isFile() && st.mtimeMs < limit) {
        await fs.rm(file, { force: true });
        removed++;
      }
    }
  }
  return removed;
}

/** Jednoduchý pool s obmedzenou súbežnosťou. */
export async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= list.length) return;
      out[i] = await fn(list[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
