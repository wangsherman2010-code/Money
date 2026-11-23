#!/usr/bin/env node
// 一句话记账 · 家庭同步服务器
// 放在你自己的 VPS 上：同时提供 App 网页（上一级目录）和同步接口 /api/*。
// 不需要安装任何依赖，Node.js 18 以上即可。数据保存在 DATA_DIR/ledger.json，每天自动备份一份。
//
// 环境变量：
//   TOKEN       家庭密码（必填，至少 8 位）。两个人在 App 里填同一个
//   PORT        端口，默认 8787（建议只监听本机，由 Caddy / Nginx 提供 HTTPS）
//   HOST        监听地址，默认 127.0.0.1
//   DATA_DIR    数据目录，默认 ./data
//   STATIC_DIR  App 网页所在目录，默认本文件的上一级目录；设为空字符串则不提供网页
//   ALLOW_ORIGIN 允许跨域调用的网址（App 放在别处时用），默认 *

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = process.env.TOKEN || '';
const PORT = +(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(here, 'data'));
const STATIC_DIR = process.env.STATIC_DIR === '' ? null : path.resolve(process.env.STATIC_DIR || path.join(here, '..'));
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
const MAX_BODY = 8 * 1024 * 1024;

if (TOKEN.length < 8) {
  console.error('请设置 TOKEN 环境变量（家庭密码，至少 8 位）。例如：TOKEN=换成你自己的密码 node server.js');
  process.exit(1);
}

/* ---------------- 数据 ---------------- */
// db = { seq, records: {id: {...record, updatedAt, deleted?, rev}}, memory: {key: {v, t, deleted?, rev}}, meta: {value, t, rev} | null }
const DB_FILE = path.join(DATA_DIR, 'ledger.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
let db = { seq: 0, records: {}, memory: {}, meta: null };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch (e) { if (e.code !== 'ENOENT') { console.error('读取数据失败：', e); process.exit(1); } }

let saveTimer = null, saving = Promise.resolve();
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saving = saving.then(writeDb).catch(e => console.error('保存失败：', e)); }, 200);
}
async function writeDb() {
  const tmp = DB_FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(db));
  await fsp.rename(tmp, DB_FILE); // 先写临时文件再改名，断电也不会写坏
  const day = new Date().toISOString().slice(0, 10);
  const bak = path.join(DATA_DIR, `backup-${day}.json`);
  if (!fs.existsSync(bak)) {
    await fsp.copyFile(DB_FILE, bak);
    const olds = (await fsp.readdir(DATA_DIR)).filter(f => /^backup-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    for (const f of olds.slice(0, -30)) await fsp.unlink(path.join(DATA_DIR, f)); // 保留最近 30 天
  }
}

// 后写的赢：只有比服务器上更新的改动才会被接受
function mergePush(push) {
  let changed = false;
  for (const r of Array.isArray(push?.records) ? push.records : []) {
    if (!r || typeof r.id !== 'string' || r.id.length > 100) continue;
    const t = +r.updatedAt || 0, cur = db.records[r.id];
    if (cur && (+cur.updatedAt || 0) >= t) continue;
    db.records[r.id] = { ...r, updatedAt: t, rev: ++db.seq };
    changed = true;
  }
  for (const m of Array.isArray(push?.memory) ? push.memory : []) {
    if (!m || typeof m.k !== 'string' || m.k.length > 200) continue;
    const t = +m.t || 0, cur = db.memory[m.k];
    if (cur && (+cur.t || 0) >= t) continue;
    db.memory[m.k] = { v: m.deleted ? null : m.v, t, deleted: !!m.deleted, rev: ++db.seq };
    changed = true;
  }
  if (push?.meta && typeof push.meta === 'object') {
    const t = +push.meta.t || 0;
    if (!db.meta || (+db.meta.t || 0) < t) { db.meta = { value: push.meta.value, t, rev: ++db.seq }; changed = true; }
  }
  if (changed) scheduleSave();
}
function changesSince(since) {
  since = +since || 0;
  return {
    seq: db.seq,
    records: Object.values(db.records).filter(r => r.rev > since),
    memory: Object.entries(db.memory).filter(([, m]) => m.rev > since).map(([k, m]) => ({ k, v: m.v, t: m.t, deleted: m.deleted })),
    meta: db.meta && db.meta.rev > since ? { value: db.meta.value, t: db.meta.t } : null,
  };
}

/* ---------------- 防暴力猜密码 ---------------- */
const fails = new Map(); // ip -> {n, until}
function blocked(ip) { const f = fails.get(ip); return f && f.until > Date.now(); }
function failed(ip) {
  const f = fails.get(ip) || { n: 0, until: 0 };
  f.n++; if (f.n >= 10) { f.until = Date.now() + 15 * 60_000; f.n = 0; }
  fails.set(ip, f);
}
const tokenHash = crypto.createHash('sha256').update(TOKEN).digest();
function authOk(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  return crypto.timingSafeEqual(crypto.createHash('sha256').update(m[1]).digest(), tokenHash);
}

/* ---------------- HTTP ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8' };

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}
function cors(req) {
  return { 'Access-Control-Allow-Origin': ALLOW_ORIGIN, 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Max-Age': '86400', Vary: 'Origin' };
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function serveStatic(req, res, urlPath) {
  if (!STATIC_DIR) return send(res, 404, { error: 'not found' });
  let rel = decodeURIComponent(urlPath).replace(/^\/+/, '') || 'index.html';
  const file = path.resolve(STATIC_DIR, rel);
  // 只提供 App 自己的文件：不能跑出目录，不提供服务器代码、数据、隐藏文件
  if (!file.startsWith(STATIC_DIR + path.sep) || /(^|[\\/])\./.test(rel) || rel.startsWith('server') || rel.startsWith('node_modules')) return send(res, 404, { error: 'not found' });
  try {
    const st = await fsp.stat(file);
    if (!st.isFile()) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': /\.(png|svg|ico)$/.test(file) ? 'public, max-age=86400' : 'no-cache',
      'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(file).pipe(res);
  } catch { send(res, 404, { error: 'not found' }); }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  try {
    if (url.pathname.startsWith('/api/')) {
      const h = cors(req);
      if (req.method === 'OPTIONS') return send(res, 204, '', h);
      if (url.pathname === '/api/ping') return send(res, 200, { ok: true, app: 'voice-ledger', version: 1 }, h);
      if (blocked(ip)) return send(res, 429, { error: '尝试次数太多，请 15 分钟后再试' }, h);
      if (!authOk(req)) { failed(ip); return send(res, 401, { error: '家庭密码不对' }, h); }
      fails.delete(ip);
      if (url.pathname === '/api/sync' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        mergePush(body.push);
        return send(res, 200, changesSince(body.since), h);
      }
      if (url.pathname === '/api/export' && req.method === 'GET') {
        return send(res, 200, changesSince(0), { ...h, 'Content-Disposition': 'attachment; filename="ledger-export.json"' });
      }
      return send(res, 404, { error: 'not found' }, h);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error(e);
    send(res, e.status || (e instanceof SyntaxError ? 400 : 500), { error: e.status === 413 ? '数据太大' : '服务器出错' }, url.pathname.startsWith('/api/') ? cors(req) : {});
  }
});

server.listen(PORT, HOST, () => {
  console.log(`记账同步服务器已启动：http://${HOST}:${PORT}`);
  console.log(`数据目录：${DATA_DIR}（${Object.keys(db.records).length} 条记录）`);
  if (STATIC_DIR) console.log(`App 网页目录：${STATIC_DIR}`);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { clearTimeout(saveTimer); await saving; await writeDb().catch(() => {}); process.exit(0); });
