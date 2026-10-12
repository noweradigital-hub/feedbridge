// Bezpečné sťahovanie URL, ktoré prichádzajú z dát (zdrojový feed, image_link vo feede, URL pozadia).
// Server beží na zdieľanom VPS vedľa interných služieb, preto takéto požiadavky nesmú skončiť
// na privátnej adrese ani po presmerovaní alebo zmene DNS (SSRF).
// Adresy z vlastnej konfigurácie (REMBG_URL, NOTIFY_WEBHOOK_URL) idú zámerne bežným fetch.
import dns from 'node:dns';
import net from 'node:net';
import { fetch as undiciFetch, Agent } from 'undici';

const blocked = new net.BlockList();
for (const [addr, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(addr, bits, 'ipv4');
for (const [addr, bits] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10],
  ['ff00::', 8], ['2001:db8::', 32],
]) blocked.addSubnet(addr, bits, 'ipv6');

/** true = verejná adresa, na ktorú sa smie server pripojiť. */
export function isPublicAddress(ip) {
  let address = String(ip);
  let family = net.isIP(address);
  if (!family) return false;
  // IPv4 zabalená v IPv6 (::ffff:127.0.0.1 aj ::ffff:7f00:1) sa posudzuje ako IPv4.
  // Pozor: do BlockListu nedávať ::ffff:0:0/96, zablokovalo by to všetky IPv4 adresy.
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (dotted) { address = dotted[1]; family = 4; }
  else if (hex) {
    const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
    address = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`; family = 4;
  }
  return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export class BlockedAddressError extends Error {
  constructor(host) {
    super(`Adresa ${host} smeruje do internej siete, sťahovanie je zablokované`);
    this.code = 'EBLOCKED';
  }
}

// Výnimky pre vývoj a testy: ALLOW_PRIVATE_FETCH=1 povolí všetko,
// FETCH_ALLOW_HOSTS=host:port,host povolí konkrétne ciele.
function isAllowlisted(u) {
  if (process.env.ALLOW_PRIVATE_FETCH === '1') return true;
  const list = (process.env.FETCH_ALLOW_HOSTS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  return list.includes(u.host.toLowerCase()) || list.includes(u.hostname.toLowerCase());
}

// Kontrola až pri spájaní: platí pre adresu, na ktorú sa naozaj ide, nie pre skorší DNS dotaz.
function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const ok = addresses.filter((a) => isPublicAddress(a.address));
    if (!ok.length) return callback(new BlockedAddressError(hostname));
    if (options.all) return callback(null, ok);
    callback(null, ok[0].address, ok[0].family);
  });
}

const guardedAgent = new Agent({ connect: { lookup: guardedLookup } });
const openAgent = new Agent();

async function readCapped(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (declared > maxBytes) {
    await res.body?.cancel().catch(() => {}); // inak by spojenie viselo až do časového limitu
    throw new Error(`Odpoveď je väčšia než ${Math.round(maxBytes / 1048576)} MB`);
  }
  if (!res.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > maxBytes) throw new Error(`Odpoveď je väčšia než ${Math.round(maxBytes / 1048576)} MB`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * GET s kontrolou cieľa pri každom skoku presmerovania, s časovým limitom a stropom veľkosti.
 * Vráti { status, ok, headers, body: Buffer, url }.
 */
export async function safeFetch(url, { headers = {}, timeoutMs = 30000, maxBytes = 25 * 1024 * 1024, maxRedirects = 5 } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  let current = String(url);
  for (let hop = 0; ; hop++) {
    let u;
    try { u = new URL(current); } catch { throw new Error(`Neplatná URL: ${current}`); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Povolené sú len http(s) adresy');
    const allow = isAllowlisted(u);
    const literal = u.hostname.replace(/^\[|\]$/g, '');
    if (!allow && net.isIP(literal) && !isPublicAddress(literal)) throw new BlockedAddressError(u.hostname);
    let res;
    try {
      res = await undiciFetch(u, { headers, redirect: 'manual', signal, dispatcher: allow ? openAgent : guardedAgent });
    } catch (e) {
      for (let c = e; c; c = c.cause) if (c.code === 'EBLOCKED') throw c;
      if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new Error(`Časový limit ${Math.round(timeoutMs / 1000)} s vypršal: ${u.host}`);
      throw new Error(`Spojenie zlyhalo (${e.cause?.code || e.cause?.message || e.message}): ${u.host}`);
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      await res.body?.cancel().catch(() => {});
      if (!location) throw new Error(`Presmerovanie bez cieľa: ${u.host}`);
      if (hop >= maxRedirects) throw new Error(`Priveľa presmerovaní: ${u.host}`);
      current = new URL(location, u).href;
      continue;
    }
    const body = await readCapped(res, maxBytes);
    return { status: res.status, ok: res.ok, headers: res.headers, body, url: u.href };
  }
}
