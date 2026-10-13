// FeedBridge admin UI - bez frameworku, bez build kroku.

const FIELDS = ['id', 'title', 'description', 'link', 'image_link', 'additional_image_link', 'price', 'sale_price', 'availability',
  'brand', 'condition', 'product_type', 'google_product_category', 'item_group_id', 'gtin', 'mpn', 'color', 'size', 'gender',
  'age_group', 'material', 'custom_label_0', 'custom_label_1', 'custom_label_2', 'custom_label_3', 'custom_label_4',
  'price_num', 'sale_price_num', 'discount_pct', 'currency'];

const OPS = { eq: 'sa rovná', neq: 'nerovná sa', contains: 'obsahuje', ncontains: 'neobsahuje', regex: 'regex',
  empty: 'je prázdne', nempty: 'nie je prázdne', gt: '>', lt: '<', gte: '≥', lte: '≤', in: 'je jedno z (a,b,c)' };

const CHANNELS = { meta: 'Meta', google: 'Google' };

const RULE_TYPES = {
  set: 'Nastaviť pole (šablóna)', exclude: 'Vylúčiť produkt', replace: 'Nájsť a nahradiť', clean_html: 'Vyčistiť HTML',
  truncate: 'Skrátiť text', price: 'Upraviť cenu', remove: 'Odstrániť pole',
};

const state = { projects: [], cur: null, tab: 'settings', dirty: false, preview: null, runs: [], pollTimer: null, assets: [], output: null, viewProfile: null, versions: null };

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
      Object.entries(options).map(([v, t]) => h('option', { value: v, selected: String(obj[key]) === v }, t))));
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
  state.dirty = false; state.preview = null; state.runs = []; state.output = null; state.viewProfile = null; state.versions = null;
  imgPreview.box.replaceChildren(); imgPreview.index = 0; imgPreview.seq++;
  state.tab = state.tab || 'settings';
  document.querySelectorAll('.proj').forEach((el, i) => el.classList.toggle('active', state.projects[i]?.id === id));
  render();
  if (state.tab === 'output') loadOutput();
  if (state.tab === 'runs') loadRuns();
  if (state.tab === 'settings') loadVersions();
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
  const tabs = { settings: 'Zdroj a plán', rules: `Pravidlá (${p.config.rules.length})`, profiles: `Profily (${p.config.profiles.length})`, images: 'Obrázky', preview: 'Náhľad', output: 'Výstup', runs: 'Behy' };
  const status = p.last_status ? h('span', { class: 'tag ' + p.last_status }, p.last_status) : null;
  main.replaceChildren(
    h('div', { class: 'head' },
      h('h1', {}, p.name), status,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: duplicate }, 'Duplikovať'),
      h('button', { class: 'btn danger', onclick: remove }, 'Zmazať'),
      h('button', { class: 'btn', id: 'run-btn', onclick: () => runNow(), disabled: p.running }, p.running ? 'Beží…' : 'Spustiť teraz'),
      h('button', { class: 'btn primary', id: 'save-btn', onclick: save, disabled: !state.dirty }, 'Uložiť')),
    ...p.config.profiles.filter((pr) => pr.feed_url).map((pr) => h('div', { class: 'feedurl' },
      h('span', { class: 'tag' }, CHANNELS[pr.channel]), h('span', { class: 'muted' }, `${pr.name}:`), h('code', {}, pr.feed_url),
      h('button', { class: 'btn small', onclick: () => { navigator.clipboard.writeText(pr.feed_url); toast('Skopírované'); } }, 'Kopírovať'),
      pr.enabled === false ? h('span', { class: 'tag warning' }, 'vypnutý') : null,
      pr.has_feed ? null : h('span', { class: 'muted' }, '(feed ešte nebol vygenerovaný)'))),
    h('div', { class: 'tabs' }, Object.entries(tabs).map(([k, t]) =>
      h('button', { class: 'tab' + (state.tab === k ? ' active' : ''), onclick: () => { state.tab = k; render(); if (k === 'runs') loadRuns(); if (k === 'output') loadOutput(); if (k === 'settings') loadVersions(); } }, t))),
    h('div', { id: 'tab-body' }, ({ settings: tabSettings, rules: tabRules, profiles: tabProfiles, images: tabImages, preview: tabPreview, output: tabOutput, runs: tabRuns })[state.tab]()));
}

