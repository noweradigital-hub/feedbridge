// FeedBridge admin UI - bez frameworku, bez build kroku.

const FIELDS = ['id', 'title', 'description', 'link', 'image_link', 'additional_image_link', 'price', 'sale_price', 'availability',
  'brand', 'condition', 'product_type', 'google_product_category', 'item_group_id', 'gtin', 'mpn', 'color', 'size', 'gender',
  'age_group', 'material', 'custom_label_0', 'custom_label_1', 'custom_label_2', 'custom_label_3', 'custom_label_4',
  'price_num', 'sale_price_num', 'discount_pct', 'currency'];

const OPS = { eq: 'sa rovná', neq: 'nerovná sa', contains: 'obsahuje', ncontains: 'neobsahuje', regex: 'regex',
  empty: 'je prázdne', nempty: 'nie je prázdne', gt: '>', lt: '<', gte: '≥', lte: '≤', in: 'je jedno z (a,b,c)' };

const RULE_TYPES = {
  set: 'Nastaviť pole (šablóna)', exclude: 'Vylúčiť produkt', replace: 'Nájsť a nahradiť', clean_html: 'Vyčistiť HTML',
  truncate: 'Skrátiť text', price: 'Upraviť cenu', remove: 'Odstrániť pole',
};

const state = { projects: [], cur: null, tab: 'settings', dirty: false, preview: null, runs: [], pollTimer: null, assets: [], output: null };

// ------------------------------------------------------------------ helpers
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch { /* nie je JSON */ }
    throw new Error(msg);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res;
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), isErr ? 6000 : 2500);
}

const markDirty = () => { state.dirty = true; const b = document.getElementById('save-btn'); if (b) b.disabled = false; };

function textInput(label, obj, key, { type = 'text', placeholder = '', list = '', onchange, readonly = false } = {}) {
  return h('label', { class: 'f' }, label,
    h('input', {
      type, placeholder, list: list || undefined, value: obj[key] ?? '', readonly,
      oninput: (e) => { obj[key] = type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value; markDirty(); onchange?.(); },
    }));
}
function checkInput(label, obj, key, onchange) {
  return h('label', { class: 'f check' },
    h('input', { type: 'checkbox', checked: !!obj[key], onchange: (e) => { obj[key] = e.target.checked; markDirty(); onchange?.(); } }), label);
}
function selectInput(label, obj, key, options, onchange) {
  return h('label', { class: 'f' }, label,
    h('select', { onchange: (e) => { obj[key] = e.target.value; markDirty(); onchange?.(); } },
      Object.entries(options).map(([v, t]) => h('option', { value: v, selected: obj[key] === v }, t))));
}

// ------------------------------------------------------------------ sidebar
async function loadProjects(selectId) {
  state.projects = await api('/projects');
  const list = document.getElementById('project-list');
  list.replaceChildren(...state.projects.map((p) =>
    h('button', { class: 'proj' + (state.cur?.id === p.id ? ' active' : ''), onclick: () => openProject(p.id) },
      h('span', { class: 'dot ' + (p.last_status || '') }), p.name)));
  if (!state.projects.length) list.replaceChildren(h('p', { class: 'muted pad' }, 'Zatiaľ žiadny projekt.'));
  if (selectId) await openProject(selectId);
  else if (!state.cur && state.projects.length) await openProject(state.projects[0].id);
  else if (!state.projects.length) renderEmpty();
}

function renderEmpty() {
  document.getElementById('main').replaceChildren(h('div', { class: 'card' }, h('h1', {}, 'Vitaj vo FeedBridge'),
    h('p', { class: 'muted' }, 'Vytvor prvý projekt (jeden eshop = jeden projekt), vlož URL feedu z WooCommerce pluginu a nastav pravidlá.')));
}

async function openProject(id) {
  if (state.dirty && state.cur && state.cur.id !== id && !confirm('Máš neuložené zmeny. Zahodiť ich?')) return;
  state.cur = await api('/projects/' + id);
  state.dirty = false; state.preview = null; state.runs = []; state.output = null;
  state.tab = state.tab || 'settings';
  document.querySelectorAll('.proj').forEach((el, i) => el.classList.toggle('active', state.projects[i]?.id === id));
  render();
  if (state.tab === 'output') loadOutput();
  if (state.tab === 'runs') loadRuns();
  if (state.cur.running) pollRuns();
}

