// Samostatný test: vyrobí syntetický Woo feed + obrázky, spustí pipeline a skontroluje výstup.
// Spustenie: npm test   (nepotrebuje internet ani API kľúče)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import sharp from 'sharp';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feedbridge-'));
process.env.DATA_DIR = tmp;
process.env.PUBLIC_URL = 'https://feeds.example.test';
process.env.ADMIN_PASSWORD = 'test';
process.env.ALLOW_PRIVATE_FETCH = '1'; // fixture servery bežia na 127.0.0.1
process.env.REMBG_RETRY_MS = '50';

const { projects } = await import('../src/db.js');
const { runProject } = await import('../src/feed/pipeline.js');
const { parseFeed } = await import('../src/feed/parse.js');
const { applyRules, renderTemplate, parsePrice, checkItem, testWhen } = await import('../src/feed/rules.js');
const { ensureImage, pruneImages, pruneCache, renderPreview, fetchCached } = await import('../src/images.js');
const { safeFetch, isPublicAddress } = await import('../src/net.js');
const { notifyRun } = await import('../src/notify.js');
const { config } = await import('../src/config.js');
const { runs, recoverStaleRuns, versions, default: db } = await import('../src/db.js');

// --- syntetické obrázky: farebný "produkt" na bielom pozadí
async function productJpg(color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">
    <rect width="800" height="600" fill="#fff"/><rect x="220" y="120" width="360" height="360" rx="40" fill="${color}"/>
    <circle cx="400" cy="300" r="70" fill="#fff"/></svg>`;
  return sharp(Buffer.from(svg)).jpeg().toBuffer();
}
const images = { 'a.jpg': await productJpg('#c0392b'), 'b.jpg': await productJpg('#2980b9'), 'c.jpg': await productJpg('#27ae60') };
images['swap.jpg'] = images['a.jpg'];
images['flaky.jpg'] = images['c.jpg'];
// "lifestyle" fotka: farebné pozadie až po okraj, výrez by nedával zmysel
images['life.jpg'] = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#8a6d4b"/><rect x="200" y="150" width="400" height="300" fill="#d9c7a3"/></svg>')).jpeg().toBuffer();

const feedXml = (base) => `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0"><channel>
<title>Demo</title><link>https://example.test</link><description>feed</description>
<item><g:id>001</g:id><title><![CDATA[Drevená hračka & vláčik]]></title>
<description><![CDATA[<p>Pekný <strong>vláčik</strong> z dreva.&nbsp;Ideálny darček.</p>]]></description>
<link>https://example.test/vlacik</link><g:image_link>${base}/a.jpg</g:image_link>
<g:additional_image_link>${base}/b.jpg</g:additional_image_link>
<g:price>29,90 EUR</g:price><g:sale_price>23.92 EUR</g:sale_price><g:availability>in stock</g:availability>
<g:brand>Hračkáreň</g:brand><g:product_type>Hračky &gt; Drevené</g:product_type><g:condition>new</g:condition>
<g:shipping><g:country>SK</g:country><g:price>3.00 EUR</g:price></g:shipping></item>
<item><g:id>002</g:id><title>Plyšový medveď</title><description>Mäkký medveď</description>
<link>https://example.test/medved</link><g:image_link>${base}/b.jpg</g:image_link>
<g:price>12.00 EUR</g:price><g:availability>out of stock</g:availability><g:brand>Plyšáci</g:brand>
<g:product_type>Hračky &gt; Plyšové</g:product_type></item>
<item><g:id>003</g:id><title>Body s dlhým rukávom</title><description></description>
<link>https://example.test/body</link><g:image_link>${base}/c.jpg</g:image_link>
<g:price>9.50 EUR</g:price><g:availability>in stock</g:availability>
<g:product_type>Oblečenie &gt; Body</g:product_type></item>
</channel></rss>`;

const hits = {};
const hooks = [];
let swapVersion = 1;
let blockedPort = 1;
let movingTarget = '/same-etag-a.jpg';
let flakyDown = false;
let hugePng = null;
const server = http.createServer((req, res) => {
  const base = `http://127.0.0.1:${server.address().port}`;
  if (req.url === '/feed.xml') { res.setHeader('Content-Type', 'application/xml'); return res.end(feedXml(base)); }
  if (req.url === '/redirect-internal') { res.statusCode = 302; res.setHeader('Location', `http://127.0.0.1:${blockedPort}/a.jpg`); return res.end(); }
  if (req.url === '/hook') { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { hooks.push(JSON.parse(b)); res.end('ok'); }); return; }
  if (req.url === '/moving') { res.statusCode = 302; res.setHeader('Location', movingTarget); return res.end(); }
  if (req.url === '/same-etag-a.jpg' || req.url === '/same-etag-b.jpg') {
    res.setHeader('ETag', '"same"');
    if (req.headers['if-none-match'] === '"same"') { res.statusCode = 304; return res.end(); }
    res.setHeader('Content-Type', 'image/jpeg'); return res.end(images[req.url.endsWith('a.jpg') ? 'a.jpg' : 'b.jpg']);
  }
  if (req.url === '/flaky.jpg' && flakyDown) { res.statusCode = 503; return res.end(); }
  if (req.url === '/huge.png') { res.setHeader('Content-Type', 'image/png'); return res.end(hugePng); }
  const img = images[req.url.slice(1)];
  if (img) hits[req.url] = (hits[req.url] || 0) + 1;
  if (img && req.url === '/swap.jpg') {
    const etag = '"v' + swapVersion + '"';
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) { res.statusCode = 304; return res.end(); }
    res.setHeader('Content-Type', 'image/jpeg'); return res.end(swapVersion === 1 ? images['a.jpg'] : images['b.jpg']);
  }
  if (img) { res.setHeader('Content-Type', 'image/jpeg'); return res.end(img); }
  res.statusCode = 404; res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let failed = 0;
