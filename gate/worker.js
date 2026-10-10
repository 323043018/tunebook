// Device approval for the Band Tune Book.
// Every request comes through here before any app file is sent. Approved iPads carry a signed pass
// (a cookie); the list of iPads lives in one Durable Object. The bandmaster approves on /approvals.
import { DurableObject } from 'cloudflare:workers';

const PASS = 'tb_pass';
const PASS_DAYS = 400;
const MAX_WAITING = 30;
// Files the Home Screen needs before an iPad is approved (icon, name, colours). Nothing else is public.
const PUBLIC = new Set(['/manifest.webmanifest', '/icon-180.png', '/icon-192.png', '/icon-512.png', '/robots.txt']);
const PAGES = new Set(['/', '/index.html']);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    let res;
    try {
      if (path === '/approvals' || path.startsWith('/approvals/')) res = await approvals(request, env, url);
      else if (path.startsWith('/__gate/')) res = await gateApi(request, env, ctx, url);
      else if (PUBLIC.has(path)) res = await env.ASSETS.fetch(request);
      else res = await app(request, env, path);
    } catch (e) {
      console.error(e);
      res = new Response('Something went wrong. Try again in a moment.', { status: 500 });
    }
    res = new Response(res.body, res);
    res.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    return res;
  },
};

/* ---------- the app, behind the pass ---------- */

async function app(request, env, path) {
  const id = await readPass(request, env);
  if (id) {
    // Pages are checked against the list each time, so removing an iPad takes effect on its next visit.
    // Other files only need a valid pass, which keeps the list from being read 15 times per launch.
    if (!PAGES.has(path)) return env.ASSETS.fetch(request);
    const dev = await registry(env).touch(id);
    if (dev && dev.status === 'approved') return env.ASSETS.fetch(request);
  }
  if (request.method === 'GET' && PAGES.has(path)) {
    const res = html(GATE_PAGE, 403);
    if (id) res.headers.append('Set-Cookie', clearPass());
    return res;
  }
  return new Response('This iPad is not approved for the tune book.', { status: 403, headers: { 'Cache-Control': 'no-store' } });
}

/* ---------- request screen API ---------- */

async function gateApi(request, env, ctx, url) {
  if (request.method !== 'POST') return json({ error: 'Use POST' }, 405);
  const body = await request.json().catch(() => ({}));
  const id = cleanId(body.id);
  if (!id) return json({ error: 'Missing device id' }, 400);
  const reg = registry(env);

  if (url.pathname === '/__gate/status') {
    const dev = await reg.touch(id);
    const res = json({ status: dev ? dev.status : 'new', name: dev ? dev.name : '' });
    if (dev && dev.status === 'approved') res.headers.append('Set-Cookie', await makePass(id, env));
    return res;
  }

  if (url.pathname === '/__gate/request') {
    const name = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!name) return json({ error: 'Type your name so the bandmaster knows who you are.' }, 400);
    const details = describe(request, body.details || {});
    const out = await reg.request(id, name, details, MAX_WAITING);
    if (out.error) return json({ error: out.error }, 429);
    if (out.created) ctx.waitUntil(alert(env, url, name, details));
    return json({ status: out.status, name: out.name });
  }
  return json({ error: 'Not found' }, 404);
}

function describe(request, d) {
  const ua = request.headers.get('User-Agent') || '';
  const cf = request.cf || {};
  const safari = (ua.match(/Version\/([\d.]+)/) || [])[1];
  const touch = Number(d.touch) || 0;
  let device = /iPad/.test(ua) || (/Macintosh/.test(ua) && touch > 1) ? 'iPad'
    : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Macintosh/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows PC' : 'Unknown device';
  const s = v => String(v || '').slice(0, 60);
  return {
    device,
    browser: safari ? `Safari ${safari}` : s(ua.match(/(Chrome|Firefox|Edg)\/[\d]+/)?.[0]) || 'Unknown browser',
    screen: d.w && d.h ? `${Number(d.w)} × ${Number(d.h)}` : '',
    homeScreen: !!d.standalone,
    language: s(d.lang),
    timeZone: s(d.tz),
    place: [cf.city, cf.country].filter(Boolean).join(', '),
    userAgent: ua.slice(0, 300),
  };
}

async function alert(env, url, name, d) {
  const topic = (env.NTFY_TOPIC || '').trim();
  if (!topic) return;
  const line = [d.device, d.browser, d.place].filter(Boolean).join(' · ');
  try {
    await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: { Title: 'New tune book request', Click: `${url.origin}/approvals`, Tags: 'musical_note', Priority: 'high' },
      body: `${name}\n${line}\nTap to approve or decline`,
    });
  } catch (e) { console.error('ntfy failed', e); }
}