document.getElementById('new-project').onclick = async () => {
  const name = prompt('Názov projektu (napr. názov eshopu):');
  if (!name) return;
  const slug = prompt('Slug pre URL feedu (a-z, 0-9, pomlčka):', name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
  if (!slug) return;
  try {
    const p = await api('/projects', { method: 'POST', body: { name, slug, source_url: '', interval_minutes: 180, enabled: true } });
    state.dirty = false;
    await loadProjects(p.id);
    toast('Projekt vytvorený');
  } catch (e) { toast(e.message, true); }
};

// ------------------------------------------------------------------ hlavný pohľad
function render() {
  const p = state.cur;
  const main = document.getElementById('main');
  if (!p) return renderEmpty();
  const tabs = { settings: 'Zdroj a plán', rules: `Pravidlá (${p.config.rules.length})`, images: 'Obrázky', preview: 'Náhľad', output: 'Výstup', runs: 'Behy' };
  const status = p.last_status ? h('span', { class: 'tag ' + p.last_status }, p.last_status) : null;
  main.replaceChildren(
    h('div', { class: 'head' },
      h('h1', {}, p.name), status,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: duplicate }, 'Duplikovať'),
      h('button', { class: 'btn danger', onclick: remove }, 'Zmazať'),
      h('button', { class: 'btn', id: 'run-btn', onclick: () => runNow(), disabled: p.running }, p.running ? 'Beží…' : 'Spustiť teraz'),
      h('button', { class: 'btn primary', id: 'save-btn', onclick: save, disabled: !state.dirty }, 'Uložiť')),
    h('div', { class: 'feedurl' }, h('span', { class: 'muted' }, 'URL pre Metu:'), h('code', {}, p.feed_url),
      h('button', { class: 'btn small', onclick: () => { navigator.clipboard.writeText(p.feed_url); toast('Skopírované'); } }, 'Kopírovať'),
      p.has_feed ? null : h('span', { class: 'muted' }, '(feed ešte nebol vygenerovaný)')),
    h('div', { class: 'tabs' }, Object.entries(tabs).map(([k, t]) =>
      h('button', { class: 'tab' + (state.tab === k ? ' active' : ''), onclick: () => { state.tab = k; render(); if (k === 'runs') loadRuns(); if (k === 'output') loadOutput(); } }, t))),
    h('div', { id: 'tab-body' }, ({ settings: tabSettings, rules: tabRules, images: tabImages, preview: tabPreview, output: tabOutput, runs: tabRuns })[state.tab]()));
}

async function save() {
  try {
    const p = state.cur;
    state.cur = await api('/projects/' + p.id, { method: 'PUT', body: p });
    state.dirty = false;
    await loadProjects();
    render();
    toast('Uložené');
  } catch (e) { toast(e.message, true); }
}

async function runNow(force = false, projectId = state.cur?.id) {
  if (!state.cur || state.cur.id !== projectId) return;
  if (state.dirty) {
    await save();
    if (state.dirty) return; // uloženie zlyhalo, nespúšťaj beh so starou konfiguráciou
  }
  try {
    await api(`/projects/${projectId}/run`, { method: 'POST', body: force === true ? { force: true } : {} });
    state.cur.running = true; render(); toast('Beh spustený'); pollRuns();
  } catch (e) { toast(e.message, true); }
}

async function duplicate() {
  try { const c = await api(`/projects/${state.cur.id}/duplicate`, { method: 'POST' }); state.dirty = false; await loadProjects(c.id); toast('Skopírované (bez zdrojového URL, vypnuté)'); }
  catch (e) { toast(e.message, true); }
}

async function remove() {
  if (!confirm(`Zmazať projekt "${state.cur.name}" aj s vygenerovaným feedom a obrázkami?`)) return;
  try { await api('/projects/' + state.cur.id, { method: 'DELETE' }); state.cur = null; state.dirty = false; await loadProjects(); toast('Zmazané'); }
  catch (e) { toast(e.message, true); }
}