const t = async (name, fn) => {
  try { await fn(); console.log('  ok  ', name); } catch (e) { failed++; console.log('  FAIL', name, '\n      ', e.message); }
};

console.log('Jednotkové testy');
await t('parsePrice zvláda čiarku aj tisíce', () => {
  assert.deepEqual(parsePrice('29,90 EUR'), { amount: 29.9, currency: 'EUR' });
  assert.deepEqual(parsePrice('1 234,50 CZK'), { amount: 1234.5, currency: 'CZK' });
  assert.deepEqual(parsePrice('1,234.50 USD'), { amount: 1234.5, currency: 'USD' });
});
await t('parse: entity, CDATA, vnorené shipping, opakované additional_image_link', async () => {
  const { items } = parseFeed(feedXml(base));
  assert.equal(items.length, 3);
  assert.equal(items[0].title, 'Drevená hračka & vláčik');
  assert.equal(items[0].id, '001');
  assert.deepEqual(items[0].additional_image_link, [`${base}/b.jpg`]);
  assert.equal(items[0].shipping[0].country, 'SK');
});
await t('šablóna s filtrami', () => {
  const it = { brand: 'Hračkáreň', title: 'vláčik', product_type: 'Hračky > Drevené' };
  assert.equal(renderTemplate('{brand} – {title|title} ({product_type|last_category})', it), 'Hračkáreň – Vláčik (Drevené)');
  assert.equal(renderTemplate('{brand} – {missing} - {title}', it), 'Hračkáreň – - vláčik');
});

await t('availability z Google formátu -> Meta, condition povinné, brand len odporúčaný', () => {
  const { item, changed } = applyRules({ availability: 'in_stock', condition: 'New' }, []);
  assert.equal(item.availability, 'in stock');
  assert.equal(item.condition, 'new');
  assert.deepEqual(changed.sort(), ['availability', 'condition']);
  assert.equal(applyRules({ availability: 'backorder' }, []).item.availability, 'available for order');
  const { errors, warnings } = checkItem({ id: '1', title: 't', description: 'd', link: 'l', image_link: 'i', price: '1.00 EUR', availability: 'in stock' });
  assert.deepEqual(errors, ['chýba condition']);
  assert.deepEqual(warnings, ['chýba brand (ani gtin/mpn)']);
});

console.log('Pipeline');
const project = projects.create({
  name: 'Test Demo',
  slug: 'test-demo',
  source_url: `${base}/feed.xml`,
  config: {
    rules: [
      { type: 'exclude', when: [{ field: 'availability', op: 'eq', value: 'out of stock' }] },
      { type: 'clean_html', field: 'description' },
      { type: 'set', field: 'description', value: '{title}. Rýchle doručenie.', when: [{ field: 'description', op: 'empty' }] },
      { type: 'truncate', field: 'description', length: 40 },
      { type: 'set', field: 'title', value: '{brand|default:Demo} – {title} ({product_type|last_category})' },
      { type: 'set', field: 'custom_label_0', value: 'zlava' , when: [{ field: 'discount_pct', op: 'gt', value: '0' }] },
      { type: 'set', field: 'custom_label_1', value: 'lacne', when: [{ field: 'price_num', op: 'lt', value: '10' }] },
      { type: 'price', field: 'price', mode: 'round', value: '1' },
    ],
    images: {
      enabled: true, provider: 'whitekey', size: 600, padding: 0.12, shadow: true, keepOriginalAsAdditional: true,
      background: { type: 'color', color: '#f4efe9' },
      backgrounds: [{ when: [{ field: 'product_type', op: 'contains', value: 'Oblečenie' }],
        background: { type: 'gradient', color: '#ffe8e8', color2: '#e8f0ff', angle: 160 } }],
    },
  },
});

