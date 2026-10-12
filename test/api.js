// Smoke test HTTP vrstvy: auth, CRUD projektov, beh, verejný feed a obrázky, náhľady.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import sharp from 'sharp';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feedbridge-api-'));
process.env.DATA_DIR = tmp;
process.env.ADMIN_PASSWORD = 'tajne';
process.env.ALLOW_PRIVATE_FETCH = '1'; // fixture servery bežia na 127.0.0.1
process.env.PORT = '0';

const productJpg = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640">
  <rect width="640" height="640" fill="#fff"/><circle cx="320" cy="320" r="200" fill="#8e44ad"/></svg>`)).jpeg().toBuffer();

const source = http.createServer((req, res) => {
  const b = `http://127.0.0.1:${source.address().port}`;
  if (req.url === '/feed.xml') {
    res.setHeader('Content-Type', 'application/xml');
    return res.end(`<?xml version="1.0"?><rss xmlns:g="http://base.google.com/ns/1.0" version="2.0"><channel><title>T</title><link>https://x.test</link><description>d</description>
      <item><g:id>1</g:id><title>Test</title><description>Popis</description><link>https://x.test/1</link><g:image_link>${b}/p.jpg</g:image_link><g:price>10.00 EUR</g:price><g:availability>in stock</g:availability><g:condition>new</g:condition><g:brand>Demo</g:brand></item></channel></rss>`);
  }
  if (req.url === '/p.jpg') { res.setHeader('Content-Type', 'image/jpeg'); return res.end(productJpg); }
  res.statusCode = 404; res.end();
});
await new Promise((r) => source.listen(0, '127.0.0.1', r));
const srcUrl = `http://127.0.0.1:${source.address().port}/feed.xml`;