function pollRuns() {
  clearInterval(state.pollTimer);
  const projectId = state.cur?.id;
  state.pollTimer = setInterval(async () => {
    if (!state.cur || state.cur.id !== projectId) return clearInterval(state.pollTimer);
    const fresh = await api('/projects/' + projectId).catch(() => null);
    if (!fresh || state.cur?.id !== projectId) return; // medzitým prepnutý projekt
    if (!fresh.running) {
      clearInterval(state.pollTimer);
      Object.assign(state.cur, { running: false, last_status: fresh.last_status, last_summary: fresh.last_summary, has_feed: fresh.has_feed });
      state.output = null;
      render(); loadProjects();
      if (state.tab === 'output') loadOutput();
      toast(fresh.last_status === 'error' ? 'Beh skončil chybou' : 'Beh dokončený', fresh.last_status === 'error');
      // poistka poklesu: zápis až po výslovnom potvrdení
      if (fresh.last_summary?.guard && confirm(`${state.cur.name}: ${fresh.last_summary.error}\n\nZapísať feed aj tak? Meta odstráni produkty, ktoré v ňom chýbajú.`)) runNow(true, projectId);
    }
  }, 2500);
}

// ------------------------------------------------------------------ záložky
function tabSettings() {
  const p = state.cur;
  return h('div', {},
    h('div', { class: 'card' }, h('div', { class: 'grid' },
      textInput('Názov projektu', p, 'name'),
      textInput('Slug (časť URL feedu, po vytvorení sa nemení)', p, 'slug', { readonly: true }),
      textInput('Zdrojový feed (z Woo pluginu)', p, 'source_url', { type: 'url', placeholder: 'https://eshop.sk/feed/meta.xml' }),
      textInput('Aktualizovať každých (minút, 15-1440)', p, 'interval_minutes', { type: 'number' }),
      textInput('Poistka: max. pokles položiek oproti minulému feedu (%, 0 = vypnuté)', p.config.safety, 'maxDropPct', { type: 'number' }),
      checkInput('Automatické spúšťanie zapnuté', p, 'enabled'))),
    h('p', { class: 'muted' }, 'Meta si v Commerce Manageri (Zdroje dát → Naplánovaný feed) nastaví URL hore. FeedBridge ju každých N minút prepočíta zo zdrojového feedu; ak zdroj zlyhá, posledný dobrý feed ostáva dostupný.'));
}

// --- pravidlá
function whenEditor(rule) {
  rule.when = rule.when || [];
  const wrap = h('div', {});
  const draw = () => {
    wrap.replaceChildren(
      rule.when.length ? h('div', { class: 'when-title' }, 'Platí len keď (všetky podmienky):') : null,
      ...rule.when.map((c, i) => h('div', { class: 'cond' },
        h('input', { type: 'text', list: 'fields', value: c.field || '', placeholder: 'pole', oninput: (e) => { c.field = e.target.value; markDirty(); } }),
        h('select', { onchange: (e) => { c.op = e.target.value; markDirty(); draw(); } },
          Object.entries(OPS).map(([v, t]) => h('option', { value: v, selected: c.op === v }, t))),
        ['empty', 'nempty'].includes(c.op) ? h('span') : h('input', { type: 'text', value: c.value ?? '', placeholder: 'hodnota', oninput: (e) => { c.value = e.target.value; markDirty(); } }),
        h('button', { class: 'btn small', onclick: () => { rule.when.splice(i, 1); markDirty(); draw(); } }, '×'))),
      h('button', { class: 'btn small', style: 'margin-top:8px', onclick: () => { rule.when.push({ field: '', op: 'contains', value: '' }); markDirty(); draw(); } }, '+ podmienka'));
  };
  draw();
  return wrap;
}