const logs = [];
const summary = await runProject(project, (m) => logs.push(m));
await t('počty: 3 vstup, 1 vylúčený, 2 zapísané', () => {
  assert.equal(summary.total, 3);
  assert.equal(summary.excluded, 1);
  assert.equal(summary.written, 2);
});
await t('obrázky: 2 vygenerované, 0 chýb', () => {
  assert.equal(summary.images.generated, 2);
  assert.equal(summary.images.failed, 0, JSON.stringify(summary.warnings));
});

const out = fs.readFileSync(path.join(tmp, 'feeds', 'test-demo.xml'), 'utf8');
const { items } = parseFeed(out);
await t('výstupný XML je validný RSS a má 2 položky', () => assert.equal(items.length, 2));
await t('titulok prepísaný šablónou', () => assert.equal(items[0].title, 'Hračkáreň – Drevená hračka & vláčik (Drevené)'));
await t('popis očistený od HTML a skrátený', () => {
  assert.ok(!/[<>]/.test(items[0].description));
  assert.ok(items[0].description.length <= 40, items[0].description);
});
await t('prázdny popis doplnený zo šablóny', () => assert.match(items[1].description, /Rýchle doručenie/));
await t('brand default (Demo) pre položku bez značky', () => assert.ok(items[1].title.startsWith('Demo – ')));
await t('labely: zľava (23.92 vs 29.90) a lacné (<10)', () => {
  assert.equal(items[0].custom_label_0, 'zlava');
  assert.equal(items[0].custom_label_1, undefined);
  assert.equal(items[1].custom_label_1, 'lacne');
});
await t('cena zaokrúhlená a v správnom formáte', () => assert.equal(items[0].price, '30.00 EUR'));
await t('image_link ukazuje na náš verejný host', () => assert.ok(items[0].image_link.startsWith('https://feeds.example.test/img/test-demo/')));
await t('pôvodný obrázok je medzi additional_image_link', () => {
  const add = [].concat(items[0].additional_image_link);
  assert.ok(add[0].startsWith(base), JSON.stringify(add));
  assert.ok(add.includes(`${base}/b.jpg`));
});
await t('vnorené shipping prežije', () => assert.equal([].concat(items[0].shipping)[0].country, 'SK'));