/* ---------- approvals page (bandmaster only) ---------- */

async function approvals(request, env, url) {
  if (!env.ADMIN_PASSWORD) return new Response('Set the ADMIN_PASSWORD secret in Cloudflare first.', { status: 503 });
  if (!(await authorised(request, env))) {
    return new Response('Password needed.', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Tune Book approvals", charset="UTF-8"', 'Cache-Control': 'no-store' } });
  }
  const reg = registry(env);
  if (url.pathname === '/approvals' && request.method === 'GET') return html(ADMIN_PAGE);
  if (url.pathname === '/approvals/list' && request.method === 'GET') return json(await reg.list());
  if (url.pathname === '/approvals/act' && request.method === 'POST') {
    // The custom header can't be sent by another site's form, so a stray link can't approve anyone.
    if (request.headers.get('X-Approvals') !== '1') return json({ error: 'Missing header' }, 400);
    const b = await request.json().catch(() => ({}));
    const id = cleanId(b.id);
    if (!id) return json({ error: 'Missing device id' }, 400);
    const ok = await reg.act(id, String(b.action || ''), String(b.name || '').replace(/\s+/g, ' ').trim().slice(0, 60));
    return ok ? json({ ok: true }) : json({ error: 'That iPad is no longer on the list.' }, 404);
  }
  return new Response('Not found', { status: 404 });
}

async function authorised(request, env) {
  const h = request.headers.get('Authorization') || '';
  if (!h.startsWith('Basic ')) return false;
  let given = '';
  try { given = atob(h.slice(6)).split(':').slice(1).join(':'); } catch { return false; }
  const [a, b] = await Promise.all([sha256(given), sha256(env.ADMIN_PASSWORD)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

/* ---------- the list of iPads ---------- */

export class Registry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, details TEXT NOT NULL,
      requested INTEGER NOT NULL, decided INTEGER, seen INTEGER)`);
  }
  get(id) { return this.sql.exec('SELECT * FROM devices WHERE id = ?', id).toArray()[0] || null; }
  touch(id) {
    const d = this.get(id);
    if (d && d.status === 'approved') this.sql.exec('UPDATE devices SET seen = ? WHERE id = ?', Date.now(), id);
    return d && { status: d.status, name: d.name };
  }
  request(id, name, details, maxWaiting) {
    const d = this.get(id);
    if (d) return { status: d.status, name: d.name, created: false };
    const waiting = this.sql.exec("SELECT COUNT(*) AS n FROM devices WHERE status = 'waiting'").one().n;
    if (waiting >= maxWaiting) return { error: 'Too many requests are waiting. Ask the bandmaster to check the list.' };
    this.sql.exec("INSERT INTO devices (id, name, status, details, requested) VALUES (?, ?, 'waiting', ?, ?)", id, name, JSON.stringify(details), Date.now());
    return { status: 'waiting', name, created: true };
  }
  list() {
    return this.sql.exec('SELECT * FROM devices ORDER BY requested DESC').toArray()
      .map(d => ({ ...d, details: JSON.parse(d.details) }));
  }
  act(id, action, name) {
    if (!this.get(id)) return false;
    const now = Date.now();
    if (action === 'approve') this.sql.exec("UPDATE devices SET status = 'approved', decided = ? WHERE id = ?", now, id);
    else if (action === 'decline') this.sql.exec("UPDATE devices SET status = 'declined', decided = ? WHERE id = ?", now, id);
    else if (action === 'forget') this.sql.exec('DELETE FROM devices WHERE id = ?', id);
    else if (action === 'rename' && name) this.sql.exec('UPDATE devices SET name = ? WHERE id = ?', name, id);
    else return false;
    return true;
  }
}

const registry = env => env.REGISTRY.get(env.REGISTRY.idFromName('band'));

/* ---------- pass (signed cookie) ---------- */

async function makePass(id, env) {
  return `${PASS}=${id}.${await sign(id, env)}; Max-Age=${PASS_DAYS * 86400}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}
const clearPass = () => `${PASS}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`;

async function readPass(request, env) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp(`(?:^|;\\s*)${PASS}=([\\w-]+)\\.([\\w-]+)`));
  if (!m || !cleanId(m[1])) return null;
  const want = await sign(m[1], env);
  const enc = new TextEncoder();
  const a = enc.encode(want), b = enc.encode(m[2]);
  return a.length === b.length && crypto.subtle.timingSafeEqual(a, b) ? m[1] : null;
}

