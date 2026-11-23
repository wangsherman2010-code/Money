import { parseMany, EXPENSE_CATS, INCOME_CATS, guessCategory, memoryKey } from './parser.js';
import { CURRENCIES, CODES, sym, dec, cname, defaultRates } from './currencies.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const KEY = 'voice-ledger.records.v1';
const SKEY = 'voice-ledger.settings.v1';
const MKEY = 'voice-ledger.memory.v1';
const WD = ['日', '一', '二', '三', '四', '五', '六'];

/* ---------------- 存储 ---------------- */
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { toast('保存失败：' + e.message); } },
};
let settings = {
  parser: 'local', apiKey: '', model: 'claude-opus-5-5', confirm: true,
  mainCurrency: 'CNY', defaultCurrency: 'NZD', currencies: ['NZD', 'CNY'],
  accounts: ['卡', '现金', '微信', '支付宝'], defaultAccount: '卡', theme: 'auto',
  ...store.get(SKEY, {}),
};
// 汇率：rates[X] = 1 纽币能换多少 X。旧版只有 settings.rate（1 NZD = ? CNY）
settings.rates = { ...defaultRates(), ...(settings.rate ? { CNY: settings.rate } : {}), ...(settings.rates || {}) };
settings.rate = undefined;
const enabled = () => settings.currencies.filter(c => CURRENCIES[c]);
// 旧版记录没有 type/account，补上
let records = store.get(KEY, []).map(r => ({ type: 'expense', account: '', ...r }));
let memory = store.get(MKEY, {});
const saveRecords = () => store.set(KEY, records);
const saveSettings = () => store.set(SKEY, settings);
const saveMemory = () => store.set(MKEY, memory);

/* ---------------- 工具 ---------------- */
const pad = n => String(n).padStart(2, '0');
const dstr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => dstr(new Date());
const ym = d => d.slice(0, 7);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => crypto.randomUUID?.() || String(Date.now()) + Math.random().toString(16).slice(2);
const r2 = n => Math.round(n * 100) / 100;
function money(n, cur, { sign = false } = {}) {
  const d = dec(cur);
  const s = Math.abs(n).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
  return `${sign && n < 0 ? '-' : ''}${sym(cur)}${s}`;
}
function short(n, cur) {
  const a = Math.abs(n);
  const s = a >= 10000 ? (a / 10000).toFixed(1) + '万' : a >= 1000 ? (a / 1000).toFixed(1) + 'k' : a.toFixed(a < 100 ? 1 : 0);
  return sym(cur) + s.replace(/\.0(?=[k万]?$)/, '');
}
function toMain(amount, cur) {
  const main = settings.mainCurrency;
  if (cur === main) return amount;
  const from = +settings.rates[cur], to = +settings.rates[main];
  return from && to ? amount / from * to : amount;
}
const catInfo = (type, name) => (type === 'income' ? INCOME_CATS : EXPENSE_CATS).find(c => c.name === name)
  || EXPENSE_CATS.concat(INCOME_CATS).find(c => c.name === name) || { name, emoji: '🏷️' };
const allCats = type => {
  const base = (type === 'income' ? INCOME_CATS : EXPENSE_CATS).map(c => c.name);
  const extra = records.filter(r => r.type === type).map(r => r.category).filter(c => c && !base.includes(c));
  return [...base, ...new Set(extra)];
};
// 1 单位 cur 值多少主货币
const perMain = cur => (+settings.rates[settings.mainCurrency]) / (+settings.rates[cur]);
const fmtRate = v => v >= 100 ? v.toFixed(2) : v >= 1 ? v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') : v.toPrecision(4);
function rateNote(rows) {
  const used = [...new Set(rows.map(r => r.currency))].filter(c => c !== settings.mainCurrency);
  return used.length ? '（' + used.map(c => `1 ${c} = ${fmtRate(perMain(c))} ${settings.mainCurrency}`).join('，') + '）' : '';
}
function sums(rows) {
  let inc = 0, exp = 0;
  for (const r of rows) { const v = toMain(r.amount, r.currency); r.type === 'income' ? inc += v : exp += v; }
  return { inc, exp, bal: inc - exp };
}

