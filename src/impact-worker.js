// Výpočet dopadu pripravenej zmeny mimo hlavného vlákna: regex v podmienkach sa vyhodnocuje
// synchrónne nad každým produktom a zlý vzor by inak zasekol celý server (API aj plánovač).
import { parentPort, workerData } from 'node:worker_threads';
import { dryRunProfile } from './feed/pipeline.js';

const { jobs } = workerData;
const out = jobs.map(({ project, profile, items }) => {
  if (!profile || !items) return null;
  const r = dryRunProfile(project, profile, items);
  return { enabled: profile.enabled !== false, total: r.total, written: r.written, excluded: r.excluded, not_selected: r.notSelected, invalid: r.invalid };
});
parentPort.postMessage(out);