function ruleBody(r) {
  const redraw = () => render();
  switch (r.type) {
    case 'set': return h('div', { class: 'grid' },
      textInput('Pole', r, 'field', { list: 'fields', placeholder: 'napr. title alebo custom_label_0' }),
      textInput('Hodnota (šablóna)', r, 'value', { placeholder: '{brand} – {title} ({product_type|last_category})' }),
      checkInput('Len ak je pole prázdne', r, 'onlyIfEmpty'));
    case 'exclude': return h('div', { class: 'grid' }, textInput('Poznámka (prečo)', r, 'note', { placeholder: 'napr. nízky sklad' }));
    case 'replace': return h('div', { class: 'grid' },
      textInput('Pole', r, 'field', { list: 'fields' }), textInput('Nájdi', r, 'find'), textInput('Nahraď za', r, 'with'), checkInput('Regex', r, 'regex'));
    case 'clean_html': return h('div', { class: 'grid' }, textInput('Pole', r, 'field', { list: 'fields', placeholder: 'description' }));
    case 'truncate': return h('div', { class: 'grid' }, textInput('Pole', r, 'field', { list: 'fields' }), textInput('Max. dĺžka', r, 'length', { type: 'number' }));
    case 'price': return h('div', { class: 'grid' },
      selectInput('Pole', r, 'field', { price: 'price', sale_price: 'sale_price' }),
      selectInput('Režim', r, 'mode', { percent: 'o percentá (+/-)', add: 'pripočítať sumu', round: 'zaokrúhliť na násobok' }),
      textInput('Hodnota', r, 'value', { placeholder: 'napr. 10, -5 alebo 0.5' }));
    case 'remove': return h('div', { class: 'grid' }, textInput('Pole', r, 'field', { list: 'fields' }));
    default: void redraw; return null;
  }
}

function tabRules() {
  const p = state.cur;
  const rules = p.config.rules;
  const move = (i, d) => { const j = i + d; if (j < 0 || j >= rules.length) return; [rules[i], rules[j]] = [rules[j], rules[i]]; markDirty(); render(); };
  return h('div', {},
    h('datalist', { id: 'fields' }, FIELDS.map((f) => h('option', { value: f }))),
    h('details', { class: 'card' },
      h('summary', {}, 'Nápoveda: šablóny, filtre a polia'),
      h('p', {}, 'Šablóna dosadí polia v zložených zátvorkách: ', h('code', {}, '{brand} – {title}'), '. Filtre za zvislou čiarou: ',
        h('code', {}, 'upper lower title trim strip_html first_word last_category first_category truncate:120 default:Značka'), '.'),
      h('p', {}, 'Dopočítané polia pre podmienky: ', h('code', {}, 'price_num sale_price_num discount_pct currency'),
        '. Príklad labelu: pole ', h('code', {}, 'custom_label_0'), ' = ', h('code', {}, 'zlava'), ' keď ', h('code', {}, 'discount_pct'), ' > 0.'),
      h('p', {}, 'Pravidlá bežia zhora nadol; po pravidle „Vylúčiť“ sa položka už nespracúva.')),
    rules.length ? null : h('p', { class: 'muted' }, 'Zatiaľ žiadne pravidlá - feed sa preposiela bez zmien.'),
    rules.map((r, i) => h('div', { class: 'card rule' + (r.enabled === false ? ' off' : '') },
      h('div', { class: 'rule-head' },
        h('span', { class: 'muted' }, `${i + 1}.`),
        h('select', { onchange: (e) => { r.type = e.target.value; markDirty(); render(); } },
          Object.entries(RULE_TYPES).map(([v, t]) => h('option', { value: v, selected: r.type === v }, t))),
        h('span', { class: 'spacer' }),
        h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: r.enabled !== false, onchange: (e) => { r.enabled = e.target.checked; markDirty(); render(); } }), 'zapnuté'),
        h('button', { class: 'btn small', onclick: () => move(i, -1) }, '↑'),
        h('button', { class: 'btn small', onclick: () => move(i, 1) }, '↓'),
        h('button', { class: 'btn small danger', onclick: () => { rules.splice(i, 1); markDirty(); render(); } }, 'Zmazať')),
      ruleBody(r), whenEditor(r))),
    h('div', { class: 'row' },
      h('select', { id: 'new-rule-type', style: 'width:auto' }, Object.entries(RULE_TYPES).map(([v, t]) => h('option', { value: v }, t))),
      h('button', { class: 'btn', onclick: () => {
        const type = document.getElementById('new-rule-type').value;
        rules.push({ type, when: [], ...(type === 'price' ? { field: 'price', mode: 'percent', value: '' } : {}) });
        markDirty(); render();
      } }, '+ Pridať pravidlo')));
}