let toastTimer;
function toast(msg, action) {
  $('#toastMsg').textContent = msg;
  const btn = $('#toastAction');
  btn.hidden = !action;
  if (action) { btn.textContent = action.label; btn.onclick = () => { action.fn(); $('#toast').classList.remove('show'); }; }
  $('#toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('show'), action ? 5000 : 2400);
}

/* ---------------- 状态 ---------------- */
const now = new Date();
const state = { view: 'trans', tab: 'daily', month: `${now.getFullYear()}-${pad(now.getMonth() + 1)}`, statsKind: 'expense', search: '', selDay: null, catFilter: null };

function shiftMonth(delta) {
  if (state.tab === 'monthly' && state.view === 'trans') { state.month = `${+state.month.slice(0, 4) + delta}${state.month.slice(4)}`; }
  else {
    const [y, m] = state.month.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    state.month = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  }
  state.selDay = null; state.catFilter = null;
  render();
}

/* ---------------- 渲染 ---------------- */
function render() {
  const [y, m] = state.month.split('-');
  const yearMode = state.view === 'trans' && state.tab === 'monthly';
  $('#monthLabel').textContent = state.search ? '搜索结果' : yearMode ? `${y} 年` : `${y} 年 ${+m} 月`;
  $('#monthNav').style.visibility = state.view === 'settings' ? 'hidden' : '';
  $('#composeForm').hidden = state.view === 'settings';
  $$('.view').forEach(v => v.hidden = v.id !== 'view-' + state.view);
  $$('#bottomNav button').forEach(b => b.classList.toggle('on', b.dataset.view === state.view));
  $$('#transTabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === state.tab));
  $$('#statsTabs button').forEach(b => b.classList.toggle('on', b.dataset.kind === state.statsKind));
  if (state.view === 'trans') renderTrans();
  if (state.view === 'stats') renderStats();
  if (state.view === 'accounts') renderAccounts();
  if (state.view === 'settings') renderSettings();
  $('#storeList').innerHTML = Object.values(memory).map(v => `<option value="${esc(v.name)}">`).join('');
}

function matchesSearch(r, q) {
  const hay = [r.store, r.item, r.category, r.account, r.note, String(r.amount), r.date].join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(w => hay.includes(w));
}
const sortRecs = rows => rows.sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));
function monthRows() {
  if (state.search) return sortRecs(records.filter(r => matchesSearch(r, state.search)));
  return sortRecs(records.filter(r => ym(r.date) === state.month));
}

function totalsHtml(rows) {
  const s = sums(rows), c = settings.mainCurrency;
  return `<div><div class="l">收入</div><div class="v inc">${money(s.inc, c)}</div></div>
    <div><div class="l">支出</div><div class="v exp">${money(s.exp, c)}</div></div>
    <div><div class="l">结余</div><div class="v">${money(s.bal, c, { sign: true })}</div></div>`;
}

function dayListHtml(rows) {
  if (!rows.length) return '';
  const byDay = new Map();
  for (const r of rows) (byDay.get(r.date) || byDay.set(r.date, []).get(r.date)).push(r);
  const c = settings.mainCurrency;
  let html = '';
  for (const [date, list] of byDay) {
    const d = new Date(date + 'T00:00:00'), s = sums(list), isToday = date === todayStr();
    html += `<div class="day"><div class="day-head">
      <span class="d">${d.getDate()}</span><span class="wd ${isToday ? 'today' : ''}">${isToday ? '今天' : '周' + WD[d.getDay()]}</span>
      <span class="small" style="margin:0">${state.search ? date.slice(0, 7).replace('-', '.') : `${d.getMonth() + 1}月`}</span>
      <span class="sums">${s.inc ? `<span class="inc">${money(s.inc, c)}</span>` : ''}${s.exp ? `<span class="exp">${money(s.exp, c)}</span>` : ''}</span>
    </div>`;
    for (const r of list) {
      const ci = catInfo(r.type, r.category);
      const title = r.store || r.item || '（未填写）';
      const sub = [r.store ? r.item : '', r.account].filter(Boolean).join(' · ');
      const conv = r.currency !== c ? `<small>≈ ${money(toMain(r.amount, r.currency), c)}</small>` : '';
      html += `<div class="rec" data-id="${esc(r.id)}">
        <div class="cat"><b>${ci.emoji}</b>${esc(r.category)}</div>
        <div class="main"><div class="t1">${esc(title)}</div>${sub ? `<div class="t2">${esc(sub)}</div>` : ''}</div>
        <div class="amt ${r.type === 'income' ? 'inc' : 'exp'}">${money(r.amount, r.currency)}${conv}</div>
      </div>`;
    }
    html += '</div>';
  }
  return html;
}

const EMPTY = `<div class="empty">这个月还没有记录。<br>在下面输入一句话，比如<br><b>Woolworth Westgate 买菜 41</b><br><b>昨天在麦当劳吃午饭 35 块 微信</b><br><b>收到培训费 3000 纽币</b></div>`;

