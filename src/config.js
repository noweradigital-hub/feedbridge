import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { BADGE_DEFAULTS } from './badge.js';

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');

export const config = {
  port: PORT,
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, ''),
  dataDir: DATA_DIR,
  feedsDir: path.join(DATA_DIR, 'feeds'),
  imagesDir: path.join(DATA_DIR, 'images'),
  cacheDir: path.join(DATA_DIR, 'cache'),
  assetsDir: path.join(DATA_DIR, 'assets'), // vlastné pozadia a grafika nahraté cez admin
  dbFile: path.join(DATA_DIR, 'feedbridge.db'),
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  removeBgKey: process.env.REMOVEBG_API_KEY || '',
  rembgUrl: process.env.REMBG_URL || '',
  // Model treba určiť: predvolený model rembg servera (bria-rmbg, 1 GB) má nekomerčnú licenciu a žerie pamäť
  rembgModel: process.env.REMBG_MODEL || 'isnet-general-use',
  magnificKey: process.env.MAGNIFIC_API_KEY || '', // provider "magnific" + generovanie pozadí do knižnice
  imageConcurrency: Number(process.env.IMAGE_CONCURRENCY || 3),
  // Meta si obrázky sťahuje až po načítaní feedu, staré URL preto musia ešte chvíľu žiť
  imageRetentionDays: Number(process.env.IMAGE_RETENTION_DAYS || 7),
  // po tomto čase sa originál overí podmieneným GET (zmenená fotka pod rovnakou URL)
  origCacheHours: Number(process.env.ORIG_CACHE_HOURS || 24),
  cacheRetentionDays: Number(process.env.CACHE_RETENTION_DAYS || 30),
  notifyWebhook: process.env.NOTIFY_WEBHOOK_URL || '', // n8n/Slack webhook pri zmene stavu behu
};

if (!config.adminPassword) {
  config.adminPassword = crypto.randomBytes(9).toString('base64url');
  config.passwordGenerated = true;
}

for (const d of [config.dataDir, config.feedsDir, config.imagesDir, config.cacheDir, config.assetsDir]) {
  fs.mkdirSync(d, { recursive: true });
}
fs.mkdirSync(path.join(config.cacheDir, 'cutouts'), { recursive: true });
fs.mkdirSync(path.join(config.cacheDir, 'orig'), { recursive: true });
fs.mkdirSync(path.join(config.cacheDir, 'bg'), { recursive: true });

/** Predvolená konfigurácia projektu (ukladá sa ako JSON v DB). */
export function defaultProjectConfig() {
  return {
    profiles: [], // doplní normalizeProfiles: aspoň jeden profil so slugom projektu
    rules: [],
    brand: { primary: '#14171c', accent: '#e11d48', font: 'inter' }, // farby a písmo značky pre badge
    campaigns: undefined, // doplní normalizeCampaigns: Black Friday, Vianoce, Výpredaj
    products: {}, // nastavenia jednotlivých produktov podľa zdrojového ID
    groups: {}, // to isté pre celé skupiny variantov (item_group_id), platí aj pre budúce varianty
    images: {
      enabled: false,
      base: 'photo', // photo = pôvodná fotka | background = výmena pozadia (nastavenia nižšie)
      ratio: '1:1', // pomer strán plátna: 1:1 (bezpečný pre dlaždice Mety) | 4:5 | 7:8
      fit: 'contain', // contain = celá fotka na plátne | cover = orez na stred
      fill: 'auto', // farba voľného miesta pri contain: auto alebo #rrggbb
      applyToAll: false, // aj produkty bez badge dostanú jednotný štvorcový formát
      badge: { ...BADGE_DEFAULTS },
      provider: 'whitekey', // whitekey | rembg | magnific | removebg | none
      mode: 'cutout', // cutout = výrez na pozadí | photo = celá fotka ako karta | auto = podľa okrajov fotky
      whiteThreshold: 238,
      size: 1080,
      padding: 0.1,
      offsetY: 0,
      shadow: true,
      quality: 88,
      keepOriginalAsAdditional: true,
      background: { type: 'color', color: '#f4efe9', color2: '#dfe8ee', angle: 160, url: '', asset: '' },
      backgrounds: [], // [{ when:[...], background:{...} }] - prvá zhoda vyhráva
    },
    safety: {
      maxDropPct: 50, // max. pokles počtu položiek oproti poslednému feedu, inak beh skončí chybou (0 = vypnuté)
    },
  };
}