await t('obrázky sú 600x600 JPEG a pozadie je naozaj nové', async () => {
  const file = items[0].image_link.replace('https://feeds.example.test/img/', '');
  const buf = fs.readFileSync(path.join(tmp, 'images', file));
  const meta = await sharp(buf).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, 600);
  const { data } = await sharp(buf).extract({ left: 5, top: 5, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
  // roh by mal mať farbu pozadia #f4efe9 (244,239,233), nie čisto bielu
  assert.ok(Math.abs(data[0] - 244) < 6 && Math.abs(data[1] - 239) < 6 && Math.abs(data[2] - 233) < 6, `roh: ${[...data]}`);
  // stred produktu je stále červený (c0392b)
  const mid = await sharp(buf).extract({ left: 300 - 100, top: 300 - 100, width: 1, height: 1 }).raw().toBuffer();
  assert.ok(mid[0] > 150 && mid[1] < 100, `stred: ${[...mid]}`);
});
await t('podmienené pozadie (gradient) pre Oblečenie sa líši od predvoleného', async () => {
  const f1 = items[0].image_link.split('/img/')[1];
  const f2 = items[1].image_link.split('/img/')[1];
  const px = async (f) => (await sharp(path.join(tmp, 'images', f)).extract({ left: 5, top: 595, width: 1, height: 1 }).raw().toBuffer());
  const a = await px(f1), b = await px(f2);
  assert.notDeepEqual([...a], [...b]);
});

console.log('Druhý beh (cache)');
const summary2 = await runProject(project, () => {});
await t('všetky obrázky z cache, nič nové', () => {
  assert.equal(summary2.images.generated, 0);
  assert.equal(summary2.images.cached, 2);
});

console.log('Poistka poklesu');
const feedFile = path.join(tmp, 'feeds', 'test-demo.xml');
const before = fs.readFileSync(feedFile, 'utf8');
const excludeAll = { type: 'exclude', when: [] };
// poistka už nevyhadzuje chybu z celého behu: profil ostane pri starom feede a beh to nahlási
const guardBlocks = async (proj, re) => {
  const s = await runProject(proj);
  assert.ok(s.guard, 'beh mal byť zastavený poistkou');
  assert.match(s.error, re);
  assert.deepEqual(s.guardProfiles, ['test-demo']);
  assert.equal(s.written, 0);
};
await t('pravidlo, ktoré vylúči všetko, feed neprepíše', async () => {
  await guardBlocks({ ...project, config: { ...project.config, rules: [excludeAll] } }, /žiadna položka/);
  assert.equal(fs.readFileSync(feedFile, 'utf8'), before);
});
const dropOne = { type: 'exclude', when: [{ field: 'id', op: 'eq', value: '001' }] };
await t('pokles nad limit (2 -> 1 pri 40 %) feed neprepíše', async () => {
  const cfg = { ...project.config, rules: [dropOne, ...project.config.rules], safety: { maxDropPct: 40 } };
  await guardBlocks({ ...project, config: cfg }, /pokles o 50 %/);
  assert.equal(fs.readFileSync(feedFile, 'utf8'), before);
});
await t('pokles v limite (50 %) a 0 = vypnuté prejde', async () => {
  const cfg = { ...project.config, rules: [dropOne, ...project.config.rules], safety: { maxDropPct: 50 } };
  assert.equal((await runProject({ ...project, config: cfg })).written, 1);
  fs.writeFileSync(feedFile, before);
  cfg.safety.maxDropPct = 0;
  assert.equal((await runProject({ ...project, config: cfg })).written, 1);
  fs.writeFileSync(feedFile, before);
});
await t('force zapíše aj prázdny feed', async () => {
  const s = await runProject({ ...project, config: { ...project.config, rules: [excludeAll] } }, () => {}, { force: true });
  assert.equal(s.written, 0);
  assert.equal(parseFeed(fs.readFileSync(feedFile, 'utf8')).items.length, 0);
  fs.writeFileSync(feedFile, before);
});

await t('pravidlo, ktoré dá všetkým rovnaké id, poistka zastaví (unikátne ID, nie riadky)', async () => {
  const cfg = { ...project.config, rules: [...project.config.rules, { type: 'set', field: 'id', value: 'X' }], safety: { maxDropPct: 40 } };
  await guardBlocks({ ...project, config: cfg }, /1 unikátnych ID oproti 2/);
  const noId = { ...project.config, rules: [...project.config.rules, { type: 'remove', field: 'id' }] };
  await guardBlocks({ ...project, config: noId }, /žiadna položka/);
  assert.equal(fs.readFileSync(feedFile, 'utf8'), before);
});
await t('podmienka availability platí v Google aj Meta zápise', () => {
  const { item } = applyRules({ availability: 'in_stock' }, []);
  assert.equal(item.availability, 'in stock');
  assert.ok(testWhen(item, [{ field: 'availability', op: 'eq', value: 'in_stock' }]));
  assert.ok(testWhen({ availability: 'in_stock' }, [{ field: 'availability', op: 'eq', value: 'in stock' }]));
  assert.ok(testWhen(item, [{ field: 'availability', op: 'in', value: 'backorder, in_stock' }]));
  assert.ok(!testWhen(item, [{ field: 'availability', op: 'eq', value: 'out_of_stock' }]));
  assert.ok(testWhen({ availability: 'out_of_stock' }, [{ field: 'availability', op: 'contains', value: 'out_' }]));
});
await t('náhľad hlási duplicitné id rovnako ako beh', async () => {
  const { previewProject } = await import('../src/feed/pipeline.js');
  const d = await previewProject({ ...project, config: { ...project.config, rules: [...project.config.rules, { type: 'set', field: 'id', value: 'X' }] } });
  assert.equal(d.invalid, 1);
  assert.ok(d.rows.some((r) => r.issues.includes('duplicitné id "X"')));
});

console.log('Exportné profily');
const multi = {
  ...project,
  config: {
    ...project.config,
    profiles: [
      project.config.profiles[0],
      { id: 'goog', slug: 'test-demo-google', name: 'Google', channel: 'google', enabled: true, imageMode: 'project', rules: [{ type: 'set', field: 'title', value: '{title} | Google' }] },
      { id: 'clean', slug: 'test-demo-clean', name: 'Meta čistý', channel: 'meta', enabled: true, imageMode: 'original', rules: [{ type: 'exclude', when: [{ field: 'id', op: 'eq', value: '003' }] }] },
      { id: 'off', slug: 'test-demo-off', name: 'Vypnutý', channel: 'meta', enabled: false, imageMode: 'project', rules: [] },
    ],
  },
};
await t('projekt bez profilov dostane predvolený so slugom projektu (pôvodná URL ostáva)', () => {
  assert.deepEqual(project.config.profiles.map((p) => [p.id, p.slug, p.channel]), [['main', 'test-demo', 'meta']]);
});
const ms = await runProject(multi, () => {});
const readOut = (slug) => parseFeed(fs.readFileSync(path.join(tmp, 'feeds', `${slug}.xml`), 'utf8')).items;
await t('jeden beh zapíše feed pre každý zapnutý profil, vypnutý nie', () => {
  assert.deepEqual(Object.keys(ms.profiles), ['test-demo', 'test-demo-google', 'test-demo-clean']);
  assert.equal(ms.error, undefined);
  assert.equal(ms.profiles['test-demo'].written, 2);
  assert.equal(ms.profiles['test-demo-google'].written, 2);
  assert.equal(ms.profiles['test-demo-clean'].written, 1);
  assert.equal(ms.written, 5);
  assert.ok(!fs.existsSync(path.join(tmp, 'feeds', 'test-demo-off.xml')));
});
await t('Google profil: pôvodná fotka, hodnoty v Google formáte, vlastné pravidlo profilu', () => {
  const g = readOut('test-demo-google');
  assert.ok(g[0].image_link.startsWith(base), g[0].image_link); // nikdy vygenerovaný obrázok
  assert.equal(g[0].availability, 'in_stock');
  assert.match(g[0].title, / \| Google$/);
  assert.ok(!readOut('test-demo')[0].title.includes('Google')); // pravidlo profilu neovplyvní iný profil
});
await t('Meta profil s pôvodnými fotkami a vlastným vylúčením', () => {
  const c = readOut('test-demo-clean');
  assert.equal(c.length, 1);
  assert.ok(c[0].image_link.startsWith(base));
  assert.equal(c[0].availability, 'in stock');
});
await t('Google validácia: iné limity, Meta polia preč, predobjednávka bez dátumu je upozornenie', () => {
  const { item, changed } = applyRules({ availability: 'available for order', status: 'active', quantity_to_sell_on_facebook: '3', additional_image_link: Array.from({ length: 14 }, (_, i) => `u${i}`) }, [], 'google');
  assert.equal(item.availability, 'backorder');
  assert.ok(!('status' in item) && !('quantity_to_sell_on_facebook' in item));
  assert.equal(item.additional_image_link.length, 10);
  assert.ok(changed.includes('status'));
  const ok = { id: '1', title: 't', description: 'd', link: 'l', image_link: 'i', price: '1.00 EUR', availability: 'backorder', brand: 'B' };
  assert.deepEqual(checkItem(ok, 'google'), { errors: ['chýba availability_date (Google ho pri predobjednávke a tovare na objednávku vyžaduje)'], warnings: [] });
  assert.deepEqual(checkItem({ ...ok, availability_date: '2026-11-01T00:00+01:00' }, 'google').errors, []);
  assert.deepEqual(checkItem({ ...ok, title: 'x'.repeat(151), availability: 'in stock' }, 'google').errors, ['title > 150 znakov', 'availability "in stock" nie je platná hodnota']);
  assert.deepEqual(checkItem({ ...ok, availability: 'in stock', condition: 'new', title: 'x'.repeat(151) }, 'meta').errors, []);
  assert.deepEqual(checkItem({ ...ok, price: '12.50', availability: 'in_stock' }, 'google').errors, ['price bez meny']);
});
await t('poistka zastaví len dotknutý profil, ostatné sa zapíšu; force len pre vymenovaný', async () => {
  const beforeG = fs.readFileSync(path.join(tmp, 'feeds', 'test-demo-google.xml'), 'utf8');
  const cfg = structuredClone(multi.config);
  cfg.profiles[1].rules.push({ type: 'exclude', when: [] }); // Google profil vylúči všetko
  const s = await runProject({ ...multi, config: cfg }, () => {});
  assert.equal(s.guard, true);
  assert.deepEqual(s.guardProfiles, ['test-demo-google']);
  assert.match(s.error, /^test-demo-google: Poistka/);
  assert.equal(s.profiles['test-demo'].written, 2);
  assert.equal(fs.readFileSync(path.join(tmp, 'feeds', 'test-demo-google.xml'), 'utf8'), beforeG);
  const forcedOther = await runProject({ ...multi, config: cfg }, () => {}, { force: ['test-demo'] });
  assert.equal(forcedOther.guard, true); // odpustenie inému profilu nepomôže
  const forced = await runProject({ ...multi, config: cfg }, () => {}, { force: ['test-demo-google'] });
  assert.equal(forced.error, undefined);
  assert.equal(readOut('test-demo-google').length, 0);
});
await t('obrázky profilu, ktorý tento raz nezapísal, sa nepovažujú za nepoužívané', async () => {
  // hlavný profil je zastavený poistkou, jeho zverejnený feed stále odkazuje na vygenerované obrázky
  const cfg = structuredClone(multi.config);
  cfg.profiles = [{ ...cfg.profiles[0], rules: [{ type: 'exclude', when: [] }] }];
  const dir = path.join(tmp, 'images', 'test-demo');
  const past = new Date(Date.now() - 30 * 86_400_000);
  const referenced = readOut('test-demo').map((it) => path.basename(it.image_link));
  for (const n of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, n), past, past);
  const s = await runProject({ ...multi, config: cfg }, () => {});
  assert.equal(s.guard, true);
  for (const n of referenced) assert.ok(fs.existsSync(path.join(dir, n)), `zmazaný používaný obrázok ${n}`);
});
for (const slug of ['test-demo-google', 'test-demo-clean']) fs.rmSync(path.join(tmp, 'feeds', `${slug}.xml`), { force: true });