// --- obrázky
function backgroundEditor(bg, onchange) {
  const wrap = h('div', {});
  const draw = () => wrap.replaceChildren(h('div', { class: 'grid' },
    selectInput('Typ pozadia', bg, 'type', { color: 'Jedna farba', gradient: 'Prechod', image: 'Vlastný obrázok (URL)' }, () => { draw(); onchange?.(); }),
    bg.type !== 'image' ? h('label', { class: 'f' }, 'Farba', h('input', { type: 'color', value: bg.color || '#f4efe9', oninput: (e) => { bg.color = e.target.value; markDirty(); onchange?.(); } })) : null,
    bg.type === 'gradient' ? h('label', { class: 'f' }, 'Druhá farba', h('input', { type: 'color', value: bg.color2 || '#dfe8ee', oninput: (e) => { bg.color2 = e.target.value; markDirty(); onchange?.(); } })) : null,
    bg.type === 'gradient' ? textInput('Uhol (°)', bg, 'angle', { type: 'number' }) : null,
    bg.type === 'image' ? selectInput('Pozadie z knižnice', bg, 'asset', { '': '(žiadne – použiť URL nižšie)', ...Object.fromEntries(state.assets.map((a) => [a.name, a.name])) }, () => { draw(); onchange?.(); }) : null,
    bg.type === 'image' && !bg.asset ? textInput('URL obrázka pozadia', bg, 'url', { type: 'url', placeholder: 'https://…/pozadie.jpg' }) : null,
    bg.type === 'image' ? h('label', { class: 'f' }, 'Nahrať nové do knižnice (JPG/PNG/WebP)',
      h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', onchange: async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[f.type];
        const base = f.name.replace(/\.[^.]+$/, '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'pozadie';
        try {
          const res = await fetch(`/api/assets/${base}.${ext}`, { method: 'PUT', headers: { 'Content-Type': f.type }, body: f });
          if (!res.ok) throw new Error((await res.json()).error || res.statusText);
          state.assets = await api('/assets');
          bg.asset = `${base}.${ext}`; markDirty(); draw(); onchange?.(); toast('Nahraté do knižnice');
        } catch (err) { toast(err.message, true); }
      } })) : null,
    bg.type === 'image' && bg.asset ? h('img', { class: 'asset-thumb', src: `/api/assets/${bg.asset}`, alt: '' }) : null));
  draw();
  return wrap;
}

function tabImages() {
  const p = state.cur;
  const s = p.config.images;
  const previewBox = h('div', { id: 'img-preview' });
  const idx = { index: 0 };
  const genPreview = async () => {
    previewBox.replaceChildren(h('p', { class: 'muted' }, 'Generujem…'));
    try {
      const res = await fetch(`/api/projects/${p.id}/preview-image`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index: idx.index, images: s, rules: p.config.rules, source_url: p.source_url }),
      });
      if (!res.ok) throw new Error((await res.json()).error || res.statusText);
      const title = decodeURIComponent(res.headers.get('X-Item-Title') || '');
      const url = URL.createObjectURL(await res.blob());
      previewBox.replaceChildren(h('p', { class: 'muted' }, title), h('img', { class: 'preview-img', src: url }));
    } catch (e) { previewBox.replaceChildren(h('p', { style: 'color:var(--err)' }, e.message)); }
  };
  return h('div', {},
    h('div', { class: 'card' },
      checkInput('Generovať obrázky s novým pozadím', s, 'enabled'),
      h('div', { class: 'grid' },
        selectInput('Vystrihnutie produktu', s, 'provider', {
          whitekey: 'Lokálne - biele pozadie → priehľadné (zadarmo)',
          removebg: 'remove.bg API (kvalitné, platené)',
          rembg: 'Vlastný rembg server',
          none: 'Bez vystrihnutia (obrázok už je PNG s priehľadnosťou)',
        }),
        selectInput('Spôsob vloženia', s, 'mode', {
          cutout: 'Výrez produktu na pozadí',
          photo: 'Celá fotka ako karta (lifestyle zábery)',
          auto: 'Automaticky: biele pozadie → výrez, inak karta',
        }),
        textInput('Citlivosť bielej (200-255)', s, 'whiteThreshold', { type: 'number' }),
        textInput('Veľkosť (px, štvorec)', s, 'size', { type: 'number' }),
        textInput('Okraj (0-0.4)', s, 'padding', { type: 'number' }),
        textInput('Posun produktu dole (-0.2 až 0.2)', s, 'offsetY', { type: 'number' }),
        textInput('Kvalita JPEG', s, 'quality', { type: 'number' }),
        checkInput('Jemný tieň pod produktom', s, 'shadow'),
        checkInput('Pôvodný obrázok pridať ako dodatočný', s, 'keepOriginalAsAdditional'))),
    h('h2', {}, 'Predvolené pozadie'),
    h('div', { class: 'card' }, backgroundEditor(s.background)),
    h('h2', {}, 'Pozadia podľa podmienok'),
    h('p', { class: 'muted' }, 'Prvá zhoda vyhráva, ak žiadna nesedí, použije sa predvolené. Napr. kategória obsahuje „Oblečenie“ → teplý prechod.'),
    s.backgrounds.map((b, i) => h('div', { class: 'card rule' },
      h('div', { class: 'rule-head' }, h('b', {}, `Pozadie ${i + 1}`), h('span', { class: 'spacer' }),
        h('button', { class: 'btn small danger', onclick: () => { s.backgrounds.splice(i, 1); markDirty(); render(); } }, 'Zmazať')),
      backgroundEditor(b.background), whenEditor(b))),
    h('button', { class: 'btn', onclick: () => { s.backgrounds.push({ when: [{ field: 'product_type', op: 'contains', value: '' }], background: { type: 'gradient', color: '#ffe8e8', color2: '#e8f0ff', angle: 160 } }); markDirty(); render(); } }, '+ Pridať pozadie podľa podmienky'),
    h('h2', {}, 'Náhľad'),
    h('div', { class: 'card' },
      h('p', { class: 'muted' }, 'Vyrenderuje obrázok pre vybranú položku zo zdrojového feedu s aktuálnym (aj neuloženým) nastavením. Pre remove.bg sa výrez ukladá do cache, takže sa neplatí dvakrát.'),
      h('div', { class: 'row' },
        h('label', { class: 'f' }, 'Poradie položky', h('input', { type: 'number', value: 0, min: 0, style: 'width:90px', oninput: (e) => { idx.index = Number(e.target.value) || 0; } })),
        h('button', { class: 'btn primary', style: 'margin-top:18px', onclick: genPreview }, 'Vygenerovať náhľad')),
      previewBox),
    h('datalist', { id: 'fields' }, FIELDS.map((f) => h('option', { value: f }))));
}

