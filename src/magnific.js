// Magnific API (https://docs.magnific.com): odstránenie pozadia a generovanie obrázkov.
// Kľúč je v MAGNIFIC_API_KEY; výsledky sa sťahujú hneď, ich URL platia len pár minút.
import { config } from './config.js';
import { safeFetch } from './net.js';

const API = 'https://api.magnific.com/v1/ai';

function authHeaders(extra = {}) {
  if (!config.magnificKey) throw new Error('Chýba MAGNIFIC_API_KEY');
  return { 'x-magnific-api-key': config.magnificKey, ...extra };
}

async function call(path, init = {}) {
  const res = await fetch(API + path, { ...init, headers: authHeaders(init.headers), signal: AbortSignal.timeout(60000) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* nie je JSON */ }
  if (!res.ok) throw new Error(`Magnific ${res.status}: ${String(json?.message || text).slice(0, 200)}`);
  return json;
}

async function download(url) {
  const res = await safeFetch(url, { timeoutMs: 60000, maxBytes: 40 * 1024 * 1024 });
  if (!res.ok) throw new Error(`Magnific: výsledok sa nepodarilo stiahnuť (HTTP ${res.status})`);
  return res.body;
}

/**
 * Odstráni pozadie. API si obrázok sťahuje samo z `imageUrl`, takže adresa musí byť
 * verejná a vo formáte JPG/PNG (do 20 MB). Vráti PNG s priehľadnosťou.
 */
export async function removeBackground(imageUrl) {
  const json = await call('/beta/remove-background', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ image_url: imageUrl }),
  });
  const url = json?.high_resolution || json?.url;
  if (!url) throw new Error('Magnific: odpoveď neobsahuje výsledný obrázok');
  return download(url);
}

/** Vygeneruje obrázok z textu (Seedream 4). Úloha je asynchrónna, čaká sa na dokončenie. */
export async function generateImage(prompt, { aspectRatio = 'square_1_1', timeoutMs = 120000 } = {}) {
  const created = await call('/text-to-image/seedream-v4', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, aspect_ratio: aspectRatio }),
  });
  const id = created?.data?.task_id;
  if (!id) throw new Error('Magnific: úloha sa nevytvorila');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const data = (await call(`/text-to-image/seedream-v4/${id}`))?.data;
    if (data?.status === 'COMPLETED' && data.generated?.[0]) return download(data.generated[0]);
    if (data?.status === 'FAILED') throw new Error(`Magnific: generovanie zlyhalo${data.error ? ` (${data.error})` : ''}`);
    if (Date.now() > deadline) throw new Error('Magnific: generovanie trvá príliš dlho');
    await new Promise((r) => setTimeout(r, 3000));
  }
}
