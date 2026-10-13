// Text ako vektorové krivky z pribalených fontov (opentype.js).
// V Docker image nie sú systémové fonty a librsvg by text nevykreslil; krivky sú navyše
// rovnaké na každom stroji a dajú sa presne zmerať, čo potrebuje rozloženie badge.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fonts');

export const FONTS = {
  inter: { label: 'Inter (neutrálny)', file: 'inter' },
  manrope: { label: 'Manrope (geometrický)', file: 'manrope' },
  'barlow-condensed': { label: 'Barlow Condensed (úzky)', file: 'barlow-condensed' },
};
export const fontOf = (name) => (FONTS[name] ? name : 'inter');

const cache = new Map();
/** Rez písma = základná latinka + rozšírená (diakritika, Kč, zł); znak sa hľadá postupne v oboch. */
function face(family, weight) {
  const key = `${fontOf(family)}-${weight >= 700 ? 800 : 600}`;
  if (!cache.has(key)) {
    const [name, w] = [FONTS[fontOf(family)].file, weight >= 700 ? 800 : 600];
    cache.set(key, ['latin', 'latin-ext'].map((sub) => {
      const b = fs.readFileSync(path.join(DIR, `${name}-${sub}-${w}-normal.woff`));
      return opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    }));
  }
  return cache.get(key);
}

/**
 * Rozloží text na glyfy s prirodzenými šírkami písma (obrázok je statický, číslice
 * nemusia držať stĺpce a tabuľkové šírky by cenu zbytočne roztiahli).
 * Vráti { width, digitHeight, d(x, baselineY) }. size = veľkosť písma v px;
 * medzera = úzka medzera (0.22 em), nie plná.
 */
export function layoutText(text, { family = 'inter', weight = 800, size = 100, tracking = 0 } = {}) {
  const fonts = face(family, weight);
  const main = fonts[0];
  const scale = size / main.unitsPerEm;
  const glyphs = [];
  let x = 0;
  let prev = null;
  for (const ch of String(text).normalize('NFC')) {
    if (ch === ' ' || ch === '\u00a0') { x += size * 0.22; prev = null; continue; }
    const font = fonts.find((f) => f.charToGlyphIndex(ch) !== 0);
    if (!font) continue; // znak, ktorý font nemá, vynecháme (namiesto prázdneho štvorčeka)
    const glyph = font.charToGlyph(ch);
    const s1 = size / font.unitsPerEm;
    if (prev && prev.font === font) x += font.getKerningValue(prev.glyph, glyph) * s1;
    glyphs.push({ glyph, x });
    x += glyph.advanceWidth * s1 + tracking;
    prev = { font, glyph };
  }
  const width = Math.max(0, x - tracking);
  // výška číslic = výška verzálok (v týchto fontoch sedí), meriame z glyfu "0"
  const zero = main.charToGlyph('0').getBoundingBox();
  const digitHeight = (zero.y2 - zero.y1) * scale;
  return {
    width,
    digitHeight,
    d(x0, baseline) {
      return glyphs.map(({ glyph, x: gx }) => glyph.getPath(x0 + gx, baseline, size).toPathData(1)).join('');
    },
  };
}

/** Veľkosť písma, pri ktorej majú číslice požadovanú výšku v px. */
export function sizeForDigitHeight(px, family, weight) {
  const main = face(family, weight)[0];
  const zero = main.charToGlyph('0').getBoundingBox();
  return px / ((zero.y2 - zero.y1) / main.unitsPerEm);
}