// --- náhľad pravidiel
function tabPreview() {
  const p = state.cur;
  const box = h('div', {});
  const draw = () => {
    const d = state.preview;
    if (!d) { box.replaceChildren(h('p', { class: 'muted' }, 'Stiahne zdrojový feed a ukáže, ako by vyzeral po pravidlách (bez obrázkov, aj s neuloženými zmenami).')); return; }
    box.replaceChildren(
      h('p', {}, `Položiek: ${d.total} · vylúčených: ${d.excluded} · s chybami pre Metu: `, h('b', { style: d.invalid ? 'color:var(--err)' : '' }, String(d.invalid)), ` · zobrazených: ${d.rows.length}`),
      h('table', {},
        h('thead', {}, h('tr', {}, ['ID', 'Titulok', 'Cena', 'Labely / zmenené polia', 'Problémy'].map((t) => h('th', {}, t)))),
        h('tbody', {}, d.rows.map((r) => {
          const o = r.original, n = r.result;
          if (!n) return h('tr', { class: 'excluded' }, h('td', {}, o.id), h('td', {}, o.title), h('td', {}), h('td', {}, h('span', { class: 'tag' }, 'vylúčené'), r.excluded.note || ''), h('td', {}));
          const labels = Object.entries(n).filter(([k]) => k.startsWith('custom_label')).map(([k, v]) => h('span', { class: 'tag ok' }, `${k.replace('custom_label_', 'L')}: ${v}`));
          return h('tr', {},
            h('td', {}, n.id),
            h('td', {}, n.title !== o.title ? [h('span', { class: 'old' }, o.title), n.title] : n.title),
            h('td', {}, n.price !== o.price ? [h('span', { class: 'old' }, o.price), n.price] : n.price, n.sale_price ? h('div', { class: 'muted' }, n.sale_price) : null),
            h('td', {}, labels, r.changed.filter((c) => !c.startsWith('custom_label') && !['title', 'price'].includes(c)).map((c) => h('span', { class: 'tag' }, c))),
            h('td', {}, r.issues.map((i) => h('span', { class: 'tag err' }, i)), (r.notes || []).map((i) => h('span', { class: 'tag' }, i))));
        }))));
  };
  draw();
  return h('div', {},
    h('button', { class: 'btn primary', onclick: async (e) => {
      e.target.disabled = true; e.target.textContent = 'Načítavam…';
      try { state.preview = await api(`/projects/${p.id}/preview`, { method: 'POST', body: { config: p.config, source_url: p.source_url, limit: 80 } }); }
      catch (err) { toast(err.message, true); }
      e.target.disabled = false; e.target.textContent = 'Načítať náhľad'; draw();
    } }, 'Načítať náhľad'),
    h('div', { style: 'margin-top:14px' }, box));
}

