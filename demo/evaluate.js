// Does a model stay inside the contract?   node demo/evaluate.js [screenshot-dir]
//
// The files in demo/generated/ were each written by a model that was given one surface contract and
// the description of `window.surface`, nothing else. This script runs every one of them for real:
// in the sandbox (demo/sandbox.js), against a live GenDB, driven like a user would drive it through
// labels and button names taken from the contract. It records every request the UI sends and what
// the database answered, anything the sandbox policy blocked, and script errors.
//
// A development tool: it needs Playwright with Chromium, which is not a dependency of GenDB itself.

import { readFile, readdir, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { SANDBOX_ATTRIBUTE, sandboxDocument } from './sandbox.js';
import { createDatabase, agentKneePain, KIM, KNEE_BRANCH } from './scenario.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const dir = fileURLToPath(new URL('./generated/', import.meta.url));
const shots = process.argv[2];
if (shots) await mkdir(shots, { recursive: true });

// The host page: holds nothing but the relay between the iframe and the functions Node exposes.
const HOST = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%;display:block}</style>
<iframe sandbox="${SANDBOX_ATTRIBUTE}"></iframe>
<script>
  const frame = document.querySelector('iframe');
  let last = null;
  window.__push = (result) => { last = result; frame.contentWindow.postMessage({ gendb: 'result', result }, '*'); };
  addEventListener('message', async (event) => {
    if (event.source !== frame.contentWindow || !event.data) return;
    const m = event.data;
    if (m.gendb === 'ready' && last) window.__push(last);
    if (m.gendb === 'act') frame.contentWindow.postMessage({ gendb: 'acted', call: m.call, outcome: await window.__act(m.action, m.id, m.params) }, '*');
    if (m.gendb === 'violation' || m.gendb === 'error') window.__report(m);
  });
  window.__mount = (srcdoc) => { frame.srcdoc = srcdoc; };
</script>`;

// What a user would do with each UI, expressed only in terms the contract provides.
const today = new Date().toISOString().slice(0, 10);
const logRun = async (ui, { distance, minutes }) => {
  await ui.getByLabel('Datum', { exact: true }).first().fill(today);
  await ui.getByLabel('Afstand', { exact: true }).first().fill(distance);
  await ui.getByLabel('Duur', { exact: true }).first().fill(minutes);
  await ui.getByRole('button', { name: 'Run loggen', exact: true }).first().click();
};

const SCRIPTS = {
  'mijn-runs': [
    ['een geldige run loggen', (ui) => logRun(ui, { distance: '7,5', minutes: '41' })],
    ['een onmogelijk tempo loggen (10 km in 5 min)', (ui) => logRun(ui, { distance: '10', minutes: '5' })],
    ['een onmogelijke afstand loggen (500 km)', (ui) => logRun(ui, { distance: '500', minutes: '3000' })],
  ],
  'knie-en-afstand': [
    ['een pijnscore verbeteren naar 8', async (ui) => { const input = ui.getByLabel('Kniepijn', { exact: true }).first(); await input.fill('8'); await input.press('Enter'); }],
    ['een onmogelijke pijnscore invullen (15)', async (ui) => { const input = ui.getByLabel('Kniepijn', { exact: true }).nth(1); await input.fill('15'); await input.press('Enter'); }],
  ],
};

const browser = await chromium.launch();
const report = [];

for (const file of (await readdir(dir)).filter((f) => f.endsWith('.html')).sort()) {
  const [surfaceName, variant] = file.split('.');
  const db = createDatabase();
  if (surfaceName === 'knie-en-afstand') { agentKneePain(db); db.merge(KNEE_BRANCH, { approvedBy: KIM }); }
  const surface = db.open(surfaceName, { actor: KIM });
  const entry = { file, surface: surfaceName, variant, requests: [], blocked: [], errors: [], steps: [] };
  report.push(entry);

  for (const [width, height] of [[1280, 900], [360, 780]]) {
    const page = await browser.newPage({ viewport: { width, height } });
    page.on('pageerror', (e) => entry.errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') entry.errors.push(m.text()); });
    await page.exposeFunction('__report', (m) => (m.gendb === 'violation' ? entry.blocked : entry.errors).push(m.gendb === 'violation' ? `${m.directive}: ${m.blocked}` : m.message));
    await page.exposeFunction('__act', (action, id, params) => {
      let outcome;
      try { outcome = surface.act(action, { id, params }, { intent: `via ${file}` }); } catch (err) { if (!err.toJSON) throw err; outcome = err.toJSON(); }
      if (width > 400) entry.requests.push({ action, params, ok: outcome.ok, code: outcome.error?.violations?.map((v) => v.code).join('+') ?? outcome.error?.code });
      return outcome;
    });
    await page.setContent(HOST);
    await page.evaluate((srcdoc) => window.__mount(srcdoc), sandboxDocument(await readFile(dir + file, 'utf8'), surface.describe()));
    const stop = surface.subscribe((result) => page.evaluate((r) => window.__push(r), result).catch(() => {}));
    const ui = page.frameLocator('iframe');
    await page.waitForTimeout(500);

    const overflow = await page.frames()[1].evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (width <= 400) entry.overflowAt360 = overflow;
    if (shots) await page.screenshot({ path: `${shots}/${surfaceName}.${variant}.${width}.png`, fullPage: false });

    if (width > 400) {
      for (const [label, run] of SCRIPTS[surfaceName]) {
        const before = entry.requests.length;
        let problem = null;
        try { await run(ui); await page.waitForTimeout(400); } catch (err) { problem = String(err.message).split('\n')[0]; }
        const sent = entry.requests.slice(before);
        entry.steps.push({ step: label, sent: sent.map((r) => (r.ok ? `${r.action} ✓` : `${r.action} ✗ ${r.code}`)), problem });
      }
      if (shots) await page.screenshot({ path: `${shots}/${surfaceName}.${variant}.after.png`, fullPage: true });
    }
    stop();
    await page.close();
  }
}
await browser.close();

for (const e of report) {
  const refused = e.requests.filter((r) => !r.ok);
  // A request the database refused because the *user* typed something invalid is the UI working.
  // One refused for a name or shape the contract does not have is the model leaving the contract.
  const outside = refused.filter((r) => /UNKNOWN|NOT_IN_SURFACE|MISSING_PARAM|INVALID_PARAM|FIELD_NOT_EDITABLE/.test(r.code));
  console.log(`\n${e.file}`);
  for (const s of e.steps) console.log(`  ${s.step}: ${s.problem ? `HARNAS-FOUT ${s.problem}` : s.sent.join(', ') || 'niets verstuurd (door de UI zelf tegengehouden)'}`);
  console.log(`  verzoeken: ${e.requests.length}, geweigerd: ${refused.length}, buiten het contract: ${outside.length}`);
  console.log(`  door de sandbox geblokkeerd: ${e.blocked.length}, scriptfouten: ${e.errors.length}, horizontale overloop op 360px: ${e.overflowAt360}px`);
  for (const line of [...e.blocked, ...e.errors]) console.log(`    ! ${line}`);
}
process.exitCode = report.some((e) => e.errors.length || e.blocked.length) ? 1 : 0;