console.log('Súbežné obrázky');
await t('varianty so spoločnou fotkou: 1 stiahnutie, 1 vygenerovaný, zvyšok cache', async () => {
  delete hits['/c.jpg'];
  fs.rmSync(path.join(tmp, 'cache', 'orig'), { recursive: true, force: true });
  fs.rmSync(path.join(tmp, 'cache', 'cutouts'), { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, 'cache', 'orig')); fs.mkdirSync(path.join(tmp, 'cache', 'cutouts'));
  const s = { ...project.config.images, size: 520 };
  const res = await Promise.all(Array.from({ length: 5 }, () => ensureImage('race', `${base}/c.jpg`, {}, s)));
  assert.equal(hits['/c.jpg'], 1);
  assert.equal(res.filter((r) => !r.cached).length, 1);
  assert.equal(new Set(res.map((r) => r.file)).size, 1);
  assert.deepEqual(fs.readdirSync(path.join(tmp, 'images', 'race')).filter((n) => n.endsWith('.tmp')), []);
});

console.log('Bezpečnosť sťahovania');
await t('interné adresy sú zablokované, verejné nie', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.3.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'fd12::1', 'fe80::1', '0.0.0.0']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '::ffff:8.8.8.8', '2606:4700::1111']) assert.equal(isPublicAddress(ip), true, ip);
});
await t('safeFetch odmietne lokálnu adresu, názov localhost aj presmerovanie dovnútra', async () => {
  const port = server.address().port;
  delete process.env.ALLOW_PRIVATE_FETCH;
  try {
    await assert.rejects(safeFetch(`${base}/a.jpg`), (e) => e.code === 'EBLOCKED');
    await assert.rejects(safeFetch(`http://localhost:${port}/a.jpg`), (e) => e.code === 'EBLOCKED');
    await assert.rejects(safeFetch(`http://[::ffff:7f00:1]:${port}/a.jpg`), (e) => e.code === 'EBLOCKED');
    await assert.rejects(safeFetch('file:///etc/passwd'), /http\(s\)/);
    // povolený je len tento server; presmerovanie na iný lokálny port musí padnúť
    const other = http.createServer((_q, r) => r.end('tajné')); await new Promise((r) => other.listen(0, '127.0.0.1', r));
    blockedPort = other.address().port;
    process.env.FETCH_ALLOW_HOSTS = `127.0.0.1:${port}`;
    assert.equal((await safeFetch(`${base}/a.jpg`)).status, 200);
    await assert.rejects(safeFetch(`${base}/redirect-internal`), (e) => e.code === 'EBLOCKED');
    other.close();
  } finally {
    delete process.env.FETCH_ALLOW_HOSTS;
    process.env.ALLOW_PRIVATE_FETCH = '1';
  }
});
await t('safeFetch má strop veľkosti odpovede', async () => {
  await assert.rejects(safeFetch(`${base}/a.jpg`, { maxBytes: 100 }), /väčšia/);
});