// --- výstup: to, čo je práve zverejnené vo feede
async function loadOutput() {
  if (!state.cur) return;
  const id = state.cur.id;
  const data = await api(`/projects/${id}/output`).catch((e) => ({ error: e.message, items: [] }));
  if (state.cur?.id !== id) return;
  state.output = data;
  if (state.tab === 'output') document.getElementById('tab-body')?.replaceChildren(tabOutput());
}

function tabOutput() {
  const d = state.output;
  if (!d) return h('p', { class: 'muted' }, 'Načítavam…');
  if (d.error) return h('p', { style: 'color:var(--err)' }, d.error);
  if (!d.items.length) return h('p', { class: 'muted' }, 'Feed ešte nebol vygenerovaný. Klikni na „Spustiť teraz“.');
  return h('div', {},
    h('p', { class: 'muted' }, `Zverejnený feed: ${d.items.length} položiek, vygenerovaný ${new Date(d.generated_at).toLocaleString('sk-SK')}. Toto si sťahuje Meta.`),
    h('div', { class: 'gallery' }, d.items.map((it) => h('div', { class: 'gcard' },
      h('a', { href: it.image_link, target: '_blank', rel: 'noopener' }, h('img', { src: it.image_link, loading: 'lazy', alt: '' })),
      h('div', { class: 'gbody' },
        h('div', { class: 'gtitle' }, it.title),
        h('div', {}, it.sale_price ? [h('span', { class: 'old' }, it.price), it.sale_price] : it.price,
          it.availability !== 'in stock' ? h('span', { class: 'tag warning', style: 'margin-left:6px' }, it.availability) : null),
        h('div', {}, h('span', { class: 'tag' }, it.id), Object.entries(it.labels).map(([k, v]) => h('span', { class: 'tag ok' }, `${k.replace('custom_label_', 'L')}: ${v}`))))))));
}

// --- behy
async function loadRuns() {
  if (!state.cur) return;
  state.runs = await api(`/projects/${state.cur.id}/runs`);
  if (state.tab === 'runs') document.getElementById('tab-body')?.replaceChildren(tabRuns());
}

function tabRuns() {
  const logBox = h('div', {});
  const show = async (id) => {
    const r = await api('/runs/' + id);
    logBox.replaceChildren(h('pre', { class: 'log' }, r.log || '(prázdny log)'),
      r.summary?.warnings?.length ? h('details', { open: true }, h('summary', {}, `Upozornenia (${r.summary.warnings.length})`), h('pre', { class: 'log' }, r.summary.warnings.join('\n'))) : null);
  };
  return h('div', {},
    state.runs.length ? h('table', {},
      h('thead', {}, h('tr', {}, ['Začiatok (UTC)', 'Stav', 'Vstup', 'Vylúčené', 'Zapísané', 'Obrázky nové/cache/chyby', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, state.runs.map((r) => {
        const s = r.summary || {};
        return h('tr', {},
          h('td', {}, r.started_at), h('td', {}, h('span', { class: 'tag ' + r.status }, r.status)),
          h('td', {}, s.total ?? ''), h('td', {}, s.excluded ?? ''), h('td', {}, s.written ?? s.error ?? ''),
          h('td', {}, s.images ? `${s.images.generated}/${s.images.cached}/${s.images.failed}` : ''),
          h('td', {}, h('button', { class: 'btn small', onclick: () => show(r.id) }, 'Log')));
      }))) : h('p', { class: 'muted' }, 'Zatiaľ žiadne behy. Klikni na „Spustiť teraz“.'),
    h('div', { style: 'margin-top:14px' }, logBox));
}

window.addEventListener('beforeunload', (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });
api('/assets').then((a) => { state.assets = a; }).catch(() => {}).then(loadProjects)
  .catch((e) => { document.getElementById('main').textContent = 'Chyba: ' + e.message; });