function renderTrans() {
  let rows = monthRows();
  if (state.catFilter) rows = rows.filter(r => r.category === state.catFilter);
  const body = $('#transBody');
  if (state.tab === 'monthly' && !state.search) {
    const y = state.month.slice(0, 4);
    const yearRows = records.filter(r => r.date.startsWith(y));
    $('#totals').innerHTML = totalsHtml(yearRows);
    const c = settings.mainCurrency;
    let html = '<div class="months"><div class="mrow head"><span class="m">月份</span><span>收入</span><span>支出</span><span>结余</span></div>';
    for (let m = 12; m >= 1; m--) {
      const key = `${y}-${pad(m)}`, rs = yearRows.filter(r => ym(r.date) === key);
      if (!rs.length && key > ym(todayStr())) continue;
      const s = sums(rs);
      html += `<div class="mrow ${key === ym(todayStr()) ? 'cur' : ''}" data-goto="${key}"><span class="m">${m} 月</span>
        <span class="inc">${s.inc ? short(s.inc, c) : '–'}</span><span class="exp">${s.exp ? short(s.exp, c) : '–'}</span><span>${rs.length ? short(s.bal, c).replace(/^/, s.bal < 0 ? '-' : '') : '–'}</span></div>`;
    }
    body.innerHTML = html + '</div>';
    return;
  }
  $('#totals').innerHTML = totalsHtml(rows);
  if (state.tab === 'calendar' && !state.search) {
    body.innerHTML = calendarHtml(rows) + (state.selDay ? dayListHtml(rows.filter(r => r.date === state.selDay)) || '<div class="empty">这天没有记录</div>' : '');
    return;
  }
  const chip = state.catFilter ? `<div class="search-row" style="padding-top:8px"><span class="badge" style="font-size:14px;padding:4px 10px">${esc(state.catFilter)}</span><button class="link" id="clearCat">显示全部</button></div>` : '';
  body.innerHTML = chip + (dayListHtml(rows) || (state.search ? '<div class="empty">没有找到</div>' : EMPTY));
}

function calendarHtml(rows) {
  const [y, m] = state.month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7)); // 周一开始
  const c = settings.mainCurrency;
  const byDay = {};
  for (const r of rows) (byDay[r.date] ||= []).push(r);
  let html = '<div class="cal"><div class="cal-grid">' + ['一', '二', '三', '四', '五', '六', '日'].map(w => `<div class="wh">${w}</div>`).join('');
  const d = new Date(start);
  for (let i = 0; i < 42; i++) {
    const ds = dstr(d), inMonth = d.getMonth() === m - 1;
    if (i === 35 && !inMonth) break;
    const s = byDay[ds] ? sums(byDay[ds]) : null;
    html += `<button class="c ${inMonth ? '' : 'other'} ${ds === todayStr() ? 'today' : ''} ${ds === state.selDay ? 'sel' : ''}" data-day="${inMonth ? ds : ''}">
      <span class="n">${d.getDate()}</span>${s?.inc ? `<span class="i inc">${short(s.inc, c)}</span>` : ''}${s?.exp ? `<span class="e exp">${short(s.exp, c)}</span>` : ''}</button>`;
    d.setDate(d.getDate() + 1);
  }
  return html + '</div></div>';
}

