import { projects, runs } from './db.js';
import { runProject } from './feed/pipeline.js';
import { notifyRun } from './notify.js';
import { pruneCache } from './images.js';

const running = new Set();

export function isRunning(projectId) {
  return running.has(projectId);
}

/** Spustí beh projektu (zabráni súbežnému behu toho istého projektu). force = obíď poistku poklesu. */
export async function triggerRun(projectId, { force = false } = {}) {
  const project = projects.get(projectId);
  if (!project) throw new Error('Projekt neexistuje');
  if (running.has(projectId)) throw new Error('Projekt sa práve spracúva');
  running.add(projectId);
  const runId = runs.start(projectId);
  const lines = [];
  const log = (m) => lines.push(`${new Date().toISOString().slice(11, 19)} ${m}`);
  let result;
  try {
    const summary = await runProject(project, log, { force });
    // summary.error = aspoň jeden profil nezapísal (napr. poistka); ostatné profily zapísané sú
    const status = summary.error ? 'error' : summary.images.failed > 0 || summary.invalid > 0 ? 'warning' : 'ok';
    result = { runId, status, summary };
  } catch (e) {
    log(`CHYBA: ${e.message}`);
    result = { runId, status: 'error', summary: { error: e.message, ...(e.guard ? { guard: true } : {}) } };
  }
  try {
    runs.finish(runId, result.status, result.summary, lines.join('\n'));
    projects.setRunResult(projectId, result.status, result.summary);
  } finally {
    running.delete(projectId);
  }
  await notifyRun(project, project.last_status, result).catch((e) => console.error('notify:', e.message)); // nikdy nesmie zhodiť beh
  return result;
}

/** Každú minútu skontroluje, ktoré projekty majú byť spustené. */
export function startScheduler() {
  const tick = () => {
    for (const p of projects.list()) {
      if (!p.enabled || !p.source_url || running.has(p.id)) continue;
      const last = p.last_run_at ? Date.parse(p.last_run_at.replace(' ', 'T') + 'Z') : 0;
      const due = Date.now() - last >= p.interval_minutes * 60_000;
      if (due) triggerRun(p.id).catch((e) => console.error('scheduler:', e.message));
    }
  };
  setTimeout(tick, 5_000);
  // raz denne upratať cache, ktorá sa dlho nepoužila
  const cleanup = () => pruneCache().then((n) => n && console.log(`cache: zmazaných ${n} starých súborov`)).catch((e) => console.error('cache:', e.message));
  setTimeout(cleanup, 10 * 60_000).unref();
  setInterval(cleanup, 24 * 3_600_000).unref();
  return setInterval(tick, 60_000);
}