console.log('Cache a retencia obrázkov');
const imgCfg = { ...project.config.images, size: 520 };
await t('fotka zmenená pod rovnakou URL dostane nový obrázok až po overení cache', async () => {
  const one = await ensureImage('swap', `${base}/swap.jpg`, {}, imgCfg);
  swapVersion = 2;
  const cachedStill = await ensureImage('swap', `${base}/swap.jpg`, {}, imgCfg);
  assert.equal(cachedStill.file, one.file); // v rámci TTL sa zdroj nekontroluje
  const hours = config.origCacheHours;
  config.origCacheHours = 0;
  try {
    const two = await ensureImage('swap', `${base}/swap.jpg`, {}, imgCfg);
    assert.notEqual(two.file, one.file);
    assert.equal(two.cached, false);
    const before = hits['/swap.jpg'];
    const three = await ensureImage('swap', `${base}/swap.jpg`, {}, imgCfg); // 304, nič nové
    assert.equal(three.file, two.file);
    assert.equal(three.cached, true);
    assert.equal(hits['/swap.jpg'], before + 1);
  } finally { config.origCacheHours = hours; }
});
await t('nepoužívaný obrázok prežije retenčnú dobu, potom sa zmaže', async () => {
  const dir = path.join(tmp, 'images', 'swap');
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 2);
  const [keep, old] = files;
  assert.equal(await pruneImages('swap', new Set([`swap/${keep}`]), 7), 0); // čerstvo nepoužitý ostáva
  const past = new Date(Date.now() - 8 * 86_400_000);
  fs.utimesSync(path.join(dir, old), past, past);
  fs.utimesSync(path.join(dir, keep), past, past); // použitý sa nesmie zmazať ani keď je starý
  assert.equal(await pruneImages('swap', new Set([`swap/${keep}`]), 7), 1);
  assert.deepEqual(fs.readdirSync(dir), [keep]);
});
await t('režim auto: biele pozadie = výrez, lifestyle fotka = celá karta', async () => {
  const s = { ...imgCfg, mode: 'auto', shadow: false, padding: 0.1, background: { type: 'color', color: '#112233' }, backgrounds: [] };
  const px = async (buf, x, y) => [...(await sharp(buf).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer())];
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 14);
  const life = await renderPreview(`${base}/life.jpg`, {}, s);
  // karta 416x312 v strede plátna 520: jej okraj má farbu fotky, nie pozadia
  assert.ok(near(await px(life, 70, 260), [0x8a, 0x6d, 0x4b]), 'lifestyle fotka má ostať celá');
  assert.ok(near(await px(life, 10, 10), [0x11, 0x22, 0x33]));
  const pack = await renderPreview(`${base}/a.jpg`, {}, s);
  // výrez je orezaný na produkt a zväčšený: na tomto mieste je už červený produkt, nie biely okraj fotky
  assert.ok(near(await px(pack, 70, 260), [0xc0, 0x39, 0x2b]), `biele pozadie má byť vystrihnuté: ${await px(pack, 70, 260)}`);
  const forced = await renderPreview(`${base}/a.jpg`, {}, { ...s, mode: 'photo' });
  assert.ok(near(await px(forced, 70, 260), [255, 255, 255]), 'režim photo necháva fotku celú');
});
await t('pozadie z knižnice sa použije a jeho výmena zmení výstupný súbor', async () => {
  const asset = path.join(config.assetsDir, 'test-bg.png');
  fs.writeFileSync(asset, await sharp({ create: { width: 64, height: 64, channels: 3, background: '#00aa55' } }).png().toBuffer());
  const s = { ...imgCfg, shadow: false, background: { type: 'image', asset: 'test-bg.png' }, backgrounds: [] };
  const one = await ensureImage('lib', `${base}/a.jpg`, {}, s);
  const corner = await sharp(path.join(tmp, 'images', one.file)).extract({ left: 5, top: 5, width: 1, height: 1 }).raw().toBuffer();
  assert.ok(corner[1] > 140 && corner[0] < 40, `roh: ${[...corner]}`);
  fs.writeFileSync(asset, await sharp({ create: { width: 80, height: 80, channels: 3, background: '#aa0055' } }).png().toBuffer());
  assert.notEqual((await ensureImage('lib', `${base}/a.jpg`, {}, s)).file, one.file);
  await assert.rejects(ensureImage('lib', `${base}/a.jpg`, {}, { ...s, background: { type: 'image', asset: '../feedbridge.db' } }), /Neplatný názov/);
});

