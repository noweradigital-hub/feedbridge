import crypto from 'node:crypto';
import { RULE_TYPES } from './feed/rules.js';
import { own, MAX_OVERRIDES } from './campaigns.js';
import { IMAGE_MODES } from './db.js';
import { TAG_POSITIONS, LAYOUTS } from './badge.js';

/**
 * Zmeny projektu ako zoznam typovaných operácií (MCP nástroje). Operácie sa najprv pripravia
 * (server ukáže, čo sa zmení a koľko produktov bude v ktorom feede) a uložia sa až potvrdením,
 * naraz a len ak sa projekt medzitým nezmenil (rev). Tu je len čistá logika nad kópiou projektu.
 */

export class ChangeError extends Error {
  constructor(message, status = 400, code) { super(message); this.status = status; if (code) this.code = code; }
}
const fail = (m) => { throw new ChangeError(m); };

const CHANNELS = ['meta', 'google', 'chatgpt'];
const COND_OPS = ['eq', 'neq', 'contains', 'ncontains', 'regex', 'empty', 'nempty', 'in', 'nin', 'gt', 'lt', 'gte', 'lte'];
const isHex = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const str = (v, max = 500) => (v === undefined || v === null ? '' : String(v)).slice(0, max);
const slugify = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const newRuleId = () => 'r' + crypto.randomBytes(5).toString('hex').slice(0, 9);
const campaignId = (s) => slugify(s).slice(0, 36).replace(/-+$/, '') || 'akcia'; // normalizeCampaigns berie najviac 41 znakov

/**
 * Regex sa vyhodnocuje synchrónne nad každým produktom: vnorené opakovanie typu (a+)+ by vedelo
 * zaseknúť server už pri príprave zmeny. Odmietneme ho spolu s príliš dlhými vzormi.
 */
function safeRegex(src, label) {
  const s = String(src ?? '');
  if (s.length > 2000) fail(`${label}: regex je príliš dlhý`);
  // opakovaná skupina ((a+)+, (a|aa)+, (?:x)*…) je pôvodom exponenciálneho backtrackingu: skupina smie byť
  // len raz alebo s ?. Prechádza sa po znakoch (escape, triedy [..]), nie regexom nad regexom.
  let inClass = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') { i++; continue; }
    if (inClass) { if (ch === ']') inClass = false; continue; }
    if (ch === '[') { inClass = true; continue; }
    if (ch === ')' && /^\s*[+*{]/.test(s.slice(i + 1))) fail(`${label}: opakovaná skupina v regexe (napr. (a+)+ alebo (a|b)+) nie je povolená, použi triedu znakov [ab]+`);
  }
  if (/(\.\*|\.\+){2,}/.test(s)) fail(`${label}: regex s .*.* nie je povolený`);
  try { new RegExp(s); } catch { fail(`${label}: neplatný regex`); }
}

function conditions(when, label) {
  if (when === undefined) return undefined;
  if (!Array.isArray(when)) fail(`${label}: podmienky (when) musia byť zoznam`);
  return when.map((c, i) => {
    if (!c || typeof c.field !== 'string' || !c.field.trim()) fail(`${label}: podmienka ${i + 1} nemá pole`);
    if (!COND_OPS.includes(c.op)) fail(`${label}: neznámy operátor „${c.op}“ (povolené: ${COND_OPS.join(', ')})`);
    if (c.op === 'regex') safeRegex(c.value, label);
    const value = Array.isArray(c.value) ? c.value.map(String).join(',') : str(c.value, 100000);
    return { field: c.field.trim(), op: c.op, value };
  });
}

function profileOf(cfg, slug) {
  const p = cfg.profiles.find((x) => x.slug === slug);
  if (!p) fail(`Profil „${slug}“ v projekte nie je (profily: ${cfg.profiles.map((x) => x.slug).join(', ')})`);
  return p;
}

/** Zoznam pravidiel podľa rozsahu: 'project' alebo slug profilu. */
function rulesOf(cfg, scope) {
  if (!scope || scope === 'project') return { list: cfg.rules, where: 'projekt' };
  const p = profileOf(cfg, scope);
  return { list: p.rules, where: `profil ${p.slug}` };
}