function renderStats() {
  const kind = state.statsKind, c = settings.mainCurrency;
  const rows = records.filter(r => ym(r.date) === state.month && r.type === kind);
  const total = rows.reduce((s, r) => s + toMain(r.amount, r.currency), 0);
  const byCat = {};
  for (const r of rows) byCat[r.category] = (byCat[r.category] || 0) + toMain(r.amount, r.currency);
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const max = cats[0]?.[1] || 1;
  const label = kind === 'income' ? '收入' : '支出';

  let html = `<div class="panel"><h3>本月${label}</h3><div class="sub">按分类，折算成${cname(c)}${rateNote(rows)}</div>
    <div class="hero ${kind === 'income' ? 'inc' : 'exp'}">${money(total, c)}</div><div class="sub">${rows.length} 笔</div>`;
  html += cats.length ? cats.map(([name, v]) => `<div class="catrow" data-cat="${esc(name)}">
      <span>${catInfo(kind, name).emoji}</span><span>${esc(name)}</span>
      <span class="bar"><i style="width:${(v / max * 100).toFixed(1)}%"></i></span>
      <span class="val">${money(v, c)}<small>${(v / total * 100).toFixed(0)}%</small></span></div>`).join('')
    : `<div class="empty" style="padding:16px">这个月没有${label}记录</div>`;
  html += '</div>';

  // 近 6 个月趋势
  const [y, m] = state.month.split('-').map(Number);
  const months = [];
  for (let i = 5; i >= 0; i--) { const d = new Date(y, m - 1 - i, 1); months.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`); }
  const vals = months.map(k => records.filter(r => ym(r.date) === k && r.type === kind).reduce((s, r) => s + toMain(r.amount, r.currency), 0));
  const vmax = Math.max(...vals, 1);
  html += `<div class="panel"><h3>近 6 个月${label}</h3><div class="sub">点柱子查看那个月</div><div class="trend">` +
    months.map((k, i) => `<div class="col ${k === state.month ? 'cur' : ''}" data-goto-stats="${k}" data-tip="${+k.slice(5)} 月 ${money(vals[i], c)}">
      ${k === state.month ? `<span class="lbl">${short(vals[i], c)}</span>` : ''}<i style="height:${(vals[i] / vmax * 100).toFixed(1)}%"></i></div>`).join('') +
    `</div><div class="trend-x">${months.map(k => `<span>${+k.slice(5)}月</span>`).join('')}</div></div>`;
  $('#statsBody').innerHTML = html;
}

function renderAccounts() {
  const accs = [...new Set([...settings.accounts, ...records.map(r => r.account).filter(Boolean)])];
  const c = settings.mainCurrency;
  const line = (rows) => {
    const parts = [];
    for (const cur of [...new Set(rows.map(r => r.currency))]) {
      const inc = rows.filter(r => r.currency === cur && r.type === 'income').reduce((s, r) => s + r.amount, 0);
      const exp = rows.filter(r => r.currency === cur && r.type === 'expense').reduce((s, r) => s + r.amount, 0);
      if (inc) parts.push(`<span class="inc">收 ${money(inc, cur)}</span>`);
      if (exp) parts.push(`<span class="exp">支 ${money(exp, cur)}</span>`);
    }
    return parts.join('') || '<span>–</span>';
  };
  let html = `<div class="panel"><h3>按账户</h3><div class="sub">${state.month.replace('-', ' 年 ')} 月 · 原币种显示</div>`;
  for (const a of accs) {
    const rows = records.filter(r => r.account === a && ym(r.date) === state.month);
    const all = records.filter(r => r.account === a);
    const s = sums(rows);
    html += `<div class="acc"><span class="name">${esc(a)}</span><span class="num exp">${money(s.exp, c)}</span>
      <div class="line">本月 ${line(rows)}</div><div class="line">累计 ${line(all)}</div></div>`;
  }
  const none = records.filter(r => !r.account && ym(r.date) === state.month);
  if (none.length) html += `<div class="acc"><span class="name">未指定</span><span class="num exp">${money(sums(none).exp, c)}</span><div class="line">本月 ${line(none)}</div></div>`;
  $('#accountsBody').innerHTML = html + '</div>';
}

function renderSettings() {
  $('#setParser').value = settings.parser;
  $('#aiSettings').hidden = settings.parser !== 'ai';
  $('#setApiKey').value = settings.apiKey;
  $('#setModel').value = settings.model;
  $('#setConfirm').checked = settings.confirm;
  const opts = enabled().map(c => `<option value="${c}">${sym(c).trim()} ${cname(c)}</option>`).join('');
  $('#setMainCur').innerHTML = opts; $('#setMainCur').value = settings.mainCurrency;
  $('#setDefaultCur').innerHTML = opts; $('#setDefaultCur').value = settings.defaultCurrency;
  $('#curChips').innerHTML = CODES.map(c => `<label class="chip">
    <input type="checkbox" value="${c}" ${settings.currencies.includes(c) ? 'checked' : ''}>${cname(c)} <small>${sym(c).trim()}</small></label>`).join('');
  $('#rateList').innerHTML = enabled().filter(c => c !== settings.mainCurrency).map(c => `<label class="rate">
    <span>1 ${cname(c)} =</span><input type="number" step="any" min="0" inputmode="decimal" data-rate="${c}" value="${fmtRate(perMain(c))}"><span>${cname(settings.mainCurrency)}</span></label>`).join('')
    + `<p class="small">${settings.ratesUpdated ? '汇率更新于 ' + settings.ratesUpdated : '现在是大概的默认汇率，建议点“在线更新”。'}</p>`;
  $('#setAccounts').value = settings.accounts.join(', ');
  $('#setDefaultAcc').innerHTML = settings.accounts.map(a => `<option>${esc(a)}</option>`).join('');
  $('#setDefaultAcc').value = settings.defaultAccount;
  $('#setTheme').value = settings.theme;
  $('#dataInfo').textContent = `共 ${records.length} 条记录，已学会 ${Object.keys(memory).length} 个商家。数据只存在这台设备的浏览器里，请定期“备份 JSON”。`;
}

function applyTheme() {
  if (settings.theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = settings.theme;
}

/* ---------------- 识别并保存 ---------------- */
const parseOpts = () => ({ defaultCurrency: settings.defaultCurrency, accounts: settings.accounts, defaultAccount: settings.defaultAccount, memory });

async function recognize(text) {
  if (settings.parser === 'ai' && settings.apiKey && navigator.onLine) {
    try {
      const { aiParse } = await import('./ai.js');
      const knownStores = Object.values(memory).slice(-60).map(v => `${v.name}→${v.category}`);
      const recs = await aiParse(text, {
        apiKey: settings.apiKey, model: settings.model, today: todayStr(),
        defaultCurrency: settings.defaultCurrency, currencies: enabled(), defaultAccount: settings.defaultAccount, accounts: settings.accounts,
        expenseCats: allCats('expense'), incomeCats: allCats('income'), knownStores,
      });
      if (recs.length) return recs;
      toast('AI 没找到金额，改用本地规则');
    } catch (e) {
      console.warn(e);
      toast('AI 出错（' + (e.status || e.message || e) + '），改用本地规则');
    }
  }
  return parseMany(text, parseOpts());
}

async function submitText(text) {
  text = text.trim();
  if (!text) return;
  const send = $('#btnSend');
  send.classList.add('busy'); send.disabled = true;
  try {
    const recs = await recognize(text);
    if (!recs.length) { toast('没看懂这句话，试试“商家 物品 金额”'); return; }
    $('#composeInput').value = ''; autosize();
    const ready = recs.every(r => r.amount > 0);
    if (!settings.confirm && ready) {
      const added = recs.map(addRecord);
      saveRecords(); render();
      toast(added.length > 1 ? `已记 ${added.length} 笔` : `已记 ${added[0].store || added[0].item} ${money(added[0].amount, added[0].currency)}`, {
        label: '撤销', fn: () => { const ids = new Set(added.map(a => a.id)); records = records.filter(r => !ids.has(r.id)); saveRecords(); render(); },
      });
    } else openSheet(recs);
  } finally { send.classList.remove('busy'); send.disabled = false; }
}

function learn(r) {
  if (!r.store) return;
  memory[memoryKey(r.store)] = { name: r.store, category: r.category, account: r.account, currency: r.currency, type: r.type };
  saveMemory();
}
function addRecord(r) {
  const rec = {
    id: uid(), createdAt: Date.now(), type: r.type || 'expense', date: r.date || todayStr(),
    store: (r.store || '').trim(), item: (r.item || '').trim(), amount: r2(+r.amount), currency: r.currency,
    category: r.category || guessCategory(r.type, r.store, r.item), account: r.account || '', note: r.note || '',
  };
  records.push(rec); learn(rec);
  if (rec.date.slice(0, 7) !== state.month && !state.search) state.month = rec.date.slice(0, 7);
  return rec;
}

/* ---------------- 确认 / 编辑面板 ---------------- */
let sheetEditId = null;
const sheet = $('#sheet');

function curPicker(cur) {
  const list = [...new Set([...enabled(), cur])];
  if (list.length <= 3) return `<div class="seg cur">${list.map(c => `<button type="button" data-v="${c}" class="${c === cur ? 'on' : ''}">${sym(c).trim()}</button>`).join('')}</div>`;
  return `<select class="cur-select" aria-label="币种">${list.map(c => `<option value="${c}" ${c === cur ? 'selected' : ''}>${sym(c).trim()} ${cname(c)}</option>`).join('')}</select>`;
}
function cardHtml(r, i, multi) {
  const type = r.type || 'expense';
  const cats = allCats(type);
  if (r.category && !cats.includes(r.category)) cats.push(r.category);
  const accs = [...new Set([...settings.accounts, r.account].filter(Boolean))];
  return `<div class="ecard" data-i="${i}" data-type="${type}" data-cur="${r.currency || settings.defaultCurrency}">
    ${multi ? '<button type="button" class="x" aria-label="去掉这条">×</button>' : ''}
    ${r.note && !sheetEditId ? `<div class="src">“${esc(r.note)}”${r.ai ? '<span class="badge">AI</span>' : r.learned ? '<span class="badge">已学会的商家</span>' : ''}</div>` : ''}
    <div class="g">
      <div class="full amount-row">
        <div class="seg type"><button type="button" data-v="expense" class="${type === 'expense' ? 'on' : ''}">支出</button><button type="button" data-v="income" class="${type === 'income' ? 'on' : ''}">收入</button></div>
        <input name="amount" type="number" inputmode="decimal" step="0.01" min="0" placeholder="金额" value="${r.amount ?? ''}" required>
        ${curPicker(r.currency || settings.defaultCurrency)}
      </div>
      <label>商家<input name="store" list="storeList" value="${esc(r.store)}" placeholder="Woolworth Westgate"></label>
      <label>物品 / 说明<input name="item" value="${esc(r.item)}" placeholder="买菜"></label>
      <label>分类<select name="category">${cats.map(c => `<option ${c === r.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
      <label>账户<select name="account"><option value="">（不指定）</option>${accs.map(a => `<option ${a === r.account ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select></label>
      <label class="full">日期<input name="date" type="date" value="${r.date || todayStr()}" required></label>
    </div></div>`;
}

let sheetRecs = [];
function openSheet(recs, editId = null) {
  sheetEditId = editId;
  sheetRecs = recs;
  $('#sheetTitle').textContent = editId ? '修改记录' : recs.length > 1 ? `识别出 ${recs.length} 笔` : '确认记录';
  $('#btnSave').textContent = editId ? '保存修改' : recs.length > 1 ? `全部保存（${recs.length}）` : '保存';
  $('#btnDelete').hidden = !editId;
  $('#sheetCards').innerHTML = recs.map((r, i) => cardHtml(r, i, recs.length > 1)).join('');
  sheet.showModal();
  const empty = sheet.querySelector('input[name=amount]:invalid');
  if (empty) setTimeout(() => empty.focus(), 250);
}

$('#sheetCards').addEventListener('click', e => {
  const card = e.target.closest('.ecard');
  if (!card) return;
  if (e.target.classList.contains('x')) {
    card.remove();
    const n = $$('#sheetCards .ecard').length;
    if (!n) sheet.close(); else $('#btnSave').textContent = n > 1 ? `全部保存（${n}）` : '保存';
    return;
  }
  const b = e.target.closest('.seg button');
  if (!b) return;
  b.parentElement.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
  if (b.parentElement.classList.contains('cur')) card.dataset.cur = b.dataset.v;
  else {
    card.dataset.type = b.dataset.v;
    const f = n => card.querySelector(`[name=${n}]`).value;
    const sel = card.querySelector('[name=category]');
    sel.innerHTML = allCats(b.dataset.v).map(c => `<option>${esc(c)}</option>`).join('');
    sel.value = guessCategory(b.dataset.v, f('store'), f('item'));
  }
});
// 改商家时，若这个商家学过，自动带出分类/账户
$('#sheetCards').addEventListener('change', e => {
  if (e.target.classList.contains('cur-select')) { e.target.closest('.ecard').dataset.cur = e.target.value; return; }
  if (e.target.name !== 'store') return;
  const card = e.target.closest('.ecard'), m = memory[memoryKey(e.target.value)];
  if (m && (m.type || 'expense') === card.dataset.type) {
    card.querySelector('[name=category]').value = m.category;
    if (m.account) card.querySelector('[name=account]').value = m.account;
  }
});

$('#sheetForm').addEventListener('submit', e => {
  if (e.submitter?.value !== 'save') return;
  e.preventDefault();
  const cards = $$('#sheetCards .ecard');
  const out = [];
  for (const card of cards) {
    const f = n => card.querySelector(`[name=${n}]`).value;
    const amount = parseFloat(f('amount'));
    if (!(amount > 0)) { card.querySelector('[name=amount]').focus(); toast('请填写金额'); return; }
    out.push({ type: card.dataset.type, amount, currency: card.dataset.cur, store: f('store'), item: f('item'),
      category: f('category'), account: f('account'), date: f('date'), note: sheetRecs[+card.dataset.i]?.note || '' });
  }
  if (sheetEditId) {
    const rec = records.find(r => r.id === sheetEditId);
    Object.assign(rec, out[0], { amount: r2(out[0].amount), store: out[0].store.trim(), item: out[0].item.trim() });
    learn(rec);
    toast('已更新');
  } else {
    const added = out.map(addRecord);
    toast(added.length > 1 ? `已记 ${added.length} 笔` : `已记 ${money(added[0].amount, added[0].currency)}`);
  }
  saveRecords(); sheet.close(); render();
});
$('#btnDelete').onclick = () => {
  const rec = records.find(r => r.id === sheetEditId);
  if (!rec) return;
  records = records.filter(r => r.id !== sheetEditId);
  saveRecords(); sheet.close(); render();
  toast('已删除', { label: '撤销', fn: () => { records.push(rec); saveRecords(); render(); } });
};
sheet.addEventListener('click', e => { if (e.target === sheet) sheet.close(); });

/* ---------------- 交互绑定 ---------------- */
$('#monthNav').addEventListener('click', e => { const b = e.target.closest('[data-month]'); if (b) shiftMonth(+b.dataset.month); });
$('#monthLabel').onclick = () => { const d = new Date(); state.month = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; state.selDay = null; render(); };
$('#bottomNav').addEventListener('click', e => { const b = e.target.closest('[data-view]'); if (b) { state.view = b.dataset.view; render(); scrollTo(0, 0); } });
$('#transTabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) { state.tab = b.dataset.tab; state.selDay = null; render(); } });
$('#statsTabs').addEventListener('click', e => { const b = e.target.closest('[data-kind]'); if (b) { state.statsKind = b.dataset.kind; render(); } });

$('#transBody').addEventListener('click', e => {
  const rec = e.target.closest('.rec');
  if (rec) { const r = records.find(x => x.id === rec.dataset.id); if (r) openSheet([{ ...r }], r.id); return; }
  const day = e.target.closest('[data-day]');
  if (day && day.dataset.day) { state.selDay = state.selDay === day.dataset.day ? null : day.dataset.day; render(); return; }
  const go = e.target.closest('[data-goto]');
  if (go) { state.month = go.dataset.goto; state.tab = 'daily'; render(); return; }
  if (e.target.id === 'clearCat') { state.catFilter = null; render(); }
});
$('#statsBody').addEventListener('click', e => {
  const c = e.target.closest('[data-cat]');
  if (c) { state.catFilter = c.dataset.cat; state.view = 'trans'; state.tab = 'daily'; render(); return; }
  const g = e.target.closest('[data-goto-stats]');
  if (g) { state.month = g.dataset.gotoStats; render(); }
});
// 柱状图悬停提示
const tip = $('#tip');
document.addEventListener('pointerover', e => {
  const t = e.target.closest('[data-tip]');
  if (!t) { tip.hidden = true; return; }
  tip.textContent = t.dataset.tip; tip.hidden = false;
  const r = t.getBoundingClientRect();
  tip.style.left = Math.min(innerWidth - tip.offsetWidth - 8, Math.max(8, r.left + r.width / 2 - tip.offsetWidth / 2)) + 'px';
  tip.style.top = (r.top - 30) + 'px';
});

// 搜索
$('#btnSearch').onclick = () => { $('#searchRow').hidden = false; state.view = 'trans'; state.tab = 'daily'; $('#searchInput').focus(); render(); };
$('#searchInput').addEventListener('input', e => { state.search = e.target.value.trim(); render(); });
$('#btnSearchClose').onclick = () => { $('#searchRow').hidden = true; $('#searchInput').value = ''; state.search = ''; render(); };

// 输入框
const input = $('#composeInput');
function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight + 2, 120) + 'px'; }
input.addEventListener('input', autosize);
input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composeForm').requestSubmit(); }
});
$('#composeForm').addEventListener('submit', e => { e.preventDefault(); submitText(input.value); });

// 语音
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const mic = $('#btnMic'), live = $('#live');
let rec = null, listening = false;
mic.onclick = () => {
  if (!SR) { toast('这个浏览器不支持语音，请用键盘上的🎤听写'); input.focus(); return; }
  if (listening) { rec.stop(); return; }
  rec = new SR();
  rec.lang = 'zh-CN'; rec.interimResults = true; rec.continuous = false;
  let finalText = '';
  rec.onstart = () => { listening = true; mic.classList.add('listening'); live.hidden = false; live.textContent = '正在听…（中英文都可以）'; };
  rec.onresult = e => {
    let interim = ''; finalText = '';
    for (const res of e.results) res.isFinal ? finalText += res[0].transcript : interim += res[0].transcript;
    live.textContent = finalText + interim;
  };
  rec.onerror = e => toast({ 'not-allowed': '没有麦克风权限', 'no-speech': '没听到声音', network: '语音识别需要联网' }[e.error] || '语音出错：' + e.error);
  rec.onend = () => {
    listening = false; mic.classList.remove('listening'); live.hidden = true;
    const text = finalText || (live.textContent.startsWith('正在听') ? '' : live.textContent);
    if (text) { input.value = text; autosize(); submitText(text); }
  };
  try { rec.start(); } catch (err) { toast('无法启动语音：' + err.message); }
};

/* ---------------- 设置 ---------------- */
const bindSetting = (sel, key, fn = v => v, after) => $(sel).addEventListener('change', e => {
  settings[key] = fn(e.target.type === 'checkbox' ? e.target.checked : e.target.value);
  saveSettings(); after?.(); render();
});
bindSetting('#setParser', 'parser');
bindSetting('#setApiKey', 'apiKey', v => v.trim());
bindSetting('#setModel', 'model');
bindSetting('#setConfirm', 'confirm');
bindSetting('#setMainCur', 'mainCurrency');
bindSetting('#setDefaultCur', 'defaultCurrency');
$('#curChips').addEventListener('change', e => {
  const picked = $$('#curChips input:checked').map(x => x.value);
  if (!picked.length) { e.target.checked = true; return; }
  settings.currencies = CODES.filter(c => picked.includes(c));
  if (!settings.currencies.includes(settings.mainCurrency)) settings.mainCurrency = settings.currencies[0];
  if (!settings.currencies.includes(settings.defaultCurrency)) settings.defaultCurrency = settings.currencies[0];
  saveSettings(); render();
});
$('#rateList').addEventListener('change', e => {
  const c = e.target.dataset.rate, v = parseFloat(e.target.value);
  if (!c || !(v > 0)) return;
  settings.rates[c] = settings.rates[settings.mainCurrency] / v;
  saveSettings(); render();
});
bindSetting('#setAccounts', 'accounts', v => [...new Set(v.split(/[,，、]/).map(s => s.trim()).filter(Boolean))], () => {
  if (!settings.accounts.includes(settings.defaultAccount)) settings.defaultAccount = settings.accounts[0] || '';
  saveSettings();
});
bindSetting('#setDefaultAcc', 'defaultAccount');
bindSetting('#setTheme', 'theme', v => v, applyTheme);

$('#btnRate').onclick = async () => {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/NZD');
    const data = await res.json();
    if (!data?.rates?.CNY) throw new Error('没有数据');
    for (const c of CODES) if (data.rates[c]) settings.rates[c] = data.rates[c];
    settings.ratesUpdated = todayStr(); saveSettings(); render();
    toast('汇率已更新');
  } catch (e) { toast('更新汇率失败：' + e.message); }
};

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$('#btnCsv').onclick = () => {
  const head = ['日期', '收支', '分类', '商家', '物品', '金额', '币种', `折算${settings.mainCurrency}`, '账户', '原话'];
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [...records].sort((a, b) => a.date.localeCompare(b.date)).map(r =>
    [r.date, r.type === 'income' ? '收入' : '支出', r.category, r.store, r.item, r.amount, r.currency, r2(toMain(r.amount, r.currency)), r.account, r.note].map(q).join(','));
  download(`记账-${todayStr()}.csv`, '﻿' + [head.join(','), ...lines].join('\r\n'), 'text/csv;charset=utf-8');
};
$('#btnBackup').onclick = () => download(`记账备份-${todayStr()}.json`, JSON.stringify({ version: 2, records, memory, settings: { ...settings, apiKey: '' } }, null, 2), 'application/json');
$('#fileRestore').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const incoming = Array.isArray(data) ? data : data.records;
    if (!Array.isArray(incoming)) throw new Error('格式不对');
    const ids = new Set(records.map(r => r.id));
    const added = incoming.filter(r => r && r.id && !ids.has(r.id) && r.amount > 0).map(r => ({ type: 'expense', account: '', ...r }));
    records.push(...added);
    if (data.memory) { memory = { ...data.memory, ...memory }; saveMemory(); }
    saveRecords(); render(); toast(`已恢复 ${added.length} 条记录`);
  } catch (err) { toast('恢复失败：' + err.message); }
  e.target.value = '';
};
$('#fileImport').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const { importSpreadsheet } = await import('./importer.js');
    const { rows, skipped } = await importSpreadsheet(f);
    const seen = new Set(records.map(r => `${r.date}|${r.amount}|${r.currency}|${r.store}`));
    const fresh = rows.filter(r => !seen.has(`${r.date}|${r.amount}|${r.currency}|${r.store}`));
    for (const r of fresh) {
      records.push({ id: uid(), createdAt: Date.now(), ...r });
      if (r.store && !memory[memoryKey(r.store)]) learn(r);
      if (r.account && !settings.accounts.includes(r.account)) settings.accounts.push(r.account);
    }
    saveRecords(); saveSettings(); render();
    toast(`导入 ${fresh.length} 条${rows.length - fresh.length ? `，跳过重复 ${rows.length - fresh.length} 条` : ''}${skipped ? `，忽略转账等 ${skipped} 条` : ''}`);
  } catch (err) { console.error(err); toast('导入失败：' + err.message); }
  e.target.value = '';
};
$('#btnForget').onclick = () => { if (confirm('清除所有已学会的商家？（记录不会删除）')) { memory = {}; saveMemory(); render(); } };
$('#btnClear').onclick = () => {
  if (records.length && confirm(`确定清空全部 ${records.length} 条记录？建议先备份。`)) { records = []; saveRecords(); render(); toast('已清空'); }
};

/* ---------------- 启动 ---------------- */
// 旧版本数据：把已有商家学进来
if (!Object.keys(memory).length) records.forEach(r => r.store && learn(r));
applyTheme();
render();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
