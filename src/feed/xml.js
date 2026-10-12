// Serializácia do Google/Meta RSS 2.0 feedu.
// title/link/description idú bez g: prefixu, ostatné s g:.
const PLAIN = new Set(['title', 'link', 'description', 'guid', 'pubDate', 'category']);

// eslint-disable-next-line no-control-regex
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

export function esc(s) {
  return String(s)
    .replace(INVALID_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function tag(name, plain) {
  return plain ? name : `g:${name}`;
}

function serialize(name, value, plain, indent) {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map((v) => serialize(name, v, plain, indent)).join('');
  const t = tag(name, plain);
  if (typeof value === 'object') {
    const inner = Object.entries(value)
      .map(([k, v]) => serialize(k, v, false, indent + '  '))
      .join('');
    return `${indent}<${t}>\n${inner}${indent}</${t}>\n`;
  }
  const s = String(value);
  if (s === '') return '';
  return `${indent}<${t}>${esc(s)}</${t}>\n`;
}

export function buildFeedXml(channel, items) {
  let out = '<?xml version="1.0" encoding="UTF-8"?>\n';
  out += '<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">\n<channel>\n';
  out += `  <title>${esc(channel.title || 'Feed')}</title>\n`;
  out += `  <link>${esc(channel.link || '')}</link>\n`;
  out += `  <description>${esc(channel.description || 'Upravený produktový feed')}</description>\n`;
  for (const it of items) {
    out += '  <item>\n';
    for (const [k, v] of Object.entries(it)) {
      out += serialize(k, v, PLAIN.has(k), '    ');
    }
    out += '  </item>\n';
  }
  out += '</channel>\n</rss>\n';
  return out;
}