function findRule(cfg, id) {
  for (const s of [{ list: cfg.rules, where: 'projekt' }, ...cfg.profiles.map((p) => ({ list: p.rules, where: `profil ${p.slug}` }))]) {
    const i = s.list.findIndex((r) => r.id === id);
    if (i >= 0) return { ...s, index: i };
  }
  return fail(`Pravidlo „${id}“ neexistuje`);
}

function ruleBody(rule, label) {
  if (!rule || typeof rule !== 'object') fail(`${label}: chýba pravidlo`);
  if (!RULE_TYPES.includes(rule.type)) fail(`${label}: neznámy typ „${rule.type}“ (povolené: ${RULE_TYPES.join(', ')})`);
  // polia, ktoré pozná applyRules (rules.js); ostatné sa zahodia
  const out = {};
  for (const k of ['type', 'field', 'value', 'find', 'with', 'mode', 'note']) if (rule[k] !== undefined) out[k] = str(rule[k], 5000);
  if (rule.length !== undefined) { const n = Number(rule.length); if (!Number.isInteger(n) || n < 1 || n > 10000) fail(`${label}: length musí byť 1 až 10000`); out.length = n; }
  if (rule.regex !== undefined) out.regex = rule.regex === true;
  if (rule.onlyIfEmpty !== undefined) out.onlyIfEmpty = rule.onlyIfEmpty === true;
  if (out.regex && out.find !== undefined) safeRegex(out.find, label);
  if (out.mode !== undefined && rule.type === 'price' && !['percent', 'add', 'round'].includes(out.mode)) fail(`${label}: mode pre price musí byť percent | add | round`);
  if (rule.enabled === false) out.enabled = false;
  if (rule.when !== undefined) out.when = conditions(rule.when, label);
  if (rule.type !== 'exclude' && !out.field) fail(`${label}: pravidlo typu ${rule.type} potrebuje pole (field)`);
  return out;
}

function place(list, item, op) {
  const ref = op.before ?? op.after;
  if (ref === undefined) { list.push(item); return; }
  const i = list.findIndex((r) => r.id === ref);
  if (i < 0) fail(`Pravidlo „${ref}“ pre umiestnenie nie je v tom istom zozname`);
  list.splice(op.before !== undefined ? i : i + 1, 0, item);
}

function openaiPatch(cur, o) {
  if (o === undefined) return cur;
  if (!o || typeof o !== 'object') fail('openai musí byť objekt');
  const next = { ...(cur || {}) };
  for (const k of ['sellerName', 'sellerUrl', 'returnPolicy', 'country']) if (o[k] !== undefined) next[k] = str(o[k], 500);
  if (o.returnDays !== undefined) next.returnDays = Number(o.returnDays);
  if (o.ads !== undefined) next.ads = o.ads !== false;
  return next;
}

function profileFields(p, op, label) {
  if (op.name !== undefined) p.name = str(op.name, 80).trim() || p.name;
  if (op.enabled !== undefined) p.enabled = op.enabled !== false;
  if (op.imageMode !== undefined) {
    if (!IMAGE_MODES.includes(op.imageMode)) fail(`${label}: imageMode musí byť ${IMAGE_MODES.join(' | ')}`);
    p.imageMode = op.imageMode; p.imageModeVersion = 2;
  }
  if (op.tagPosition !== undefined) {
    if (!TAG_POSITIONS.includes(op.tagPosition)) fail(`${label}: tagPosition musí byť ${TAG_POSITIONS.join(' | ')}`);
    p.tagPosition = op.tagPosition;
  }
  if (op.openai !== undefined) p.openai = openaiPatch(p.openai, op.openai);
}

/**
 * Nastavenia produktov (akcia, šablóna, ceny) ako POST /assign: mení sa len to, čo je v `set`.
 * Vráti nové mapy products a groups.
 */