const { start } = await import('../src/server.js');
const server = start();
await new Promise((r) => server.on('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const auth = { Authorization: 'Basic ' + Buffer.from('admin:tajne').toString('base64') };
const api = (p, opts = {}) => fetch(base + '/api' + p, {
  method: opts.method || 'GET',
  headers: { ...auth, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
  body: opts.body ? JSON.stringify(opts.body) : undefined,
});

let failed = 0;
const t = async (name, fn) => {
  try { await fn(); console.log('  ok  ', name); } catch (e) { failed++; console.log('  FAIL', name, '\n      ', e.message); }
};

await t('admin bez hesla = 401, so zlým heslom = 401', async () => {
  assert.equal((await fetch(base + '/api/projects')).status, 401);
  assert.equal((await fetch(base + '/api/projects', { headers: { Authorization: 'Basic ' + Buffer.from('admin:zle').toString('base64') } })).status, 401);
  assert.equal((await fetch(base + '/admin/')).status, 401);
});
await t('UI sa servíruje po prihlásení', async () => {
  const r = await fetch(base + '/admin/', { headers: auth });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /FeedBridge/);
});

let proj;
await t('vytvorenie projektu + validácia slugu', async () => {
  const bad = await api('/projects', { method: 'POST', body: { name: 'X', slug: '../etc' } });
  assert.equal(bad.status, 400);
  const res = await api('/projects', { method: 'POST', body: { name: 'Demo', slug: 'demo', source_url: srcUrl } });
  assert.equal(res.status, 201);
  proj = await res.json();
  assert.match(proj.feed_url, /\/feeds\/demo\.xml$/);
  const dup = await api('/projects', { method: 'POST', body: { name: 'Iný', slug: 'demo' } });
  assert.equal(dup.status, 409);
});

await t('uloženie pravidiel a nastavení obrázkov', async () => {
  proj.config.rules = [
    { type: 'set', field: 'title', value: 'Demo | {title}' },
    { type: 'set', field: 'custom_label_0', value: 'test' },
  ];
  proj.config.images = { ...proj.config.images, enabled: true, size: 500, background: { type: 'color', color: '#ddeeff' } };
  const res = await api('/projects/' + proj.id, { method: 'PUT', body: proj });
  assert.equal(res.status, 200);
  proj = await res.json();
  assert.equal(proj.config.rules.length, 2);
});

await t('náhľad pravidiel', async () => {
  const res = await api(`/projects/${proj.id}/preview`, { method: 'POST', body: {} });
  const d = await res.json();
  assert.equal(d.total, 1);
  assert.equal(d.rows[0].result.title, 'Demo | Test');
  assert.deepEqual(d.rows[0].issues, []);
});

await t('náhľad obrázka vráti JPEG správnej veľkosti', async () => {
  const res = await api(`/projects/${proj.id}/preview-image`, { method: 'POST', body: { index: 0 } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
  assert.equal(meta.width, 500);
});

await t('beh projektu cez API, potom verejný feed a obrázok bez hesla', async () => {
  const r = await api(`/projects/${proj.id}/run`, { method: 'POST' });
  assert.equal(r.status, 202);
  let p;
  for (let i = 0; i < 50; i++) {
    p = await (await api('/projects/' + proj.id)).json();
    if (!p.running && p.last_status) break;
    await new Promise((x) => setTimeout(x, 100));
  }
  assert.equal(p.last_status, 'ok', JSON.stringify(p.last_summary));
  const feed = await fetch(base + '/feeds/demo.xml'); // verejné, bez auth
  assert.equal(feed.status, 200);
  const xml = await feed.text();
  assert.match(xml, /<title>Demo \| Test<\/title>/);
  assert.match(xml, /<g:custom_label_0>test<\/g:custom_label_0>/);
  const m = xml.match(/<g:image_link>([^<]+)<\/g:image_link>/);
  assert.ok(m, 'chýba image_link');
  const imgPath = new URL(m[1]).pathname; // /img/demo/xxxx.jpg
  const img = await fetch(base + imgPath);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
});

await t('path traversal cez feeds/img nefunguje', async () => {
  assert.equal((await fetch(base + '/feeds/..%2f..%2fetc%2fpasswd')).status, 404);
  assert.notEqual((await fetch(base + '/img/..%2f..%2ffeedbridge.db')).status, 200);
  assert.equal((await fetch(base + '/feeds/neexistuje.xml')).status, 404);
});

await t('knižnica pozadí: nahratie, zoznam, odmietnutie ne-obrázka a zlého názvu, zmazanie', async () => {
  const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#123456' } }).png().toBuffer();
  const put = (name, body, type = 'image/png') => fetch(`${base}/api/assets/${name}`, { method: 'PUT', headers: { ...auth, 'Content-Type': type }, body });
  assert.equal((await put('pozadie-1.png', png)).status, 201);
  assert.deepEqual((await (await api('/assets')).json()).map((a) => a.name), ['pozadie-1.png']);
  assert.equal((await api('/assets/pozadie-1.png')).headers.get('content-type'), 'image/png');
  assert.equal((await put('zly.png', Buffer.from('<?php echo 1;'))).status, 400);
  assert.equal((await put('..%2F..%2Fx.png', png)).status, 400);
  assert.equal((await put('skript.php', png)).status, 400);
  assert.equal((await fetch(`${base}/api/assets/pozadie-1.png`)).status, 401); // bez hesla
  assert.equal((await api('/assets/pozadie-1.png', { method: 'DELETE' })).status, 200);
  assert.deepEqual(await (await api('/assets')).json(), []);
});

await t('výstup projektu pre galériu zodpovedá zverejnenému feedu', async () => {
  const out = await (await api(`/projects/${proj.id}/output`)).json();
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].id, '1');
  assert.match(out.items[0].image_link, /\/img\/demo\//);
  assert.equal(out.items[0].labels.custom_label_0, 'test');
  assert.ok(out.generated_at);
});

await t('slug sa po vytvorení nedá zmeniť', async () => {
  const r = await api('/projects/' + proj.id, { method: 'PUT', body: { ...proj, slug: 'iny-slug' } });
  assert.equal(r.status, 409);
  assert.equal((await (await api('/projects/' + proj.id)).json()).slug, 'demo');
});

await t('zlyhaný zdroj nechá predchádzajúci feed a beh skončí ako error', async () => {
  proj.source_url = 'http://127.0.0.1:1/nic.xml';
  await api('/projects/' + proj.id, { method: 'PUT', body: proj });
  await api(`/projects/${proj.id}/run`, { method: 'POST' });
  let p;
  for (let i = 0; i < 80; i++) {
    p = await (await api('/projects/' + proj.id)).json();
    if (!p.running && p.last_status === 'error') break;
    await new Promise((x) => setTimeout(x, 100));
  }
  assert.equal(p.last_status, 'error');
  assert.equal((await fetch(base + '/feeds/demo.xml')).status, 200);
});

await t('duplikovanie a mazanie projektu', async () => {
  const dup = await (await api(`/projects/${proj.id}/duplicate`, { method: 'POST' })).json();
  assert.equal(dup.slug, 'demo-kopia');
  assert.equal(dup.enabled, false);
  assert.equal((await api('/projects/' + dup.id, { method: 'DELETE' })).status, 200);
  assert.equal((await api('/projects/' + proj.id, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(base + '/feeds/demo.xml')).status, 404);
});

server.close();
source.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} test(ov) zlyhalo` : '\nVšetko prešlo');
process.exit(failed ? 1 : 0);