await t('obsah starej verzie sa pod pôvodným odtlačkom nezmení ani po výmene fotky', async () => {
  swapVersion = 1;
  const hours = config.origCacheHours;
  config.origCacheHours = 0;
  try {
    const a = await fetchCached(`${base}/swap.jpg`, 'orig');
    const bytesA = fs.readFileSync(a.file);
    swapVersion = 2;
    const b = await fetchCached(`${base}/swap.jpg`, 'orig');
    assert.notEqual(b.hash, a.hash);
    assert.notEqual(b.file, a.file);
    assert.ok(fs.readFileSync(a.file).equals(bytesA)); // starý držiak stále číta staré bajty
  } finally { config.origCacheHours = hours; }
});
await t('presmerovanie na iný súbor s rovnakým ETagom nenechá starú fotku', async () => {
  const hours = config.origCacheHours;
  config.origCacheHours = 0;
  try {
    movingTarget = '/same-etag-a.jpg';
    const a = await fetchCached(`${base}/moving`, 'orig');
    assert.equal((await fetchCached(`${base}/moving`, 'orig')).hash, a.hash); // 304 na tej istej adrese
    movingTarget = '/same-etag-b.jpg';
    const b = await fetchCached(`${base}/moving`, 'orig');
    assert.notEqual(b.hash, a.hash);
  } finally { config.origCacheHours = hours; }
});
await t('pri výpadku zdroja sa použije cache a upratovanie ju nezmaže; 404 už nie', async () => {
  const hours = config.origCacheHours;
  const ok = await fetchCached(`${base}/flaky.jpg`, 'orig');
  const metaFile = path.join(tmp, 'cache', 'orig', fs.readdirSync(path.join(tmp, 'cache', 'orig')).find((n) => n.endsWith('.json') && JSON.parse(fs.readFileSync(path.join(tmp, 'cache', 'orig', n), 'utf8')).finalUrl.endsWith('/flaky.jpg')));
  const past = new Date(Date.now() - 31 * 86_400_000);
  fs.utimesSync(ok.file, past, past); fs.utimesSync(metaFile, past, past);
  config.origCacheHours = 0;
  try {
    flakyDown = true;
    const stale = await fetchCached(`${base}/flaky.jpg`, 'orig');
    assert.equal(stale.hash, ok.hash);
    assert.equal(stale.stale, true);
    await pruneCache(30);
    assert.ok(fs.existsSync(ok.file) && fs.existsSync(metaFile), 'používaná cache nesmie zmiznúť');
    flakyDown = false;
    delete images['flaky.jpg']; // zdroj teraz vráti 404
    await assert.rejects(fetchCached(`${base}/flaky.jpg`, 'orig'), /404/);
  } finally { config.origCacheHours = hours; flakyDown = false; }
});
await t('obrázok s obrovskými rozmermi sa odmietne, nespracuje', async () => {
  hugePng = await sharp({ create: { width: 7500, height: 7500, channels: 3, background: '#ffffff' } }).png({ compressionLevel: 9 }).toBuffer();
  assert.ok(hugePng.length < 2 * 1024 * 1024, `fixture má ${hugePng.length} B`);
  await assert.rejects(ensureImage('huge', `${base}/huge.png`, {}, { ...imgCfg, mode: 'auto' }), /pixel limit/i);
  hugePng = null;
});

