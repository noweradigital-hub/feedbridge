// Upozornenia na webhook (n8n, Slack…) pri ZMENE stavu behu. Opakovaná rovnaká chyba sa neposiela znova.
import { config } from './config.js';

const EVENTS = { error: 'run_failed', warning: 'run_warning', ok: 'recovered' };

/** prevStatus = stav projektu pred behom (null pri prvom behu). Vráti odoslaný payload alebo null. */
export async function notifyRun(project, prevStatus, { status, summary }) {
  if (!config.notifyWebhook) return null;
  if (status === prevStatus) return null;
  if (status === 'ok' && !['error', 'warning'].includes(prevStatus)) return null; // prvý alebo bežný úspech netreba hlásiť
  const payload = {
    event: summary?.guard ? 'guard_blocked' : EVENTS[status] || status,
    status,
    previous: prevStatus || null,
    project: { id: project.id, name: project.name, slug: project.slug },
    message: summary?.error
      || (status === 'warning' ? `Feed zapísaný s upozorneniami: ${summary.invalid} chybných položiek, ${summary.images?.failed || 0} zlyhaných obrázkov` : 'Feed je opäť v poriadku'),
    summary,
    feed_url: `${config.publicUrl}/feeds/${project.slug}.xml`,
    admin_url: `${config.publicUrl}/admin/`,
    at: new Date().toISOString(),
  };
  try {
    const res = await fetch(config.notifyWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'FeedBridge/1.0' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) console.error(`notify: webhook vrátil HTTP ${res.status}`);
  } catch (e) {
    console.error('notify:', e.message);
  }
  return payload;
}