async function sign(id, env) {
  // The signing key comes from the approvals password. Changing the password just re-issues passes:
  // approved iPads get a new one the next time they open the app online.
  const key = await crypto.subtle.importKey('raw', await sha256('tunebook-pass:' + (env.ADMIN_PASSWORD || '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(id)));
  return btoa(String.fromCharCode(...mac)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ---------- helpers ---------- */

const sha256 = async s => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
const cleanId = v => (typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v) ? v : null);
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const html = (body, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });

/* ---------- pages ---------- */

const GATE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Band Tune Book</title>
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Tune Book">
<meta name="theme-color" content="#610014">
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icon-180.png">
<style>
  :root { color-scheme: dark; }
  html, body { height: 100%; margin: 0; }
  body { background: #610014; color: #f1dfe2; font: 17px/1.5 -apple-system, "Helvetica Neue", Arial, sans-serif; display: grid; place-items: center; text-align: center; padding: 24px; box-sizing: border-box; }
  main { max-width: 440px; display: grid; gap: 14px; }
  .t { font-weight: 800; letter-spacing: .08em; text-transform: uppercase; font-size: 14px; opacity: .85; }
  h1 { color: #fff; font-size: 28px; line-height: 1.2; margin: 0; }
  p { margin: 0; opacity: .9; }
  form { display: grid; gap: 12px; margin-top: 6px; }
  label { font-size: 15px; text-align: left; }
  input { font: inherit; font-size: 18px; padding: 12px 14px; border-radius: 10px; border: 0; color: #14181f; background: #fff; width: 100%; box-sizing: border-box; }
  button { font: inherit; font-weight: 700; color: #610014; background: #fff; border: 0; border-radius: 999px; padding: 12px 22px; cursor: pointer; }
  button:disabled { opacity: .6; }
  .err { color: #ffd2d9; font-weight: 600; min-height: 1.5em; }
  .dot { display: inline-block; width: 12px; height: 12px; border-radius: 50%; background: #fff; margin-right: 8px; animation: p 1.6s ease-in-out infinite; }
  @keyframes p { 50% { opacity: .25; } }
  @media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
  .share { display: inline-block; vertical-align: -3px; }
</style>
</head>
<body>
<main id="m"><div class="t">Band Tune Book</div><p>Checking this iPad…</p></main>
<script>
const KEY = 'tb_device_id';
const m = document.getElementById('m');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const head = '<div class="t">Band Tune Book</div>';
let id = null;
try { id = localStorage.getItem(KEY); } catch (e) {}
if (!id) { id = crypto.randomUUID(); try { localStorage.setItem(KEY, id); } catch (e) {} }
// On iPad and iPhone, ask from the Home Screen icon only: it keeps its own storage, separate from Safari.
const ios = 'standalone' in navigator;
const fromIcon = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

async function post(path, data) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), credentials: 'same-origin', cache: 'no-store' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && !j.error) j.error = 'Could not reach the tune book. Check the internet connection and try again.';
  return j;
}

function addFirst() {
  m.innerHTML = head + '<h1>Add this to your Home Screen first</h1>' +
    '<p>Tap the Share button <svg class="share" width="18" height="22" viewBox="0 0 18 22" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 14V2M4.5 6.5 9 2l4.5 4.5M5 9H2v11h14V9h-3"/></svg>, then <b>Add to Home Screen</b>.</p>' +
    '<p>Then open <b>Tune Book</b> from the new icon to ask for access.</p>';
}
function form(msg) {
  m.innerHTML = head + '<h1>Ask to use this iPad</h1><p>The bandmaster will see your request and approve it.</p>' +
    '<form id="f"><label for="name">Your name and part</label><input id="name" maxlength="60" autocomplete="name" placeholder="e.g. Sam Taylor, 2nd cornet" required>' +
    '<button id="send">Send request</button><div class="err" id="err">' + esc(msg || '') + '</div></form>';
  document.getElementById('f').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = document.getElementById('send'); btn.disabled = true; btn.textContent = 'Sending…';
    const details = { w: screen.width, h: screen.height, touch: navigator.maxTouchPoints || 0, standalone: fromIcon, lang: navigator.language, tz: Intl.DateTimeFormat().resolvedOptions().timeZone };
    const j = await post('/__gate/request', { id, name: document.getElementById('name').value, details }).catch(() => ({ error: 'Could not reach the tune book. Check the internet connection and try again.' }));
    if (j.error) { form(j.error); return; }
    show(j);
  });
}
function waiting(name) {
  m.innerHTML = head + '<h1><span class="dot"></span>Waiting for approval</h1>' +
    '<p>Request sent as “' + esc(name) + '”.</p><p>This screen opens the tune book by itself once you\\'re approved. You can close it and come back later.</p>';
}
function declined() {
  m.innerHTML = head + '<h1>Not approved</h1><p>This iPad wasn\\'t approved for the tune book.</p><p>Speak to the bandmaster if you think this is a mistake.</p>';
}
function offline() {
  m.innerHTML = head + '<h1>No internet connection</h1><p>Connect to the internet to ask for access. This screen will try again by itself.</p>';
}

let timer = null;
function show(j) {
  clearTimeout(timer);
  if (j.status === 'approved') { location.reload(); return; }
  if (j.status === 'declined') { declined(); return; }
  if (j.status === 'waiting') { waiting(j.name); timer = setTimeout(check, 5000); return; }
  if (ios && !fromIcon) { addFirst(); return; }
  form();
}
async function check() {
  try { show(await post('/__gate/status', { id })); }
  catch (e) { offline(); clearTimeout(timer); timer = setTimeout(check, 10000); }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && timer) { clearTimeout(timer); check(); } });
check();
</script>
</body>
</html>`;

const ADMIN_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Tune Book approvals</title>
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>
  :root { --bg: #f4f5f7; --surface: #fff; --fg: #171a21; --muted: #5b6270; --line: #dde0e6; --accent: #610014;
    --ok: #1f7a46; --ok-bg: #e3f3ea; --stop: #a3162d; --stop-bg: #fbe6e9; --new: #8a5a00; --new-bg: #fbf0d9; color-scheme: light; }
  @media (prefers-color-scheme: dark) { :root { --bg: #121418; --surface: #1b1e24; --fg: #eceef2; --muted: #a2a9b6; --line: #2e333c; --accent: #ff8fa3;
    --ok: #7fd6a2; --ok-bg: #173325; --stop: #ff8f9f; --stop-bg: #3d1820; --new: #f0c56b; --new-bg: #3a2e12; color-scheme: dark; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.45 -apple-system, "Helvetica Neue", Arial, sans-serif; }
  .wrap { max-width: 760px; margin: 0 auto; padding: max(20px, env(safe-area-inset-top)) 16px 48px; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  .sub { color: var(--muted); margin: 0 0 20px; }
  h2 { font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin: 26px 0 8px; }
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  .row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; padding: 14px 16px; border-top: 1px solid var(--line); align-items: center; }
  .row:first-child { border-top: 0; }
  @media (max-width: 520px) { .row { grid-template-columns: 1fr; } .acts { justify-content: flex-start !important; } }
  .nm { font-weight: 700; overflow-wrap: anywhere; }
  .det { font-size: 14px; color: var(--muted); overflow-wrap: anywhere; }
  .acts { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
  button { font: inherit; font-size: 14px; font-weight: 700; padding: 7px 14px; border-radius: 999px; border: 1px solid var(--line); background: var(--surface); color: var(--fg); cursor: pointer; }
  button.go { background: var(--ok-bg); color: var(--ok); border-color: transparent; }
  button.no { background: var(--stop-bg); color: var(--stop); border-color: transparent; }
  button:focus-visible, input:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
  .pill { font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px; background: var(--new-bg); color: var(--new); margin-left: 6px; vertical-align: 2px; }
  .empty { padding: 14px 16px; color: var(--muted); }
  .confirm { font-size: 14px; color: var(--stop); font-weight: 600; }
  input { font: inherit; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); width: 100%; box-sizing: border-box; }
  .msg { color: var(--stop); font-weight: 600; min-height: 1.4em; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Tune Book approvals</h1>
  <p class="sub">Approve each iPad before it can open the tune book. This page updates by itself.</p>
  <div class="msg" id="msg"></div>
  <h2 id="h-waiting">Waiting</h2><div class="card" id="waiting"></div>
  <h2 id="h-approved">Approved</h2><div class="card" id="approved"></div>
  <h2 id="h-declined">Declined</h2><div class="card" id="declined"></div>
</div>
<script>
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = t => { if (!t) return ''; const d = new Date(t), now = new Date(); const day = d.toDateString() === now.toDateString() ? 'today' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); return day + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); };
const ago = t => { if (!t) return 'not opened yet'; const days = Math.floor((Date.now() - t) / 864e5); return 'last opened ' + (days < 1 ? 'today' : days === 1 ? 'yesterday' : days + ' days ago'); };
let devices = [], confirming = null, renaming = null;

function info(d) {
  const x = d.details || {};
  const ver = (x.browser || '').match(/Safari ([\\d.]+)/);
  return [x.device, x.browser + (ver && x.device === 'iPad' ? ' (about iPadOS ' + ver[1] + ')' : ''), x.screen && 'screen ' + x.screen,
    x.homeScreen ? 'from home screen icon' : 'from the browser', [x.language, x.timeZone].filter(Boolean).join(', '), x.place].filter(Boolean).join(' · ');
}
function row(d) {
  let acts = '', line = '';
  if (renaming === d.id) {
    return '<div class="row"><div><input id="rn" maxlength="60" value="' + esc(d.name) + '" aria-label="New name"></div><div class="acts"><button class="go" data-a="rename" data-id="' + d.id + '">Save</button><button data-a="cancel">Cancel</button></div></div>';
  }
  if (confirming && confirming.id === d.id) {
    const what = { decline: 'Remove this iPad? It stops opening the tune book next time it goes online.', forget: 'Forget this request? They could then ask again.' }[confirming.action];
    return '<div class="row"><div><div class="nm">' + esc(d.name) + '</div><div class="confirm">' + what + '</div></div><div class="acts"><button class="no" data-a="' + confirming.action + '" data-id="' + d.id + '" data-sure="1">Yes</button><button data-a="cancel">Cancel</button></div></div>';
  }
  if (d.status === 'waiting') {
    line = info(d) + ' · ' + when(d.requested);
    acts = '<button class="go" data-a="approve" data-id="' + d.id + '">Approve</button><button class="no" data-a="decline" data-id="' + d.id + '" data-sure="1">Decline</button>';
  } else if (d.status === 'approved') {
    line = 'Approved ' + when(d.decided) + ' · ' + ago(d.seen) + '<br>' + info(d);
    acts = '<button data-a="edit" data-id="' + d.id + '">Rename</button><button class="no" data-a="decline" data-id="' + d.id + '">Remove</button>';
  } else {
    line = 'Declined ' + when(d.decided) + ' · ' + info(d);
    acts = '<button class="go" data-a="approve" data-id="' + d.id + '">Approve</button><button data-a="forget" data-id="' + d.id + '">Forget</button>';
  }
  return '<div class="row"><div><div class="nm">' + esc(d.name) + (d.status === 'waiting' ? '<span class="pill">New</span>' : '') + '</div><div class="det">' + line + '</div></div><div class="acts">' + acts + '</div></div>';
}
function render() {
  for (const s of ['waiting', 'approved', 'declined']) {
    const list = devices.filter(d => d.status === s);
    document.getElementById('h-' + s).textContent = { waiting: 'Waiting', approved: 'Approved', declined: 'Declined' }[s] + ' · ' + list.length;
    document.getElementById(s).innerHTML = list.length ? list.map(row).join('') : '<div class="empty">' + { waiting: 'No requests waiting.', approved: 'No iPads approved yet.', declined: 'Nothing declined.' }[s] + '</div>';
  }
  const rn = document.getElementById('rn'); if (rn && document.activeElement !== rn) rn.focus();
}
async function load() {
  if (renaming || confirming) return;
  try { const r = await fetch('/approvals/list', { cache: 'no-store' }); if (!r.ok) throw 0; devices = await r.json(); document.getElementById('msg').textContent = ''; render(); }
  catch (e) { document.getElementById('msg').textContent = 'Could not load the list. Check the connection.'; }
}
async function act(action, id, name) {
  const r = await fetch('/approvals/act', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Approvals': '1' }, body: JSON.stringify({ action, id, name }) }).catch(() => null);
  const j = r ? await r.json().catch(() => ({})) : { error: 'Could not reach the tune book. Check the connection.' };
  document.getElementById('msg').textContent = j.error || '';
  confirming = renaming = null; await load();
}
document.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const { a, id, sure } = b.dataset;
  if (a === 'cancel') { confirming = renaming = null; render(); load(); return; }
  if (a === 'edit') { renaming = id; confirming = null; render(); return; }
  if (a === 'rename') { act('rename', id, document.getElementById('rn').value); return; }
  if ((a === 'decline' || a === 'forget') && !(sure && confirming && confirming.id === id) && !(sure && devices.find(d => d.id === id)?.status === 'waiting')) { confirming = { id, action: a }; renaming = null; render(); return; }
  act(a, id);
});
document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'rn') act('rename', renaming, e.target.value); });
load(); setInterval(load, 10000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
</script>
</body>
</html>`;