async function save() {
  try {
    const p = state.cur;
    state.cur = await api('/projects/' + p.id, { method: 'PUT', body: p });
    state.dirty = false; state.versions = null;
    await loadProjects();
    render();
    if (state.tab === 'settings') loadVersions();
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
    await api(`/projects/${projectId}/run`, { method: 'POST', body: force ? { force } : {} });
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
      for (const pr of state.cur.config.profiles) { const f = fresh.config.profiles.find((x) => x.id === pr.id); if (f) pr.has_feed = f.has_feed; }
      state.output = null;
      render(); loadProjects();
      if (state.tab === 'output') loadOutput();
      toast(fresh.last_status === 'error' ? 'Beh skončil chybou' : 'Beh dokončený', fresh.last_status === 'error');
      // poistka poklesu: zápis až po výslovnom potvrdení
      // odpustí sa len profilom, ktoré poistka zastavila
      const blocked = fresh.last_summary?.guardProfiles || [];
      if (fresh.last_summary?.guard && confirm(`${state.cur.name}: ${fresh.last_summary.error}\n\nZapísať feed aj tak? Kanál odstráni produkty, ktoré v ňom chýbajú.`)) runNow(blocked.length ? blocked : true, projectId);
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
    h('p', { class: 'muted' }, 'Meta si v Commerce Manageri (Zdroje dát → Naplánovaný feed) nastaví URL hore. FeedBridge ju každých N minút prepočíta zo zdrojového feedu; ak zdroj zlyhá, posledný dobrý feed ostáva dostupný.'),
    h('h2', {}, 'História nastavení'),
    h('div', { class: 'card', id: 'versions-box' }, versionsList()));
}

async function loadVersions() {
  if (!state.cur) return;
  const id = state.cur.id;
  const list = await api(`/projects/${id}/versions`).catch(() => []);
  if (state.cur?.id !== id) return;
  state.versions = list;
  document.getElementById('versions-box')?.replaceChildren(versionsList());
}