export function assignOverrides(cfg, { ids = [], groups = [], reset = [], set = {}, explicit = false }) {
  const keys = (v) => (Array.isArray(v) ? [...new Set(v.map(String).filter(Boolean))] : []);
  ids = keys(ids); groups = keys(groups); reset = keys(reset);
  if (!set || typeof set !== 'object' || (!ids.length && !groups.length)) fail('Chýba výber produktov alebo to, čo sa má nastaviť');
  if (ids.length + groups.length + reset.length > MAX_OVERRIDES) fail('Priveľa produktov naraz');
  for (const k of [...ids, ...groups, ...reset]) {
    if (k.length > 120 || ['__proto__', 'constructor', 'prototype'].includes(k)) fail(`ID „${k.slice(0, 40)}“ sa nedá použiť ako kľúč nastavenia`);
  }
  if (set.campaign !== undefined && !['auto', 'none'].includes(set.campaign) && !cfg.campaigns.some((c) => c.id === set.campaign)) fail('Táto akcia v projekte neexistuje');
  if (set.layout !== undefined && set.layout !== '' && set.layout !== 'default' && !Object.hasOwn(LAYOUTS, set.layout)) fail('Neznáma šablóna');
  if (set.prices !== undefined && !['auto', 'hide', 'show'].includes(set.prices)) fail('prices musí byť auto | hide');
  const patch = (map, list, clearOnly) => {
    const out = Object.assign(Object.create(null), map); // kľúče sú ID z požiadavky, nesmú siahnuť na prototyp
    for (const k of list) {
      const cur = { ...(own(map, k) || {}) };
      const put = (field, value, isDefault, marker) => {
        if (value === undefined) return;
        if (clearOnly || (isDefault && !explicit)) delete cur[field];
        else cur[field] = isDefault ? marker : value;
      };
      put('campaign', set.campaign, set.campaign === 'auto', 'auto');
      put('layout', set.layout, !set.layout || set.layout === 'default', 'default');
      put('prices', set.prices, set.prices !== 'hide', 'show');
      out[k] = cur; // prázdne záznamy vyhodí normalizácia
    }
    return { ...out };
  };
  const products = patch(patch(cfg.products, reset, true), ids, false);
  const grouped = patch(cfg.groups, groups, false);
  const filled = (m) => Object.values(m).filter((v) => Object.keys(v).length).length;
  if (filled(products) > MAX_OVERRIDES || filled(grouped) > MAX_OVERRIDES) {
    fail(`Projekt môže mať najviac ${MAX_OVERRIDES} vlastných nastavení produktov. Použi radšej podmienku v akcii alebo výber profilu.`);
  }
  return { products, groups: grouped };
}

/**
 * Použije operácie na kópiu projektu { name, slug, source_url, interval_minutes, enabled, config }.
 * Vráti { data, summary } (summary = čo sa zmenilo, po slovensky). Pri neplatnej operácii ChangeError(400).
 */
