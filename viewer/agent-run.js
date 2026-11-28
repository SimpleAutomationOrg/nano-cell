// Runs the agent asks for.
//
// The agent cannot see or drive this page, but it can ask it to run steps:
// `node scripts/run-step.mjs` posts a request to the server (viewer/runs.py),
// this module takes it here, runs it in the real simulation — the user
// watches it happen — and posts back what came of it: done or the error,
// what was logged, where the parts ended up, and a picture if asked.
//
// The page gives it `run(job)`, which does the work and resolves with the
// result (app.js knows the scene; this file only carries the request).
import { pollFetch } from './poll.js';

const HEAD = { 'Content-Type': 'application/json', 'X-Microfactory': 'chat' };

/**
 * @param {{ app: string, run: (job: { steps: string[], loop: boolean, reset: boolean, shot: boolean, fast: boolean }) => Promise<object> }} o
 */
export function startAgentRuns({ app, run }) {
  // names this load of the page, so the server knows whose job a job is
  const page = Math.random().toString(36).slice(2) + Date.now().toString(36);
  (async () => {
    for (;;) {
      try {
        const r = await pollFetch(`/__run/next?app=${encodeURIComponent(app)}&page=${page}`, { headers: HEAD });
        if (!r) continue;                           // the tab was hidden: wait until it is shown
        if (!r.ok) { await new Promise(res => setTimeout(res, 5000)); continue; }
        const { job } = await r.json();
        if (!job) continue;
        // say that the job is in hand, and keep saying so: a job nobody vouches for is given out again
        const vouch = () => fetch('/__run/alive', { method: 'POST', headers: HEAD, body: JSON.stringify({ id: job.id, page }) }).catch(() => {});
        vouch();
        const beat = setInterval(vouch, 3000);
        let result;
        try { result = await run(job); }
        catch (e) { result = { ok: false, error: `the viewer could not run it: ${e?.message ?? e}` }; }
        finally { clearInterval(beat); }
        await fetch('/__run/result', { method: 'POST', headers: HEAD, body: JSON.stringify({ id: job.id, result }) });
      } catch { await new Promise(res => setTimeout(res, 2000)); }
    }
  })();
}

// What a run reports about one part: where it is now and how far that is from where the layout put it.
export function partReport(id, from, to) {
  const d = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
  const r = v => Math.round(v * 1e4) / 1e4;
  return { id, moved_mm: Math.round(d * 10000) / 10, from_m: from.map(r), to_m: to.map(r) };
}