await t('rembg: požiadavky idú po jednej, posiela sa model a po výpadku sa opakuje', async () => {
  let active = 0, maxActive = 0, calls = 0, models = new Set();
  const cut = await sharp({ create: { width: 40, height: 40, channels: 4, background: { r: 200, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
  const rembg = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      calls++; active++; maxActive = Math.max(maxActive, active);
      const m = /name="model"\r\n\r\n([^\r]+)/.exec(Buffer.concat(chunks).toString('latin1')); if (m) models.add(m[1]);
      if (calls === 1) { active--; return req.socket.destroy(); } // prvý pokus: server "spadol"
      setTimeout(() => { active--; res.setHeader('Content-Type', 'image/png'); res.end(cut); }, 40);
    });
  });
  await new Promise((r) => rembg.listen(0, '127.0.0.1', r));
  config.rembgUrl = `http://127.0.0.1:${rembg.address().port}/api/remove`;
  try {
    const s = { ...imgCfg, provider: 'rembg', mode: 'cutout', backgrounds: [] };
    const res = await Promise.all(['a.jpg', 'b.jpg', 'c.jpg'].map((n) => ensureImage('rembg', `${base}/${n}`, {}, s)));
    assert.equal(res.length, 3);
    assert.equal(maxActive, 1);
    assert.equal(calls, 4); // 3 obrázky + 1 opakovanie
    assert.deepEqual([...models], ['isnet-general-use']);
  } finally { config.rembgUrl = ''; rembg.close(); }
});

console.log('Upozornenia');
await t('webhook len pri zmene stavu: chyba raz, opakovaná nie, zotavenie áno', async () => {
  config.notifyWebhook = `${base}/hook`;
  const p = { id: 7, name: 'Demo', slug: 'demo' };
  const okRun = { status: 'ok', summary: { invalid: 0, images: { failed: 0 } } };
  const errRun = { status: 'error', summary: { error: 'Zdrojový feed vrátil HTTP 500' } };
  assert.equal(await notifyRun(p, null, okRun), null);
  assert.equal(await notifyRun(p, 'ok', okRun), null);
  assert.equal((await notifyRun(p, 'ok', errRun)).event, 'run_failed');
  assert.equal(await notifyRun(p, 'error', errRun), null);
  assert.equal((await notifyRun(p, 'ok', { status: 'error', summary: { error: 'Poistka', guard: true } })).event, 'guard_blocked');
  assert.equal((await notifyRun(p, 'error', okRun)).event, 'recovered');
  config.notifyWebhook = '';
  assert.equal(hooks.length, 3);
  assert.equal(hooks[0].project.slug, 'demo');
  assert.match(hooks[0].message, /HTTP 500/);
  assert.match(hooks[0].feed_url, /\/feeds\/demo\.xml$/);
});

console.log('Projekt z čias pred profilmi a históriou');
await t('starý záznam bez profilov a bez histórie: URL ostáva, prvá úprava odloží aj pôvodný stav', () => {
  const legacy = { rules: [{ type: 'remove', field: 'mpn' }], images: { enabled: false } }; // presne ako ukladala staršia verzia
  const id = Number(db.prepare('INSERT INTO projects (name, slug, config) VALUES (?,?,?)').run('Starý', 'stary-eshop', JSON.stringify(legacy)).lastInsertRowid);
  const before = projects.get(id);
  assert.deepEqual(before.config.profiles.map((p) => [p.id, p.slug, p.channel, p.imageMode]), [['main', 'stary-eshop', 'meta', 'project']]);
  assert.equal(versions.list(id).length, 0);
  projects.update(id, { ...before, config: { ...before.config, rules: [] } });
  const list = versions.list(id);
  assert.deepEqual(list.map((v) => v.rules), [0, 1]); // najnovšia prvá, pôvodný stav sa nestratil
  assert.deepEqual(projects.get(id).config.profiles.map((p) => p.slug), ['stary-eshop']);
  projects.remove(id);
});

console.log('Reštart');
await t('beh visiaci v stave running sa pri štarte označí ako error', () => {
  const rid = runs.start(project.id);
  assert.equal(recoverStaleRuns(), 1);
  const r = runs.get(rid);
  assert.equal(r.status, 'error');
  assert.match(r.summary.error, /reštartom/);
  assert.equal(projects.get(project.id).last_status, 'error');
});

server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} test(ov) zlyhalo` : '\nVšetko prešlo');
process.exit(failed ? 1 : 0);