function versionsList() {
  const list = state.versions;
  if (!list) return h('p', { class: 'muted' }, 'Načítavam…');
  if (list.length < 2) return h('p', { class: 'muted' }, 'Zatiaľ len aktuálna verzia. Každé uloženie, ktoré niečo zmení, sem pridá záznam (posledných 30).');
  return h('table', {},
    h('thead', {}, h('tr', {}, ['Uložené (UTC)', 'Pravidiel', 'Profily', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, list.map((v, i) => h('tr', {},
      h('td', {}, v.created_at), h('td', {}, v.rules), h('td', {}, v.profiles.join(', ')),
      h('td', {}, i === 0 ? h('span', { class: 'tag ok' }, 'aktuálna') : h('button', { class: 'btn small', onclick: async () => {
        if (state.dirty && !confirm('Máš neuložené zmeny, obnovením sa stratia. Pokračovať?')) return;
        if (!confirm(`Vrátiť pravidlá a nastavenia na stav z ${v.created_at}? Zoznam profilov a ich URL sa nemení.`)) return;
        try { state.cur = await api(`/projects/${state.cur.id}/versions/${v.id}/restore`, { method: 'POST' }); state.dirty = false; state.versions = null; render(); loadVersions(); toast('Obnovené'); }
        catch (e) { toast(e.message, true); }
      } }, 'Obnoviť'))))));
}

// --- pravidlá
function whenEditor(rule) {
  rule.when = rule.when || [];
  const wrap = h('div', {});
  const draw = () => {
    wrap.replaceChildren(
      ...(rule.when.length ? [h('div', { class: 'when-title' }, 'Platí len keď (všetky podmienky):')] : []), // null by sa vypísal ako text
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

/** Editor zoznamu pravidiel; používa ho projekt aj každý profil. */
function rulesEditor(rules, emptyText) {
  const move = (i, d) => { const j = i + d; if (j < 0 || j >= rules.length) return; [rules[i], rules[j]] = [rules[j], rules[i]]; markDirty(); render(); };
  const typeSelect = h('select', { style: 'width:auto' }, Object.entries(RULE_TYPES).map(([v, t]) => h('option', { value: v }, t)));
  return h('div', {},
    rules.length ? null : h('p', { class: 'muted' }, emptyText),
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
    h('div', { class: 'row' }, typeSelect,
      h('button', { class: 'btn', onclick: () => {
        const type = typeSelect.value;
        rules.push({ type, when: [], ...(type === 'price' ? { field: 'price', mode: 'percent', value: '' } : {}) });
        markDirty(); render();
      } }, '+ Pridať pravidlo')));
}

function tabRules() {
  const p = state.cur;
  return h('div', {},
    h('datalist', { id: 'fields' }, FIELDS.map((f) => h('option', { value: f }))),
    h('details', { class: 'card' },
      h('summary', {}, 'Nápoveda: šablóny, filtre a polia'),
      h('p', {}, 'Šablóna dosadí polia v zložených zátvorkách: ', h('code', {}, '{brand} – {title}'), '. Filtre za zvislou čiarou: ',
        h('code', {}, 'upper lower title trim strip_html first_word last_category first_category truncate:120 default:Značka'), '.'),
      h('p', {}, 'Dopočítané polia pre podmienky: ', h('code', {}, 'price_num sale_price_num discount_pct currency'),
        '. Príklad labelu: pole ', h('code', {}, 'custom_label_0'), ' = ', h('code', {}, 'zlava'), ' keď ', h('code', {}, 'discount_pct'), ' > 0.'),
      h('p', {}, 'Pravidlá bežia zhora nadol; po pravidle „Vylúčiť“ sa položka už nespracúva. Tieto pravidlá platia pre všetky profily, pravidlá len pre jeden kanál sú v záložke Profily.')),
    rulesEditor(p.config.rules, 'Zatiaľ žiadne pravidlá - feed sa preposiela bez zmien.'));
}

// --- exportné profily: jeden projekt, viac výstupných feedov
function slugify(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function tabProfiles() {
  const p = state.cur;
  const profiles = p.config.profiles;
  return h('div', {},
    h('datalist', { id: 'fields' }, FIELDS.map((f) => h('option', { value: f }))),
    h('p', { class: 'muted' }, 'Každý profil je samostatný feed s vlastnou URL. Zdroj a spoločné pravidlá má projekt, profil si pridáva vlastné pravidlá a určuje, aké obrázky dostane kanál. Google dostáva vždy pôvodnú fotku: promo grafiku ako hlavný obrázok nepovoľuje.'),
    profiles.map((pr, i) => {
      const isNew = !pr.feed_url; // ešte neuložený: slug sa dá zvoliť, potom je navždy
      const google = pr.channel === 'google';
      return h('div', { class: 'card rule' + (pr.enabled === false ? ' off' : '') },
        h('div', { class: 'rule-head' },
          h('b', {}, pr.name || `Profil ${i + 1}`), h('span', { class: 'tag' }, CHANNELS[pr.channel]),
          h('span', { class: 'spacer' }),
          h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: pr.enabled !== false, onchange: (e) => { pr.enabled = e.target.checked; markDirty(); render(); } }), 'zapnutý'),
          profiles.length > 1 ? h('button', { class: 'btn small danger', onclick: () => {
            if (!isNew && !confirm(`Zmazať profil „${pr.name}“? Po uložení zmizne aj jeho feed ${pr.feed_url} a kanál, ktorý ho sťahuje, dostane chybu.`)) return;
            profiles.splice(i, 1); markDirty(); render();
          } }, 'Zmazať') : null),
        h('div', { class: 'grid' },
          textInput('Názov', pr, 'name', { onchange: () => { if (isNew && !pr.slugTouched) { pr.slug = slugify(`${p.slug}-${pr.name}`); const el = document.getElementById(`slug-${i}`); if (el) el.value = pr.slug; } } }),
          h('label', { class: 'f' }, isNew ? 'Slug (URL feedu, po uložení sa nemení)' : 'Slug (URL feedu)',
            h('input', { type: 'text', id: `slug-${i}`, value: pr.slug, readonly: !isNew, oninput: (e) => { pr.slug = e.target.value; pr.slugTouched = true; markDirty(); } })),
          selectInput('Kanál', pr, 'channel', CHANNELS, () => render()),
          google
            ? h('label', { class: 'f' }, 'Obrázky', h('input', { type: 'text', value: 'Pôvodné fotky (Google)', readonly: true }))
            : selectInput('Obrázky', pr, 'imageMode', { project: 'Podľa záložky Obrázky (nové pozadie)', original: 'Pôvodné fotky z e-shopu' })),
        h('details', { open: pr.rules.length > 0 },
          h('summary', {}, `Pravidlá len pre tento profil (${pr.rules.length})`),
          rulesEditor(pr.rules, 'Žiadne vlastné pravidlá. Platia len pravidlá projektu.')));
    }),
    h('div', { class: 'row' },
      ...Object.entries(CHANNELS).map(([ch, label]) => h('button', { class: 'btn', onclick: () => {
        let slug = `${p.slug}-${ch}`;
        for (let n = 2; profiles.some((x) => x.slug === slug); n++) slug = `${p.slug}-${ch}-${n}`;
        profiles.push({ slug, name: label, channel: ch, enabled: true, imageMode: ch === 'google' ? 'original' : 'project', rules: [] });
        markDirty(); render();
      } }, `+ Profil pre ${label}`))));
}

/** Prepínač profilu pre Náhľad a Výstup. */
function profilePicker(onchange) {
  const profiles = state.cur.config.profiles;
  if (!profiles.some((x) => x.slug === state.viewProfile)) state.viewProfile = profiles[0]?.slug;
  if (profiles.length < 2) return null;
  return h('select', { style: 'width:auto', onchange: (e) => { state.viewProfile = e.target.value; onchange(); } },
    profiles.map((x) => h('option', { value: x.slug, selected: x.slug === state.viewProfile }, `${x.name} (${CHANNELS[x.channel]})`)));
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

// Náhľad obrázka prežíva prekreslenie záložky (zmena nastavenia ju celú stavia nanovo)
const imgPreview = { box: h('div', { id: 'img-preview' }), index: 0, sale: true, timer: null, seq: 0 };

async function genPreview() {
  const p = state.cur;
  if (!p || !p.source_url) { imgPreview.box.replaceChildren(h('p', { class: 'muted' }, 'Najprv nastav zdrojový feed.')); return; }
  const seq = ++imgPreview.seq;
  imgPreview.box.classList.add('loading');
  try {
    const res = await fetch(`/api/projects/${p.id}/preview-image`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index: imgPreview.index, sale: imgPreview.sale, images: p.config.images, brand: p.config.brand, rules: p.config.rules, source_url: p.source_url }),
    });
    if (seq !== imgPreview.seq) return; // medzitým prišla novšia zmena
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    const title = decodeURIComponent(res.headers.get('X-Item-Title') || '');
    const notes = decodeURIComponent(res.headers.get('X-Badge-Notes') || '');
    const hasBadge = res.headers.get('X-Badge') === '1';
    const unchanged = res.headers.get('X-Unchanged') === '1';
    const index = Number(res.headers.get('X-Item-Index')) || 0;
    const blob = await res.blob();
    if (seq !== imgPreview.seq) return; // počas sťahovania prišla novšia zmena alebo iný projekt
    imgPreview.index = index;
    const url = URL.createObjectURL(blob);
    imgPreview.box.replaceChildren(...[
      h('p', { class: 'muted' }, `${imgPreview.index}. ${title}`, hasBadge ? null : h('span', { class: 'tag warning', style: 'margin-left:8px' }, unchanged ? 'tento produkt ostáva bez úpravy' : 'táto položka badge nedostane')),
      notes ? h('p', { class: 'tag warning' }, notes) : null,
      h('div', { class: 'preview-pair' },
        h('img', { class: 'preview-img', src: url, alt: '' }),
        h('div', {}, h('img', { class: 'preview-thumb', src: url, alt: '' }), h('p', { class: 'muted' }, 'veľkosť malej dlaždice v reklame'))),
    ].filter(Boolean)); // replaceChildren by z null spravil text "null"
  } catch (e) { if (seq === imgPreview.seq) imgPreview.box.replaceChildren(h('p', { style: 'color:var(--err)' }, e.message)); }
  finally { if (seq === imgPreview.seq) imgPreview.box.classList.remove('loading'); }
}
/** Po zmene nastavenia náhľad prekreslí sám, s krátkym oneskorením (písanie do poľa). */
function previewSoon() {
  clearTimeout(imgPreview.timer);
  imgPreview.timer = setTimeout(genPreview, 600);
}

const COLOR_TOKENS = { auto: 'Automaticky (podľa kontrastu)', primary: 'Hlavná farba značky', accent: 'Akcent značky', white: 'Biela', black: 'Čierna' };
/** Farba ako odkaz na značku (zmena značky prefarbí všetko) alebo vlastná hodnota. */
function colorToken(label, obj, key, { allowAuto = true } = {}) {
  const custom = /^#[0-9a-f]{6}$/i.test(obj[key] || '');
  const opts = { ...(allowAuto ? {} : { auto: undefined }), ...COLOR_TOKENS, custom: 'Vlastná…' };
  if (!allowAuto) delete opts.auto;
  return h('label', { class: 'f' }, label,
    h('div', { class: 'row' },
      h('select', { onchange: (e) => { obj[key] = e.target.value === 'custom' ? '#888888' : e.target.value; markDirty(); render(); previewSoon(); } },
        Object.entries(opts).map(([v, t]) => h('option', { value: v, selected: custom ? v === 'custom' : obj[key] === v }, t))),
      custom ? h('input', { type: 'color', value: obj[key], style: 'width:52px;flex:none', oninput: (e) => { obj[key] = e.target.value; markDirty(); previewSoon(); } }) : null));
}

function tabImages() {
  const p = state.cur;
  const s = p.config.images;
  const brand = p.config.brand;
  const b = s.badge;
  const live = () => previewSoon();
  const relayout = () => { render(); previewSoon(); }; // zmena, ktorá mení aj zobrazené polia
  const strip = b.preset === 'strip';
  if (!imgPreview.box.firstChild && p.source_url && s.enabled) previewSoon();
  return h('div', {},
    h('div', { class: 'card' },
      checkInput('Upravovať obrázky produktov', s, 'enabled', relayout),
      h('p', { class: 'muted' }, 'Pôvodná fotka ostáva, pridá sa na ňu cenový badge. Google profily dostávajú vždy fotku bez úprav.')),

    h('h2', {}, 'Značka'),
    h('div', { class: 'card' }, h('div', { class: 'grid' },
      h('label', { class: 'f' }, 'Hlavná farba', h('input', { type: 'color', value: brand.primary, oninput: (e) => { brand.primary = e.target.value; markDirty(); live(); } })),
      h('label', { class: 'f' }, 'Akcent (zľava, zvýraznenie)', h('input', { type: 'color', value: brand.accent, oninput: (e) => { brand.accent = e.target.value; markDirty(); live(); } })),
      selectInput('Písmo', brand, 'font', { inter: 'Inter (neutrálne)', manrope: 'Manrope (geometrické)', 'barlow-condensed': 'Barlow Condensed (úzke)' }, live))),

    h('h2', {}, 'Cenový badge'),
    h('div', { class: 'card' },
      checkInput('Zobraziť cenu na obrázku pri zľavnených produktoch', b, 'enabled', relayout),
      h('div', { class: 'grid' },
        selectInput('Tvar', b, 'preset', { card: 'Karta v rohu', strip: 'Pás cez celú šírku' }, relayout),
        selectInput('Umiestnenie', b, 'position', strip
          ? { 'bottom-left': 'Dole', 'top-left': 'Hore' }
          : { 'bottom-left': 'Vľavo dole', 'bottom-center': 'Dole v strede', 'bottom-right': 'Vpravo dole', 'top-left': 'Vľavo hore', 'top-center': 'Hore v strede', 'top-right': 'Vpravo hore' }, live),
        selectInput('Veľkosť', b, 'scale', { 0.85: 'Menší', 1: 'Štandardný', 1.15: 'Väčší', 1.3: 'Najväčší' }, live),
        colorToken('Podklad', b, 'surface', { allowAuto: false }),
        colorToken('Nová cena', b, 'highlight'),
        colorToken('Stará cena a text', b, 'text'),
        checkInput('Ukázať aj zľavu v %', b, 'showDiscount', live),
        textInput('Štítok kampane (nepovinné)', b, 'label', { placeholder: 'napr. Black Friday', onchange: live }),
        selectInput('Centy', b, 'decimals', { always: 'Vždy (23,00 €)', auto: 'Vynechať pri celých cenách (23 €)' }, live),
        textInput('Najmenšia zľava v %, pri ktorej sa badge ukáže', b, 'minDiscount', { type: 'number', onchange: live }),
        checkInput('Badge s cenou aj pri produktoch bez zľavy', b, 'showWithoutSale', live)),
      h('details', {},
        h('summary', {}, 'Pokročilé: z ktorého poľa je prečiarknutá cena a pre ktoré produkty'),
        h('div', { class: 'grid', style: 'margin-top:10px' },
          textInput('Pole s pôvodnou (prečiarknutou) cenou', b, 'referenceField', { list: 'fields', onchange: live }),
          textInput('Pole s aktuálnou cenou', b, 'priceField', { list: 'fields', onchange: live })),
        h('p', { class: 'muted' }, 'Pri oznámení zľavy má byť prečiarknutá najnižšia cena za posledných 30 dní pred zľavou. Bežná cena z e-shopu to nemusí byť. Ak zdroj takú cenu posiela v inom poli, nastav ho sem.'),
        whenEditor(b))),

    h('h2', {}, 'Formát obrázka'),
    h('div', { class: 'card' }, h('div', { class: 'grid' },
      textInput('Veľkosť (px, štvorec)', s, 'size', { type: 'number', onchange: live }),
      selectInput('Fotka na štvorci', s, 'fit', { contain: 'Celá fotka (voľné miesto sa doplní)', cover: 'Orezať na stred' }, relayout),
      s.fit === 'cover' ? null : h('label', { class: 'f' }, 'Farba doplneného miesta',
        h('div', { class: 'row' },
          h('select', { onchange: (e) => { s.fill = e.target.value === 'auto' ? 'auto' : '#ffffff'; markDirty(); relayout(); } },
            h('option', { value: 'auto', selected: s.fill === 'auto' || !s.fill }, 'Automaticky podľa fotky'), h('option', { value: 'custom', selected: /^#/.test(s.fill || '') }, 'Vlastná…')),
          /^#/.test(s.fill || '') ? h('input', { type: 'color', value: s.fill, style: 'width:52px;flex:none', oninput: (e) => { s.fill = e.target.value; markDirty(); live(); } }) : null)),
      textInput('Kvalita JPEG', s, 'quality', { type: 'number', onchange: live }),
      checkInput('Jednotný štvorcový formát aj pre produkty bez badge', s, 'applyToAll', live),
      checkInput('Pôvodný obrázok pridať ako dodatočný', s, 'keepOriginalAsAdditional'))),

    h('h2', {}, 'Náhľad'),
    h('div', { class: 'card' },
      h('div', { class: 'row' },
        h('label', { class: 'f' }, 'Poradie položky', h('input', { type: 'number', value: imgPreview.index, min: 0, style: 'width:90px', oninput: (e) => { imgPreview.index = Number(e.target.value) || 0; previewSoon(); } })),
        h('label', { class: 'row', style: 'margin-top:18px' }, h('input', { type: 'checkbox', checked: imgPreview.sale, onchange: (e) => { imgPreview.sale = e.target.checked; previewSoon(); } }), 'preskočiť na zľavnený'),
        h('button', { class: 'btn', style: 'margin-top:18px', onclick: () => { imgPreview.index += 1; genPreview(); } }, 'Ďalší produkt'),
        h('button', { class: 'btn primary', style: 'margin-top:18px', onclick: genPreview }, 'Obnoviť náhľad')),
      h('p', { class: 'muted' }, 'Náhľad sa prekresľuje sám pri každej zmene, aj pred uložením.'),
      imgPreview.box),

    h('details', { class: 'card', open: s.base === 'background' },
      h('summary', {}, 'Výmena pozadia fotky (voliteľné)'),
      h('label', { class: 'f check' }, h('input', { type: 'checkbox', checked: s.base === 'background', onchange: (e) => { s.base = e.target.checked ? 'background' : 'photo'; markDirty(); relayout(); } }), 'Vystrihnúť produkt a dať ho na nové pozadie'),
      s.base !== 'background' ? null : h('div', {},
        h('div', { class: 'grid' },
          selectInput('Vystrihnutie produktu', s, 'provider', {
            whitekey: 'Lokálne - biele pozadie → priehľadné (zadarmo)',
            rembg: 'Vlastný rembg server (AI, zadarmo)',
            magnific: 'Magnific API (AI, platené kreditmi)',
            removebg: 'remove.bg API (platené)',
            none: 'Bez vystrihnutia (obrázok už je PNG s priehľadnosťou)',
          }, live),
          selectInput('Spôsob vloženia', s, 'mode', {
            cutout: 'Výrez produktu na pozadí',
            photo: 'Celá fotka ako karta (lifestyle zábery)',
            auto: 'Automaticky: čisté pozadie → výrez, inak karta',
          }, live),
          textInput('Citlivosť bielej (200-255)', s, 'whiteThreshold', { type: 'number', onchange: live }),
          textInput('Okraj (0-0.4)', s, 'padding', { type: 'number', onchange: live }),
          textInput('Posun produktu dole (-0.2 až 0.2)', s, 'offsetY', { type: 'number', onchange: live }),
          checkInput('Jemný tieň pod produktom', s, 'shadow', live)),
        h('h2', {}, 'Knižnica pozadí'),
        assetLibrary(),
        h('h2', {}, 'Predvolené pozadie'),
        backgroundEditor(s.background, live),
        h('h2', {}, 'Pozadia podľa podmienok'),
        h('p', { class: 'muted' }, 'Prvá zhoda vyhráva, ak žiadna nesedí, použije sa predvolené.'),
        s.backgrounds.map((bg, i) => h('div', { class: 'card rule' },
          h('div', { class: 'rule-head' }, h('b', {}, `Pozadie ${i + 1}`), h('span', { class: 'spacer' }),
            h('button', { class: 'btn small danger', onclick: () => { s.backgrounds.splice(i, 1); markDirty(); relayout(); } }, 'Zmazať')),
          backgroundEditor(bg.background, live), whenEditor(bg))),
        h('button', { class: 'btn', onclick: () => { s.backgrounds.push({ when: [{ field: 'product_type', op: 'contains', value: '' }], background: { type: 'gradient', color: '#ffe8e8', color2: '#e8f0ff', angle: 160 } }); markDirty(); render(); } }, '+ Pridať pozadie podľa podmienky'))),
    h('datalist', { id: 'fields' }, FIELDS.map((f) => h('option', { value: f }))));
}

function assetLibrary() {
  const gen = { name: '', prompt: '' };
  const status = h('span', { class: 'muted' });
  const refresh = async () => { state.assets = await api('/assets'); render(); };
  return h('div', {},
    state.assets.length ? h('div', { class: 'assets' }, state.assets.map((a) => h('div', { class: 'asset' },
      h('img', { src: a.url, loading: 'lazy', alt: '' }),
      h('div', { class: 'row' }, h('span', {}, a.name), h('span', { class: 'spacer' }),
        h('button', { class: 'btn small danger', onclick: async () => {
          if (!confirm(`Zmazať „${a.name}“ z knižnice? Projekty, ktoré ho používajú, začnú pri obrázkoch hlásiť chybu.`)) return;
          try { await api('/assets/' + a.name, { method: 'DELETE' }); await refresh(); } catch (e) { toast(e.message, true); }
        } }, '×')))))
      : h('p', { class: 'muted' }, 'Knižnica je prázdna. Nahraj obrázok pri výbere pozadia nižšie alebo si ho nechaj vygenerovať.'),
    h('div', { class: 'grid', style: 'margin-top:12px' },
      textInput('Názov nového pozadia', gen, 'name', { placeholder: 'napr. jar-pastel' }),
      textInput('Popis pre AI (najlepšie po anglicky)', gen, 'prompt', { placeholder: 'Empty product backdrop, pastel studio, soft daylight, no text' })),
    h('div', { class: 'row', style: 'margin-top:8px' },
      h('button', { class: 'btn', onclick: async (e) => {
        e.target.disabled = true; status.textContent = 'Generujem, trvá to do minúty…';
        try {
          await api('/assets/generate', { method: 'POST', body: { name: slugify(gen.name), prompt: gen.prompt } });
          toast('Pozadie pridané do knižnice'); await refresh();
        } catch (err) { toast(err.message, true); status.textContent = ''; e.target.disabled = false; }
      } }, 'Vygenerovať cez Magnific'), status));
}

// --- náhľad pravidiel
function tabPreview() {
  const p = state.cur;
  const box = h('div', {});
  const draw = () => {
    const d = state.preview;
    if (!d) { box.replaceChildren(h('p', { class: 'muted' }, 'Stiahne zdrojový feed a ukáže, ako by vyzeral po pravidlách (bez obrázkov, aj s neuloženými zmenami).')); return; }
    box.replaceChildren(
      h('p', {}, `Položiek: ${d.total} · vylúčených: ${d.excluded} · s chybami pre ${CHANNELS[d.channel] || 'kanál'}: `, h('b', { style: d.invalid ? 'color:var(--err)' : '' }, String(d.invalid)), ` · zobrazených: ${d.rows.length}`),
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
  const picker = profilePicker(() => { state.preview = null; draw(); });
  return h('div', {},
    h('div', { class: 'row' }, picker,
      h('button', { class: 'btn primary', onclick: async (e) => {
        e.target.disabled = true; e.target.textContent = 'Načítavam…';
        try { state.preview = await api(`/projects/${p.id}/preview`, { method: 'POST', body: { config: p.config, source_url: p.source_url, limit: 80, profile: state.viewProfile } }); }
        catch (err) { toast(err.message, true); }
        e.target.disabled = false; e.target.textContent = 'Načítať náhľad'; draw();
      } }, 'Načítať náhľad')),
    h('div', { style: 'margin-top:14px' }, box));
}

// --- výstup: to, čo je práve zverejnené vo feede
async function loadOutput() {
  if (!state.cur) return;
  const id = state.cur.id;
  const want = state.viewProfile;
  const q = want ? `?profile=${encodeURIComponent(want)}` : '';
  const data = await api(`/projects/${id}/output${q}`).catch((e) => ({ error: e.message, items: [] }));
  if (state.cur?.id !== id || state.viewProfile !== want) return; // medzitým prepnutý projekt alebo profil
  state.output = data;
  if (state.tab === 'output') document.getElementById('tab-body')?.replaceChildren(tabOutput());
}

function tabOutput() {
  const d = state.output;
  const picker = profilePicker(() => { state.output = null; document.getElementById('tab-body')?.replaceChildren(tabOutput()); loadOutput(); });
  const head = picker ? h('div', { class: 'row', style: 'margin-bottom:10px' }, picker) : null;
  if (!d) return h('div', {}, head, h('p', { class: 'muted' }, 'Načítavam…'));
  if (d.error) return h('div', {}, head, h('p', { style: 'color:var(--err)' }, d.error));
  if (!d.items.length) return h('div', {}, head, h('p', { class: 'muted' }, 'Feed tohto profilu ešte nebol vygenerovaný. Klikni na „Spustiť teraz“.'));
  return h('div', {}, head,
    h('p', { class: 'muted' }, `Zverejnený feed: ${d.items.length} položiek, vygenerovaný ${new Date(d.generated_at).toLocaleString('sk-SK')}. Toto si sťahuje kanál.`),
    h('div', { class: 'gallery' }, d.items.map((it) => h('div', { class: 'gcard' },
      h('a', { href: it.image_link, target: '_blank', rel: 'noopener' }, h('img', { src: it.image_link, loading: 'lazy', alt: '' })),
      h('div', { class: 'gbody' },
        h('div', { class: 'gtitle' }, it.title),
        h('div', {}, it.sale_price ? [h('span', { class: 'old' }, it.price), it.sale_price] : it.price,
          !['in stock', 'in_stock'].includes(it.availability) ? h('span', { class: 'tag warning', style: 'margin-left:6px' }, it.availability) : null),
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
      ...(r.summary?.warnings?.length ? [h('details', { open: true }, h('summary', {}, `Upozornenia (${r.summary.warnings.length})`), h('pre', { class: 'log' }, r.summary.warnings.join('\n')))] : []));
  };
  return h('div', {},
    state.runs.length ? h('table', {},
      h('thead', {}, h('tr', {}, ['Začiatok (UTC)', 'Stav', 'Vstup', 'Profily: zapísané / vylúčené', 'Obrázky nové/cache/chyby', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, state.runs.map((r) => {
        const s = r.summary || {};
        const per = s.profiles ? Object.entries(s.profiles).map(([slug, x]) => h('div', {},
          h('span', { class: 'tag' + (x.error ? ' err' : '') }, slug), x.error ? x.error : `${x.written} / ${x.excluded}`, x.invalid ? h('span', { class: 'tag err' }, `${x.invalid} chybných`) : null))
          : (s.error ?? `${s.written ?? ''} / ${s.excluded ?? ''}`); // staršie behy a zlyhanie zdroja
        return h('tr', {},
          h('td', {}, r.started_at), h('td', {}, h('span', { class: 'tag ' + r.status }, r.status)),
          h('td', {}, s.total ?? ''), h('td', {}, per),
          h('td', {}, s.images ? `${s.images.generated}/${s.images.cached}/${s.images.failed}` : ''),
          h('td', {}, h('button', { class: 'btn small', onclick: () => show(r.id) }, 'Log')));
      }))) : h('p', { class: 'muted' }, 'Zatiaľ žiadne behy. Klikni na „Spustiť teraz“.'),
    h('div', { style: 'margin-top:14px' }, logBox));
}

window.addEventListener('beforeunload', (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });
api('/assets').then((a) => { state.assets = a; }).catch(() => {}).then(loadProjects)
  .catch((e) => { document.getElementById('main').textContent = 'Chyba: ' + e.message; });
