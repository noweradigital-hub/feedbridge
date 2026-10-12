import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true, // g:price -> price
  parseTagValue: false, // ID-čka ako "00123" nechceme meniť na čísla
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => name === 'item' || name === 'additional_image_link' || name === 'shipping',
});

/**
 * Načíta RSS 2.0 / Google Merchant feed (formát, ktorý generujú Woo pluginy).
 * Vráti { channel: {title, link, description}, items: [ {id, title, ...} ] }
 * Hodnoty sú string, pole stringov (additional_image_link) alebo vnorený objekt (shipping).
 */
export function parseFeed(xml) {
  const doc = parser.parse(xml);
  const channel = doc?.rss?.channel;
  if (!channel) throw new Error('Feed nie je RSS 2.0 (chýba <rss><channel>). Atom a CSV zatiaľ nie sú podporované.');
  const rawItems = channel.item || [];
  const items = rawItems.map((it) => {
    const out = {};
    for (const [k, v] of Object.entries(it)) out[k] = v === '' ? '' : v;
    return out;
  });
  return {
    channel: {
      title: str(channel.title),
      link: str(channel.link),
      description: str(channel.description),
    },
    items,
  };
}

function str(v) {
  return typeof v === 'string' ? v : '';
}
