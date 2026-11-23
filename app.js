import { parseExpense, CATEGORY_LIST, guessCategory } from './parser.js';

const $ = s => document.querySelector(s);
const KEY = 'voice-ledger.records.v1';
const SKEY = 'voice-ledger.settings.v1';
const SYM = { CNY: '¥', NZD: 'NZ$' };

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { toast('保存失败：' + e.message); } },
};
let records = store.get(KEY, []);
let settings = { defaultCurrency: 'NZD', rate: 4.1, ...store.get(SKEY, {}) };
let editingId = null;

const saveRecords = () => store.set(KEY, records);
const saveSettings = () => store.set(SKEY, settings);
const money = (n, c) => `${SYM[c]}${(+n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const todayStr = () => new Date().toLocaleDateString('sv-SE');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ---------- 表单 ---------- */
const form = $('#form');
$('#catSelect').innerHTML = CATEGORY_LIST.map(c => `<option>${c}</option>`).join('');

function fillForm(r, title = '确认这条记录') {
  form.hidden = false;
  $('#formTitle').textContent = title;
  form.store.value = r.store || '';
  form.item.value = r.item || '';
  form.amount.value = r.amount ?? '';
  form.currency.value = r.currency || settings.defaultCurrency;
  form.category.value = r.category || '其他';
  form.date.value = r.date || todayStr();
  form.note.value = r.note || '';
  form.classList.remove('flash'); void form.offsetWidth; form.classList.add('flash');
  form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (r.amount == null) setTimeout(() => form.amount.focus(), 300);
}
function closeForm() { form.hidden = true; editingId = null; form.reset(); }

form.addEventListener('submit', e => {
  e.preventDefault();
  const r = {
    store: form.store.value.trim(), item: form.item.value.trim(),
    amount: Math.round(parseFloat(form.amount.value) * 100) / 100,
    currency: form.currency.value, category: form.category.value,
    date: form.date.value, note: form.note.value.trim(),
  };
  if (!(r.amount > 0)) { toast('请填写金额'); form.amount.focus(); return; }
  if (editingId) {
    Object.assign(records.find(x => x.id === editingId), r);
    toast('已更新');
  } else {
    records.push({ id: crypto.randomUUID?.() || String(Date.now() + Math.random()), createdAt: Date.now(), ...r });
    toast(`已记录 ${money(r.amount, r.currency)}`);
  }
  saveRecords(); closeForm(); render();
});
$('#btnCancel').onclick = closeForm;
// 改了商店/物品后，若分类还是“其他”，自动再猜一次
['store', 'item'].forEach(n => form[n].addEventListener('change', () => {
  if (form.category.value === '其他') form.category.value = guessCategory(form.store.value, form.item.value);
}));

function handleText(text) {
  if (!text.trim()) return;
  editingId = null;
  const r = parseExpense(text, { defaultCurrency: settings.defaultCurrency });
  fillForm(r);
  if (r.amount == null) toast('没听到金额，请手动补上');
}
$('#btnParse').onclick = () => { handleText($('#sayText').value); $('#sayText').value = ''; };
$('#sayText').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btnParse').click(); });

/* ---------- 语音识别 ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const mic = $('#btnMic'), hint = $('#micHint');
const defaultHint = hint.textContent;
let rec = null, listening = false, finalText = '';

if (!SR) {
  hint.textContent = '这个浏览器不支持网页语音识别。请点下面输入框，用键盘上的🎤听写，再按“识别”。';
  mic.onclick = () => $('#sayText').focus();
} else {
  mic.onclick = () => listening ? rec.stop() : start();
}

function start() {
  rec = new SR();
  rec.lang = 'zh-CN';
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  finalText = '';
  rec.onstart = () => { listening = true; mic.classList.add('listening'); hint.classList.add('live'); hint.textContent = '正在听…'; };
  rec.onresult = e => {
    let interim = '';
    finalText = '';
    for (const res of e.results) (res.isFinal ? (finalText += res[0].transcript) : (interim += res[0].transcript));
    hint.textContent = finalText + interim || '正在听…';
  };
  rec.onerror = e => {
    const map = { 'not-allowed': '没有麦克风权限，请在浏览器设置里允许。', 'no-speech': '没听到声音，再试一次。', network: '语音识别需要联网。', 'audio-capture': '找不到麦克风。' };
    toast(map[e.error] || '识别出错：' + e.error);
  };
  rec.onend = () => {
    listening = false; mic.classList.remove('listening'); hint.classList.remove('live');
    const text = finalText || (hint.textContent !== '正在听…' ? hint.textContent : '');
    hint.textContent = text ? `“${text}”` : defaultHint;
    if (text) handleText(text);
  };
  try { rec.start(); } catch (err) { toast('无法启动语音识别：' + err.message); }
}

/* ---------- 列表与统计 ---------- */
const ym = d => d.slice(0, 7);
function renderMonths() {
  const sel = $('#monthFilter'), cur = sel.value || ym(todayStr());
  const months = [...new Set([ym(todayStr()), ...records.map(r => ym(r.date))])].sort().reverse();
  sel.innerHTML = months.map(m => `<option value="${m}">${m.replace('-', ' 年 ')} 月</option>`).join('') + '<option value="all">全部</option>';
  sel.value = months.includes(cur) || cur === 'all' ? cur : months[0];
}

function render() {
  renderMonths();
  const m = $('#monthFilter').value;
  const rows = records.filter(r => m === 'all' || ym(r.date) === m)
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);

  const sum = c => rows.filter(r => r.currency === c).reduce((s, r) => s + r.amount, 0);
  const cny = sum('CNY'), nzd = sum('NZD'), rate = +settings.rate || 0;
  const label = m === 'all' ? '全部' : (m === ym(todayStr()) ? '本月' : m);
  $('#summary').innerHTML = `
    <div class="stat nzd"><div class="label">${label} 纽币</div><div class="val">${money(nzd, 'NZD')}</div></div>
    <div class="stat cny"><div class="label">${label} 人民币</div><div class="val">${money(cny, 'CNY')}</div></div>
    ${rate ? `<div class="stat total"><span class="label">合计折算（1 NZD = ${rate} CNY）</span><span class="val">≈ ${money(cny + nzd * rate, 'CNY')} · ${money(nzd + cny / rate, 'NZD')}</span></div>` : ''}`;

  $('#empty').hidden = rows.length > 0;
  let html = '', lastDay = '';
  for (const r of rows) {
    if (r.date !== lastDay) {
      lastDay = r.date;
      const dayRows = rows.filter(x => x.date === r.date);
      const parts = ['NZD', 'CNY'].map(c => [c, dayRows.filter(x => x.currency === c).reduce((s, x) => s + x.amount, 0)]).filter(p => p[1]).map(p => money(p[1], p[0]));
      html += `<li class="day"><span>${r.date}${r.date === todayStr() ? ' · 今天' : ''}</span><span>${parts.join(' + ')}</span></li>`;
    }
    html += `<li class="rec" data-id="${esc(r.id)}">
      <div class="cat">${esc(r.category.slice(0, 2))}</div>
      <div class="main"><div class="t1">${esc(r.item || r.store || '（未填写）')}</div>
        <div class="t2">${esc([r.store && r.item ? r.store : '', r.category].filter(Boolean).join(' · '))}</div></div>
      <div><div class="amt ${r.currency}">${money(r.amount, r.currency)}</div><button class="del" data-del="${esc(r.id)}">删除</button></div>
    </li>`;
  }
  $('#list').innerHTML = html;
}

$('#list').addEventListener('click', e => {
  const delId = e.target.dataset?.del;
  if (delId) {
    e.stopPropagation();
    const r = records.find(x => x.id === delId);
    if (confirm(`删除这条记录？\n${r.item || r.store} ${money(r.amount, r.currency)}`)) {
      records = records.filter(x => x.id !== delId); saveRecords(); render(); toast('已删除');
    }
    return;
  }
  const li = e.target.closest('.rec');
  if (li) { const r = records.find(x => x.id === li.dataset.id); editingId = r.id; fillForm(r, '修改记录'); }
});
$('#monthFilter').onchange = render;

/* ---------- 设置 / 导出 ---------- */
const dlg = $('#settings');
$('#btnSettings').onclick = () => { $('#setDefaultCur').value = settings.defaultCurrency; $('#setRate').value = settings.rate; dlg.showModal(); };
$('#setDefaultCur').onchange = e => { settings.defaultCurrency = e.target.value; saveSettings(); };
$('#setRate').onchange = e => { settings.rate = parseFloat(e.target.value) || 0; saveSettings(); render(); };

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$('#btnCsv').onclick = () => {
  const head = ['日期', '商店', '物品', '金额', '币种', '分类', '原话'];
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [...records].sort((a, b) => a.date.localeCompare(b.date))
    .map(r => [r.date, r.store, r.item, r.amount, r.currency, r.category, r.note].map(q).join(','));
  download(`记账-${todayStr()}.csv`, '﻿' + [head.join(','), ...lines].join('\r\n'), 'text/csv;charset=utf-8');
};
$('#btnBackup').onclick = () => download(`记账备份-${todayStr()}.json`, JSON.stringify({ version: 1, records, settings }, null, 2), 'application/json');
$('#fileRestore').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const incoming = Array.isArray(data) ? data : data.records;
    if (!Array.isArray(incoming)) throw new Error('格式不对');
    const ids = new Set(records.map(r => r.id));
    const added = incoming.filter(r => r && r.id && !ids.has(r.id) && r.amount > 0);
    records.push(...added); saveRecords(); render();
    toast(`已恢复 ${added.length} 条记录`);
  } catch (err) { toast('恢复失败：' + err.message); }
  e.target.value = '';
};
$('#btnClear').onclick = () => {
  if (records.length && confirm(`确定清空全部 ${records.length} 条记录？建议先备份。`)) { records = []; saveRecords(); render(); toast('已清空'); }
};

render();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