export function applyOps(project, ops) {
  if (!Array.isArray(ops) || !ops.length) fail('Chýbajú operácie (ops)');
  if (ops.length > 50) fail('Najviac 50 operácií naraz');
  const data = structuredClone({
    name: project.name, slug: project.slug, source_url: project.source_url,
    interval_minutes: project.interval_minutes, enabled: project.enabled, config: project.config,
  });
  const cfg = data.config;
  for (const p of cfg.profiles) { delete p.feed_url; delete p.has_feed; }
  const summary = [];
  ops.forEach((op, n) => {
    const label = `Operácia ${n + 1} (${op?.op})`;
    if (!op || typeof op.op !== 'string') fail(`Operácia ${n + 1}: chýba op`);
    switch (op.op) {
      case 'create_profile': {
        if (!CHANNELS.includes(op.channel)) fail(`${label}: channel musí byť ${CHANNELS.join(' | ')}`);
        const name = str(op.name, 80).trim() || op.channel;
        let slug = op.slug ? String(op.slug).toLowerCase() : slugify(`${project.slug}-${name}`).slice(0, 60).replace(/-+$/, '');
        if (!op.slug) for (let i = 2; cfg.profiles.some((x) => x.slug === slug); i++) slug = `${slugify(`${project.slug}-${name}`).slice(0, 56)}-${i}`;
        if (cfg.profiles.some((x) => x.slug === slug)) fail(`${label}: profil „${slug}“ už existuje`);
        const p = { slug, name, channel: op.channel, enabled: op.enabled !== false, imageMode: op.channel === 'meta' ? 'project' : 'original', imageModeVersion: 2,
          campaign: '', tagPosition: 'auto', selection: { mode: 'all', ids: [], groups: [], when: [] }, rules: [] };
        profileFields(p, { ...op, name: undefined, enabled: undefined }, label);
        if (op.campaign) { if (!cfg.campaigns.some((c) => c.id === op.campaign)) fail(`${label}: akcia „${op.campaign}“ neexistuje`); p.campaign = op.campaign; }
        if (op.channel === 'chatgpt' && !p.openai?.sellerName) fail(`${label}: ChatGPT profil potrebuje openai.sellerName`);
        cfg.profiles.push(p);
        summary.push(`Nový feed „${name}“ (${op.channel}) → /feeds/${slug}${op.channel === 'chatgpt' ? '.jsonl.gz' : '.xml'}${p.enabled ? '' : ', vypnutý'}`);
        break;
      }
      case 'update_profile': {
        const p = profileOf(cfg, op.profile);
        profileFields(p, op, label);
        if (op.campaign !== undefined) {
          if (op.campaign && !cfg.campaigns.some((c) => c.id === op.campaign)) fail(`${label}: akcia „${op.campaign}“ neexistuje`);
          p.campaign = op.campaign || '';
        }
        const what = ['name', 'enabled', 'imageMode', 'campaign', 'tagPosition', 'openai'].filter((k) => op[k] !== undefined);
        summary.push(`Feed ${p.slug}: zmena ${what.join(', ') || 'žiadna'}`);
        break;
      }
      case 'set_selection': {
        const p = profileOf(cfg, op.profile);
        if (!['all', 'ids', 'filter'].includes(op.mode)) fail(`${label}: mode musí byť all | ids | filter`);
        const list = (v) => (Array.isArray(v) ? v.map(String) : []);
        p.selection = { mode: op.mode, ids: list(op.ids), groups: list(op.groups), when: conditions(op.when, label) || [] };
        if (op.mode === 'ids' && !p.selection.ids.length && !p.selection.groups.length) fail(`${label}: výber podľa ID potrebuje ids alebo groups`);
        if (op.mode === 'filter' && !p.selection.when.length) fail(`${label}: výber podľa podmienok potrebuje when`);
        summary.push(`Feed ${p.slug}: výber produktov ${op.mode === 'all' ? 'všetky' : op.mode === 'ids' ? `${p.selection.ids.length} ID${p.selection.groups.length ? ` + ${p.selection.groups.length} skupín` : ''}` : `podľa ${p.selection.when.length} podmienok`}`);
        break;
      }
      case 'add_rule':
      case 'set_custom_label': {
        const { list, where } = rulesOf(cfg, op.scope);
        let rule;
        if (op.op === 'set_custom_label') {
          const n = Number(op.label);
          if (!Number.isInteger(n) || n < 0 || n > 4) fail(`${label}: label musí byť 0 až 4`);
          rule = ruleBody({ type: 'set', field: `custom_label_${n}`, value: op.value, when: op.when, note: op.note || 'custom label' }, label);
        } else rule = ruleBody(op.rule, label);
        rule.id = newRuleId();
        place(list, rule, op);
        summary.push(`${where}: nové pravidlo ${rule.type}${rule.field ? ` ${rule.field}` : ''}${rule.value !== undefined ? ` = „${String(rule.value).slice(0, 60)}“` : ''}${rule.when?.length ? ` (${rule.when.length} podm.)` : ''} [${rule.id}]`);
        break;
      }
      case 'update_rule': {
        const { list, index, where } = findRule(cfg, op.rule_id);
        if (!op.patch || typeof op.patch !== 'object') fail(`${label}: chýba patch`);
        const merged = ruleBody({ ...list[index], ...op.patch }, label);
        list[index] = { ...merged, id: list[index].id };
        summary.push(`${where}: upravené pravidlo ${op.rule_id} (${Object.keys(op.patch).join(', ')})`);
        break;
      }
      case 'remove_rule': {
        const { list, index, where } = findRule(cfg, op.rule_id);
        const [r] = list.splice(index, 1);
        summary.push(`${where}: zmazané pravidlo ${r.type}${r.field ? ` ${r.field}` : ''} [${r.id}]`);
        break;
      }
      case 'move_rule': {
        const { list, index, where } = findRule(cfg, op.rule_id);
        if (op.before === undefined && op.after === undefined) fail(`${label}: chýba before alebo after`);
        const [r] = list.splice(index, 1);
        place(list, r, op);
        summary.push(`${where}: presunuté pravidlo ${r.id}`);
        break;
      }
      case 'upsert_campaign': {
        let c = op.id ? cfg.campaigns.find((x) => x.id === op.id) : null;
        if (op.id && !c && !op.name) fail(`${label}: akcia „${op.id}“ neexistuje`);
        const isNew = !c;
        if (isNew) {
          if (!slugify(op.id || op.name)) fail(`${label}: akcia potrebuje názov`);
          let id = campaignId(op.id || op.name);
          for (let i = 2; cfg.campaigns.some((x) => x.id === id); i++) id = `${campaignId(op.id || op.name)}-${i}`;
          c = { id, name: '', color: '#000000', textColor: 'auto', enabled: true, from: '', to: '', layout: '', when: [] };
          cfg.campaigns.push(c);
        }
        if (op.name !== undefined) c.name = str(op.name, 40).trim() || c.name;
        if (op.color !== undefined) { if (!isHex(op.color)) fail(`${label}: farba musí byť #rrggbb`); c.color = op.color.toLowerCase(); }
        if (op.enabled !== undefined) c.enabled = op.enabled !== false;
        for (const k of ['from', 'to']) if (op[k] !== undefined) { if (op[k] && !isDay(op[k])) fail(`${label}: ${k} musí byť YYYY-MM-DD`); c[k] = op[k] || ''; }
        if (op.layout !== undefined) { if (op.layout && !Object.hasOwn(LAYOUTS, op.layout)) fail(`${label}: neznáma šablóna`); c.layout = op.layout || ''; }
        if (op.when !== undefined) c.when = conditions(op.when, label);
        summary.push(`${isNew ? 'Nová akcia' : 'Akcia'} „${c.name}“ [${c.id}]${c.from || c.to ? ` ${c.from || '…'} – ${c.to || '…'}` : ''}${c.when.length ? `, automaticky pre ${c.when.length} podm.` : ''}`);
        break;
      }
      case 'assign_products': {
        const set = {};
        for (const k of ['campaign', 'layout', 'prices']) if (op[k] !== undefined) set[k] = op[k];
        if (!Object.keys(set).length) fail(`${label}: chýba campaign, layout alebo prices`);
        const { products, groups } = assignOverrides(cfg, { ids: op.ids, groups: op.groups, set, explicit: op.explicit === true });
        cfg.products = products; cfg.groups = groups;
        summary.push(`Nastavenie ${(op.ids || []).length} produktov${(op.groups || []).length ? ` a ${op.groups.length} skupín` : ''}: ${Object.entries(set).map(([k, v]) => `${k}=${v || 'predvolené'}`).join(', ')}`);
        break;
      }
      case 'update_project': {
        if (op.name !== undefined) data.name = str(op.name, 120).trim() || data.name;
        if (op.enabled !== undefined) data.enabled = op.enabled !== false;
        if (op.interval_minutes !== undefined) data.interval_minutes = Number(op.interval_minutes);
        if (op.source_url !== undefined) data.source_url = str(op.source_url, 2000).trim();
        summary.push(`Projekt: zmena ${['name', 'enabled', 'interval_minutes', 'source_url'].filter((k) => op[k] !== undefined).join(', ')}`);
        break;
      }
      default: fail(`${label}: neznáma operácia`);
    }
  });
  return { data, summary };
}

/** Pripravené zmeny čakajúce na potvrdenie (v pamäti procesu, 30 minút). */
const prepared = new Map();
const TTL = 30 * 60_000;
export const changes = {
  put(entry) {
    const now = Date.now();
    for (const [k, v] of prepared) if (now - v.at > TTL) prepared.delete(k);
    while (prepared.size >= 50) prepared.delete(prepared.keys().next().value);
    const id = 'ch_' + crypto.randomBytes(9).toString('base64url');
    prepared.set(id, { ...entry, at: now });
    return id;
  },
  take(id) {
    const e = prepared.get(id);
    if (!e || Date.now() - e.at > TTL) { prepared.delete(id); return null; }
    return e;
  },
  drop(id) { prepared.delete(id); },
};
