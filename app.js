import { parseMany, EXPENSE_CATS, INCOME_CATS, matchCategory, memoryKey } from './parser.js';
import { CURRENCIES, CODES, sym, dec, cname, defaultRates } from './currencies.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const KEY = 'voice-ledger.records.v1';
const SKEY = 'voice-ledger.settings.v1';
const MKEY = 'voice-ledger.memory.v1';

/* ---------------- 存储 ---------------- */
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { toast(L('保存失败：', 'Could not save: ') + e.message); } },
};
let settings = {
  lang: 'zh',
  parser: 'local', apiKey: '', model: 'claude-opus-5-5', confirm: true,
  mainCurrency: 'CNY', defaultCurrency: 'NZD', currencies: ['NZD', 'CNY'],
  accounts: ['卡', '现金', '微信', '支付宝'], defaultAccount: '卡', theme: 'auto',
  fontSize: 1, fontWeight: 'medium', font: 'system', fontEn: 'same',
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

/* ---------------- 语言 ---------------- */
const isEn = () => settings.lang === 'en';
const L = (zh, en) => isEn() ? en : zh;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WD_ZH = ['日', '一', '二', '三', '四', '五', '六'], WD_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const monthName = m => L(`${m}月`, MON[m - 1]);                         // m: 1-12
const monthYear = (y, m) => L(`${y} 年 ${m} 月`, `${MON[m - 1]} ${y}`);
const curName = c => cname(c, isEn());

// 页面上写死的文字：第一次运行时把中文存到 data-zh，之后按语言切换
function applyStaticText() {
  document.documentElement.lang = isEn() ? 'en' : 'zh-CN';
  document.title = L('一句话记账', 'One-line Ledger');
  for (const el of $$('[data-en]')) {
    if (el.dataset.zh == null) el.dataset.zh = el.textContent;
    el.textContent = isEn() ? el.dataset.en : el.dataset.zh;
  }
  for (const el of $$('[data-en-ph]')) {
    if (el.dataset.zhPh == null) el.dataset.zhPh = el.placeholder;
    el.placeholder = isEn() ? el.dataset.enPh : el.dataset.zhPh;
  }
  for (const el of $$('[data-en-aria]')) {
    if (el.dataset.zhAria == null) el.dataset.zhAria = el.getAttribute('aria-label');
    el.setAttribute('aria-label', isEn() ? el.dataset.enAria : el.dataset.zhAria);
  }
}

/* ---------------- 分类（可编辑） ---------------- */
// settings.cats = { expense: [{ id, zh, en, emoji, kw: '逗号分隔关键词' }], income: [...] }
// 内置分类的 id 就是原来的中文名，所以旧记录不用改
const BUILTIN = Object.fromEntries([...EXPENSE_CATS, ...INCOME_CATS].map(c => [c.name, c]));
const defaultCats = list => list.map(c => ({ id: c.name, zh: c.name, en: c.en, emoji: c.emoji, kw: '' }));
if (!settings.cats) settings.cats = { expense: defaultCats(EXPENSE_CATS), income: defaultCats(INCOME_CATS) };
// 记录里出现、但分类表里没有的（比如导入的），自动补成自定义分类
function adoptUnknownCats() {
  let changed = false;
  for (const r of records) {
    const list = settings.cats[r.type] || settings.cats.expense;
    if (r.category && !list.some(c => c.id === r.category)) {
      list.splice(Math.max(0, list.length - 1), 0, { id: r.category, zh: r.category, en: r.category, emoji: '🏷️', kw: '' });
      changed = true;
    }
  }
  if (changed) saveSettings();
}
adoptUnknownCats();
const kwList = s => String(s || '').split(/[,，、;；\n]/).map(x => x.trim()).filter(Boolean);
const catsOf = type => settings.cats[type] || [];
const findCat = (type, id) => catsOf(type).find(c => c.id === id) || catsOf(type === 'income' ? 'expense' : 'income').find(c => c.id === id);
const catLabel = (type, id) => { const c = findCat(type, id); return c ? (L(c.zh || c.en, c.en || c.zh) || id) : id; };
const catEmoji = (type, id) => findCat(type, id)?.emoji || '🏷️';
const fallbackCat = type => { const l = catsOf(type); return (l.find(c => c.id === '其他' || c.id === '其他收入') || l[l.length - 1])?.id || ''; };
const matcherList = type => catsOf(type).map(c => ({ id: c.id, kw: kwList(c.kw), re: BUILTIN[c.id]?.re || null }));
const guess = (type, ...texts) => matchCategory(matcherList(type), ...texts) ?? fallbackCat(type);

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
  const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  return `${sign && n < 0 ? '-' : ''}${sym(cur)}${s}`;
}
function short(n, cur) {
  const a = Math.abs(n);
  let s;
  if (isEn()) s = a >= 1e6 ? (a / 1e6).toFixed(1) + 'M' : a >= 1000 ? (a / 1000).toFixed(1) + 'k' : a.toFixed(a < 100 ? 1 : 0);
  else s = a >= 10000 ? (a / 10000).toFixed(1) + '万' : a >= 1000 ? (a / 1000).toFixed(1) + 'k' : a.toFixed(a < 100 ? 1 : 0);
  return sym(cur) + s.replace(/\.0(?=[kM万]?$)/, '');
}
function toMain(amount, cur) {
  const main = settings.mainCurrency;
  if (cur === main) return amount;
  const from = +settings.rates[cur], to = +settings.rates[main];
  return from && to ? amount / from * to : amount;
}
// 1 单位 cur 值多少主货币
const perMain = cur => (+settings.rates[settings.mainCurrency]) / (+settings.rates[cur]);
const fmtRate = v => v >= 100 ? v.toFixed(2) : v >= 1 ? v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') : v.toPrecision(4);
function rateNote(rows) {
  const used = [...new Set(rows.map(r => r.currency))].filter(c => c !== settings.mainCurrency);
  if (!used.length) return '';
  const parts = used.map(c => `1 ${c} = ${fmtRate(perMain(c))} ${settings.mainCurrency}`);
  return L('（' + parts.join('，') + '）', ' (' + parts.join(', ') + ')');
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
const undoLabel = () => L('撤销', 'Undo');

/* ---------------- 状态 ---------------- */
const now = new Date();
const state = { view: 'trans', tab: 'daily', month: `${now.getFullYear()}-${pad(now.getMonth() + 1)}`, statsKind: 'expense', search: '', selDay: null, catFilter: null, catKind: 'expense' };

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
  const [y, m] = state.month.split('-').map(Number);
  const yearMode = state.view === 'trans' && state.tab === 'monthly';
  $('#monthLabel').textContent = state.search ? L('搜索结果', 'Search results') : yearMode ? L(`${y} 年`, `${y}`) : monthYear(y, m);
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
}

function matchesSearch(r, q) {
  const c = findCat(r.type, r.category);
  const hay = [r.store, r.item, r.category, c?.zh, c?.en, r.account, r.note, String(r.amount), r.date].join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(w => hay.includes(w));
}
const sortRecs = rows => rows.sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));
function monthRows() {
  if (state.search) return sortRecs(records.filter(r => matchesSearch(r, state.search)));
  return sortRecs(records.filter(r => ym(r.date) === state.month));
}

function totalsHtml(rows) {
  const s = sums(rows), c = settings.mainCurrency;
  return `<div><div class="l">${L('收入', 'Income')}</div><div class="v inc">${money(s.inc, c)}</div></div>
    <div><div class="l">${L('支出', 'Expenses')}</div><div class="v exp">${money(s.exp, c)}</div></div>
    <div><div class="l">${L('结余', 'Balance')}</div><div class="v">${money(s.bal, c, { sign: true })}</div></div>`;
}

function dayListHtml(rows) {
  if (!rows.length) return '';
  const byDay = new Map();
  for (const r of rows) (byDay.get(r.date) || byDay.set(r.date, []).get(r.date)).push(r);
  const c = settings.mainCurrency;
  let html = '';
  for (const [date, list] of byDay) {
    const d = new Date(date + 'T00:00:00'), s = sums(list), isToday = date === todayStr();
    const wd = isToday ? L('今天', 'Today') : L('周' + WD_ZH[d.getDay()], WD_EN[d.getDay()]);
    const sub = state.search ? (isEn() ? `${MON[d.getMonth()]} ${d.getFullYear()}` : date.slice(0, 7).replace('-', '.')) : monthName(d.getMonth() + 1);
    html += `<div class="day"><div class="day-head">
      <span class="d">${d.getDate()}</span><span class="wd ${isToday ? 'today' : ''}">${wd}</span>
      <span class="small" style="margin:0">${sub}</span>
      <span class="sums">${s.inc ? `<span class="inc">${money(s.inc, c)}</span>` : ''}${s.exp ? `<span class="exp">${money(s.exp, c)}</span>` : ''}</span>
    </div>`;
    for (const r of list) {
      const title = r.store || r.item || L('（未填写）', '(blank)');
      const subline = [r.store ? r.item : '', r.account].filter(Boolean).join(' · ');
      const conv = r.currency !== c ? `<small>≈ ${money(toMain(r.amount, r.currency), c)}</small>` : '';
      html += `<div class="rec" data-id="${esc(r.id)}">
        <div class="cat"><b>${catEmoji(r.type, r.category)}</b>${esc(catLabel(r.type, r.category))}</div>
        <div class="main"><div class="t1">${esc(title)}</div>${subline ? `<div class="t2">${esc(subline)}</div>` : ''}</div>
        <div class="amt ${r.type === 'income' ? 'inc' : 'exp'}">${money(r.amount, r.currency)}${conv}</div>
      </div>`;
    }
    html += '</div>';
  }
  return html;
}

const emptyHtml = () => L(
  `<div class="empty">这个月还没有记录。<br>在下面输入一句话，比如<br><b>Woolworth Westgate 买菜 41</b><br><b>昨天在麦当劳吃午饭 35 块 微信</b><br><b>收到培训费 3000 纽币</b></div>`,
  `<div class="empty">No records this month yet.<br>Type one line below, for example<br><b>Woolworth Westgate groceries 41</b><br><b>Lunch at Sushi Bar 18 cash</b><br><b>Tesco sandwich £4.50</b></div>`);

function renderTrans() {
  let rows = monthRows();
  if (state.catFilter) rows = rows.filter(r => r.category === state.catFilter);
  const body = $('#transBody');
  if (state.tab === 'monthly' && !state.search) {
    const y = state.month.slice(0, 4);
    const yearRows = records.filter(r => r.date.startsWith(y));
    $('#totals').innerHTML = totalsHtml(yearRows);
    const c = settings.mainCurrency;
    let html = `<div class="months"><div class="mrow head"><span class="m">${L('月份', 'Month')}</span><span>${L('收入', 'Income')}</span><span>${L('支出', 'Expenses')}</span><span>${L('结余', 'Balance')}</span></div>`;
    for (let m = 12; m >= 1; m--) {
      const key = `${y}-${pad(m)}`, rs = yearRows.filter(r => ym(r.date) === key);
      if (!rs.length && key > ym(todayStr())) continue;
      const s = sums(rs);
      html += `<div class="mrow ${key === ym(todayStr()) ? 'cur' : ''}" data-goto="${key}"><span class="m">${monthName(m)}</span>
        <span class="inc">${s.inc ? short(s.inc, c) : '–'}</span><span class="exp">${s.exp ? short(s.exp, c) : '–'}</span><span>${rs.length ? (s.bal < 0 ? '-' : '') + short(s.bal, c) : '–'}</span></div>`;
    }
    body.innerHTML = html + '</div>';
    return;
  }
  $('#totals').innerHTML = totalsHtml(rows);
  if (state.tab === 'calendar' && !state.search) {
    body.innerHTML = calendarHtml(rows) + (state.selDay ? dayListHtml(rows.filter(r => r.date === state.selDay)) || `<div class="empty">${L('这天没有记录', 'Nothing on this day')}</div>` : '');
    return;
  }
  const chip = state.catFilter ? `<div class="search-row" style="padding-top:8px"><span class="badge" style="font-size:calc(14px * var(--fs));padding:4px 10px">${catEmoji(state.statsKind, state.catFilter)} ${esc(catLabel(state.statsKind, state.catFilter))}</span><button class="link" id="clearCat">${L('显示全部', 'Show all')}</button></div>` : '';
  body.innerHTML = chip + (dayListHtml(rows) || (state.search ? `<div class="empty">${L('没有找到', 'Nothing found')}</div>` : emptyHtml()));
}

function calendarHtml(rows) {
  const [y, m] = state.month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7)); // 周一开始
  const c = settings.mainCurrency;
  const byDay = {};
  for (const r of rows) (byDay[r.date] ||= []).push(r);
  const heads = isEn() ? ['M', 'T', 'W', 'T', 'F', 'S', 'S'] : ['一', '二', '三', '四', '五', '六', '日'];
  let html = '<div class="cal"><div class="cal-grid">' + heads.map(w => `<div class="wh">${w}</div>`).join('');
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
  const label = kind === 'income' ? L('收入', 'income') : L('支出', 'expenses');

  let html = `<div class="panel"><h3>${L('本月' + label, 'This month’s ' + label)}</h3><div class="sub">${L('按分类，折算成' + curName(c), 'By category, in ' + curName(c))}${rateNote(rows)}</div>
    <div class="hero ${kind === 'income' ? 'inc' : 'exp'}">${money(total, c)}</div><div class="sub">${L(rows.length + ' 笔', rows.length + (rows.length === 1 ? ' record' : ' records'))}</div>`;
  html += cats.length ? cats.map(([id, v]) => `<div class="catrow" data-cat="${esc(id)}">
      <span>${catEmoji(kind, id)}</span><span class="cname">${esc(catLabel(kind, id))}</span>
      <span class="bar"><i style="width:${(v / max * 100).toFixed(1)}%"></i></span>
      <span class="val">${money(v, c)}<small>${(v / total * 100).toFixed(0)}%</small></span></div>`).join('')
    : `<div class="empty" style="padding:16px">${L('这个月没有' + label + '记录', 'No ' + label + ' this month')}</div>`;
  html += '</div>';

  // 近 6 个月趋势
  const [y, m] = state.month.split('-').map(Number);
  const months = [];
  for (let i = 5; i >= 0; i--) { const d = new Date(y, m - 1 - i, 1); months.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`); }
  const vals = months.map(k => records.filter(r => ym(r.date) === k && r.type === kind).reduce((s, r) => s + toMain(r.amount, r.currency), 0));
  const vmax = Math.max(...vals, 1);
  html += `<div class="panel"><h3>${L('近 6 个月' + label, 'Last 6 months')}</h3><div class="sub">${L('点柱子查看那个月', 'Tap a bar to see that month')}</div><div class="trend">` +
    months.map((k, i) => `<div class="col ${k === state.month ? 'cur' : ''}" data-goto-stats="${k}" data-tip="${monthName(+k.slice(5))} ${money(vals[i], c)}">
      ${k === state.month ? `<span class="lbl">${short(vals[i], c)}</span>` : ''}<i style="height:${(vals[i] / vmax * 100).toFixed(1)}%"></i></div>`).join('') +
    `</div><div class="trend-x">${months.map(k => `<span>${monthName(+k.slice(5))}</span>`).join('')}</div></div>`;
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
      if (inc) parts.push(`<span class="inc">${L('收', 'In')} ${money(inc, cur)}</span>`);
      if (exp) parts.push(`<span class="exp">${L('支', 'Out')} ${money(exp, cur)}</span>`);
    }
    return parts.join('') || '<span>–</span>';
  };
  const [y, m] = state.month.split('-').map(Number);
  let html = `<div class="panel"><h3>${L('按账户', 'By account')}</h3><div class="sub">${monthYear(y, m)} · ${L('原币种显示', 'in original currencies')}</div>`;
  for (const a of accs) {
    const rows = records.filter(r => r.account === a && ym(r.date) === state.month);
    const all = records.filter(r => r.account === a);
    const s = sums(rows);
    html += `<div class="acc"><span class="name">${esc(a)}</span><span class="num exp">${money(s.exp, c)}</span>
      <div class="line">${L('本月', 'This month')} ${line(rows)}</div><div class="line">${L('累计', 'All time')} ${line(all)}</div></div>`;
  }
  const none = records.filter(r => !r.account && ym(r.date) === state.month);
  if (none.length) html += `<div class="acc"><span class="name">${L('未指定', 'Unassigned')}</span><span class="num exp">${money(sums(none).exp, c)}</span><div class="line">${L('本月', 'This month')} ${line(none)}</div></div>`;
  $('#accountsBody').innerHTML = html + '</div>';
}

/* ---------------- 外观 ---------------- */
const FONT_SIZES = [[0.9, '小', 'S'], [1, '标准', 'M'], [1.12, '大', 'L'], [1.25, '特大', 'XL'], [1.4, '超大', 'XXL']];
const FONT_WEIGHTS = { normal: ['常规', 'Regular', 400, 600], medium: ['中等', 'Medium', 500, 700], bold: ['加粗', 'Bold', 600, 800] };
const SYS = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
const FONTS = {
  system:  { zh: '系统默认', en: 'System default', family: SYS },
  sans:    { zh: '思源黑体（清晰）', en: 'Noto Sans SC (clear)', family: `"Noto Sans SC", ${SYS}`, google: 'Noto+Sans+SC:wght@400;500;600;700;800' },
  serif:   { zh: '思源宋体（书卷）', en: 'Noto Serif SC (bookish)', family: `"Noto Serif SC", "Songti SC", serif`, google: 'Noto+Serif+SC:wght@400;500;600;700;800' },
  xiaowei: { zh: '站酷小薇（文艺）', en: 'ZCOOL XiaoWei (artsy)', family: `"ZCOOL XiaoWei", "Noto Serif SC", serif`, google: 'ZCOOL+XiaoWei' },
  kuaile:  { zh: '站酷快乐体（活泼）', en: 'ZCOOL KuaiLe (playful)', family: `"ZCOOL KuaiLe", ${SYS}`, google: 'ZCOOL+KuaiLe' },
  kai:     { zh: '楷体（手机自带时）', en: 'Kaiti (if on device)', family: `"Kaiti SC", "STKaiti", "KaiTi", "AR PL UKai CN", serif` },
};
// 英文字体放在字体列表最前面：英文字母用它，中文字符它没有，自动落到中文字体
const FONTS_EN = {
  same:      { zh: '跟中文字体一样', en: 'Same as Chinese font' },
  inter:     { zh: 'Inter（现代、清晰）', en: 'Inter (modern, clear)', family: '"Inter"', google: 'Inter:wght@400;500;600;700;800' },
  roboto:    { zh: 'Roboto（安卓风格）', en: 'Roboto (Android style)', family: '"Roboto"', google: 'Roboto:wght@400;500;700;900' },
  lato:      { zh: 'Lato（圆润友好）', en: 'Lato (friendly)', family: '"Lato"', google: 'Lato:wght@400;700;900' },
  nunito:    { zh: 'Nunito（圆体、可爱）', en: 'Nunito (rounded)', family: '"Nunito"', google: 'Nunito:wght@400;500;600;700;800' },
  merri:     { zh: 'Merriweather（衬线、易读）', en: 'Merriweather (serif)', family: '"Merriweather"', google: 'Merriweather:wght@400;700;900' },
  playfair:  { zh: 'Playfair Display（优雅）', en: 'Playfair Display (elegant)', family: '"Playfair Display"', google: 'Playfair+Display:wght@400;500;600;700;800' },
  mono:      { zh: 'JetBrains Mono（等宽，数字对齐）', en: 'JetBrains Mono (monospace)', family: '"JetBrains Mono"', google: 'JetBrains+Mono:wght@400;500;600;700;800' },
};
function loadGoogleFont(spec) {
  const id = 'gf-' + spec.split(':')[0];
  if (document.getElementById(id)) return;
  const l = document.createElement('link');
  l.id = id; l.rel = 'stylesheet';
  l.href = `https://fonts.googleapis.com/css2?family=${spec}&display=swap`;
  document.head.appendChild(l);
}
function applyAppearance() {
  const st = document.documentElement.style;
  const [, , fw, fwb] = FONT_WEIGHTS[settings.fontWeight] || FONT_WEIGHTS.medium;
  const zh = FONTS[settings.font] || FONTS.system;
  const en = FONTS_EN[settings.fontEn] || FONTS_EN.same;
  st.setProperty('--fs', settings.fontSize);
  document.documentElement.toggleAttribute('data-big', settings.fontSize >= 1.25); // 特大以上：列表只显示分类图标，给名字留空间
  st.setProperty('--fw', fw);
  st.setProperty('--fwb', fwb);
  st.setProperty('--font-family', en.family ? `${en.family}, ${zh.family}` : zh.family);
  if (zh.google) loadGoogleFont(zh.google);
  if (en.google) loadGoogleFont(en.google);
}
function applyTheme() {
  applyAppearance();
  if (settings.theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = settings.theme;
}

function renderSettings() {
  $$('#langChips input').forEach(i => i.checked = i.value === settings.lang);
  $('#setParser').value = settings.parser;
  $('#aiSettings').hidden = settings.parser !== 'ai';
  $('#setApiKey').value = settings.apiKey;
  $('#setModel').value = settings.model;
  $('#setConfirm').checked = settings.confirm;
  const opts = enabled().map(c => `<option value="${c}">${sym(c).trim()} ${curName(c)}</option>`).join('');
  $('#setMainCur').innerHTML = opts; $('#setMainCur').value = settings.mainCurrency;
  $('#setDefaultCur').innerHTML = opts; $('#setDefaultCur').value = settings.defaultCurrency;
  $('#curChips').innerHTML = CODES.map(c => `<label class="chip">
    <input type="checkbox" value="${c}" ${settings.currencies.includes(c) ? 'checked' : ''}>${curName(c)} <small>${sym(c).trim()}</small></label>`).join('');
  $('#rateList').innerHTML = enabled().filter(c => c !== settings.mainCurrency).map(c => `<label class="rate">
    <span>1 ${curName(c)} =</span><input type="number" step="any" min="0" inputmode="decimal" data-rate="${c}" value="${fmtRate(perMain(c))}"><span>${curName(settings.mainCurrency)}</span></label>`).join('')
    + `<p class="small">${settings.ratesUpdated ? L('汇率更新于 ', 'Rates updated ') + settings.ratesUpdated : L('现在是大概的默认汇率，建议点“在线更新”。', 'These are rough default rates — tap “Update online”.')}</p>`;
  $('#setAccounts').value = settings.accounts.join(', ');
  $('#setDefaultAcc').innerHTML = settings.accounts.map(a => `<option>${esc(a)}</option>`).join('');
  $('#setDefaultAcc').value = settings.defaultAccount;
  $('#setTheme').value = settings.theme;
  $('#fsChips').innerHTML = FONT_SIZES.map(([v, zh, en]) => `<label class="chip"><input type="radio" name="fs" value="${v}" ${+settings.fontSize === v ? 'checked' : ''}>${L(zh, en)}</label>`).join('');
  $('#fwChips').innerHTML = Object.entries(FONT_WEIGHTS).map(([k, [zh, en, w]]) => `<label class="chip" style="font-weight:${w}"><input type="radio" name="fw" value="${k}" ${settings.fontWeight === k ? 'checked' : ''}>${L(zh, en)}</label>`).join('');
  $('#setFont').innerHTML = Object.entries(FONTS).map(([k, f]) => `<option value="${k}">${L(f.zh, f.en)}</option>`).join('');
  $('#setFont').value = settings.font;
  $('#setFontEn').innerHTML = Object.entries(FONTS_EN).map(([k, f]) => `<option value="${k}">${L(f.zh, f.en)}</option>`).join('');
  $('#setFontEn').value = settings.fontEn;
  $('#dataInfo').textContent = L(
    `共 ${records.length} 条记录，已学会 ${Object.keys(memory).length} 个商家。数据只存在这台设备的浏览器里，请定期“备份 JSON”。`,
    `${records.length} records, ${Object.keys(memory).length} learned stores. Data lives only in this device’s browser — back up regularly.`);
}

/* ---------------- 编辑分类 ---------------- */
const catDialog = $('#catDialog');
function renderCatEditor() {
  const kind = state.catKind, list = catsOf(kind);
  $$('#catTabs button').forEach(b => b.classList.toggle('on', b.dataset.kind === kind));
  const count = id => records.filter(r => r.type === kind && r.category === id).length;
  $('#catList').innerHTML = list.map((c, i) => `<div class="catedit" data-i="${i}">
    <input class="emoji" data-f="emoji" value="${esc(c.emoji)}" maxlength="4" aria-label="${L('图标', 'Icon')}">
    <input data-f="zh" value="${esc(c.zh)}" placeholder="中文名">
    <input data-f="en" value="${esc(c.en)}" placeholder="English">
    <input class="kw" data-f="kw" value="${esc(c.kw)}" placeholder="${L('关键词，如 猫粮, pet', 'Keywords, e.g. pet, vet')}">
    <div class="cat-btns">
      <button type="button" data-act="up" ${i === 0 ? 'disabled' : ''} aria-label="${L('上移', 'Move up')}">↑</button>
      <button type="button" data-act="down" ${i === list.length - 1 ? 'disabled' : ''} aria-label="${L('下移', 'Move down')}">↓</button>
      <button type="button" data-act="del" class="del" aria-label="${L('删除', 'Delete')}">✕</button>
    </div>
    <span class="cnt">${L(`${count(c.id)} 条记录`, `${count(c.id)} records`)}${BUILTIN[c.id] ? L(' · 内置识别规则', ' · built-in rules') : ''}</span>
  </div>`).join('');
}
function openCatEditor(kind = 'expense') { state.catKind = kind; renderCatEditor(); catDialog.showModal(); }
$('#btnCats').onclick = () => openCatEditor('expense');
$('#btnCatsDone').onclick = () => catDialog.close();
catDialog.addEventListener('close', render);
catDialog.addEventListener('click', e => { if (e.target === catDialog) catDialog.close(); });
$('#catTabs').addEventListener('click', e => { const b = e.target.closest('[data-kind]'); if (b) { state.catKind = b.dataset.kind; renderCatEditor(); } });
$('#catList').addEventListener('change', e => {
  const row = e.target.closest('.catedit'), f = e.target.dataset.f;
  if (!row || !f) return;
  const c = catsOf(state.catKind)[+row.dataset.i];
  c[f] = e.target.value.trim();
  if (f === 'emoji' && !c.emoji) c.emoji = '🏷️';
  if ((f === 'zh' || f === 'en') && !c.zh && !c.en) { c[f] = c.id; e.target.value = c.id; }
  saveSettings();
});
$('#catList').addEventListener('click', e => {
  const b = e.target.closest('[data-act]'), row = e.target.closest('.catedit');
  if (!b || !row) return;
  const list = catsOf(state.catKind), i = +row.dataset.i, c = list[i];
  if (b.dataset.act === 'up' && i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
  if (b.dataset.act === 'down' && i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]];
  if (b.dataset.act === 'del') {
    if (list.length <= 1) { toast(L('至少要保留一个分类', 'Keep at least one category')); return; }
    const rest = list.filter(x => x !== c);
    const target = (rest.find(x => x.id === '其他' || x.id === '其他收入') || rest[rest.length - 1]);
    const n = records.filter(r => r.type === state.catKind && r.category === c.id).length;
    const name = L(c.zh || c.en, c.en || c.zh), tname = L(target.zh || target.en, target.en || target.zh);
    if (!confirm(n ? L(`删除“${name}”？它的 ${n} 条记录会移到“${tname}”。`, `Delete “${name}”? Its ${n} records will move to “${tname}”.`) : L(`删除“${name}”？`, `Delete “${name}”?`))) return;
    for (const r of records) if (r.type === state.catKind && r.category === c.id) r.category = target.id;
    for (const m of Object.values(memory)) if (m.category === c.id) m.category = target.id;
    list.splice(i, 1);
    saveRecords(); saveMemory();
  }
  saveSettings(); renderCatEditor();
});
$('#btnCatAdd').onclick = () => {
  const list = catsOf(state.catKind);
  const fb = list.findIndex(c => c.id === '其他' || c.id === '其他收入');
  const c = { id: 'c_' + Date.now().toString(36), zh: '', en: '', emoji: '🏷️', kw: '' };
  list.splice(fb >= 0 ? fb : list.length, 0, c); // 放在“其他”前面
  saveSettings(); renderCatEditor();
  const rows = $$('#catList .catedit');
  const row = rows[fb >= 0 ? fb : rows.length - 1];
  row?.scrollIntoView({ block: 'center' });
  row?.querySelector(isEn() ? '[data-f=en]' : '[data-f=zh]')?.focus();
};

/* ---------------- 识别并保存 ---------------- */
const parseOpts = () => ({
  defaultCurrency: settings.defaultCurrency, accounts: settings.accounts, defaultAccount: settings.defaultAccount, memory,
  categories: { expense: matcherList('expense'), income: matcherList('income') },
  fallback: { expense: fallbackCat('expense'), income: fallbackCat('income') },
});
const aiCats = type => catsOf(type).map(c => ({ id: c.id, label: [c.zh, c.en].filter(Boolean).join(' / '), kw: kwList(c.kw) }));

async function recognize(text) {
  if (settings.parser === 'ai' && settings.apiKey && navigator.onLine) {
    try {
      const { aiParse } = await import('./ai.js');
      const knownStores = Object.values(memory).slice(-60).map(v => `${v.name}→${v.category}`);
      const recs = await aiParse(text, {
        apiKey: settings.apiKey, model: settings.model, today: todayStr(),
        defaultCurrency: settings.defaultCurrency, currencies: enabled(), defaultAccount: settings.defaultAccount, accounts: settings.accounts,
        expenseCats: aiCats('expense'), incomeCats: aiCats('income'), knownStores,
      });
      if (recs.length) return recs;
      toast(L('AI 没找到金额，改用本地规则', 'AI found no amount — using built-in rules'));
    } catch (e) {
      console.warn(e);
      toast(L('AI 出错（', 'AI error (') + (e.status || e.message || e) + L('），改用本地规则', ') — using built-in rules'));
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
    if (!recs.length) { toast(L('没看懂这句话，试试“商家 物品 金额”', 'Didn’t get that — try “store item amount”')); return; }
    $('#composeInput').value = ''; autosize();
    const ready = recs.every(r => r.amount > 0);
    if (!settings.confirm && ready) {
      const added = recs.map(addRecord);
      saveRecords(); render();
      toast(added.length > 1 ? L(`已记 ${added.length} 笔`, `Saved ${added.length} records`) : L('已记 ', 'Saved ') + `${added[0].store || added[0].item} ${money(added[0].amount, added[0].currency)}`, {
        label: undoLabel(), fn: () => { const ids = new Set(added.map(a => a.id)); records = records.filter(r => !ids.has(r.id)); saveRecords(); render(); },
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
  const type = r.type || 'expense';
  const rec = {
    id: uid(), createdAt: Date.now(), type, date: r.date || todayStr(),
    store: (r.store || '').trim(), item: (r.item || '').trim(), amount: r2(+r.amount), currency: r.currency,
    category: findCat(type, r.category) ? r.category : guess(type, r.store, r.item), account: r.account || '', note: r.note || '',
  };
  records.push(rec); learn(rec);
  if (rec.date.slice(0, 7) !== state.month && !state.search) state.month = rec.date.slice(0, 7);
  return rec;
}

/* ---------------- 商家推荐 ---------------- */
// 每个商家一个分数：用过的次数，越近的越重要（约 3 个月减半）；
// 和这张卡片同分类、同账户、物品相似的记录额外加分。输入了文字时按文字过滤。
const words = s => String(s || '').toLowerCase().split(/[\s,，、.。·\/]+/).filter(w => w.length >= 2);
const similar = (a, b) => { const A = words(a), B = words(b); return A.some(x => B.some(y => x.includes(y) || y.includes(x))); };
function suggestStores({ q = '', type = 'expense', category = '', account = '', item = '' } = {}) {
  const stats = new Map(), nowT = Date.now();
  const boostCat = category && category !== fallbackCat(type);
  for (const r of records) {
    if (!r.store) continue;
    const k = memoryKey(r.store);
    let s = stats.get(k);
    if (!s) stats.set(k, s = { name: r.store, score: 0, count: 0, last: '', cats: {} });
    const age = Math.max(0, (nowT - new Date(r.date + 'T12:00:00')) / 864e5);
    let w = Math.pow(0.5, age / 90);
    if (r.type !== type) w *= 0.3;
    if (boostCat && r.category === category) w *= 3;
    if (account && r.account === account) w *= 1.3;
    if (item && r.item && similar(item, r.item)) w *= 2.5;
    s.score += w; s.count++;
    if (r.date >= s.last) { s.last = r.date; s.name = r.store; }
    s.cats[r.category] = (s.cats[r.category] || 0) + 1;
  }
  for (const [k, m] of Object.entries(memory)) if (!stats.has(k)) stats.set(k, { name: m.name, score: 0.01, count: 0, last: '', cats: { [m.category]: 1 } });
  let list = [...stats.values()];
  const nq = memoryKey(q);
  if (nq) {
    list = list.filter(s => memoryKey(s.name).includes(nq));
    list.sort((a, b) => (memoryKey(b.name).startsWith(nq) - memoryKey(a.name).startsWith(nq)) || b.score - a.score);
  } else list.sort((a, b) => b.score - a.score);
  return list.slice(0, 8).map(s => ({ ...s, cat: Object.entries(s.cats).sort((a, b) => b[1] - a[1])[0]?.[0] }));
}
function fmtShortDate(d) { if (!d) return ''; const [, m, day] = d.split('-').map(Number); return isEn() ? `${day} ${MON[m - 1]}` : `${m}/${day}`; }
function openSuggest(card, filter) {
  const box = card.querySelector('.suggest'), inp = card.querySelector('[name=store]');
  const f = n => card.querySelector(`[name=${n}]`)?.value || '';
  const list = suggestStores({ q: filter ? inp.value : '', type: card.dataset.type, category: f('category'), account: f('account'), item: f('item') });
  if (!list.length) {
    if (filter) { box.hidden = true; return; }
    box.innerHTML = `<div class="sg-empty">${L('还没有记过商家。记几笔之后，这里会推荐你常去的地方。', 'No stores yet — after a few records, your usual places show up here.')}</div>`;
  } else {
    const cur = memoryKey(inp.value);
    box.innerHTML = `<div class="sg-head">${filter ? L('匹配的商家', 'Matching stores') : L('推荐商家（常去、最近、同类）', 'Suggested (frequent, recent, similar)')}</div>` +
      list.map(s => `<button type="button" class="sg ${memoryKey(s.name) === cur ? 'on' : ''}" data-name="${esc(s.name)}">
        <span class="sg-e">${catEmoji(card.dataset.type, s.cat)}</span>
        <span class="sg-n">${esc(s.name)}</span>
        <span class="sg-m">${esc(catLabel(card.dataset.type, s.cat))}${s.count ? ' · ' + L(`${s.count} 次`, `${s.count}×`) : ''}${s.last ? ' · ' + fmtShortDate(s.last) : ''}</span>
      </button>`).join('');
  }
  box.hidden = false;
  requestAnimationFrame(() => box.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
}
const closeSuggest = () => $$('.suggest').forEach(b => b.hidden = true);
document.addEventListener('pointerdown', e => { if (!e.target.closest('.combo')) closeSuggest(); });

/* ---------------- 确认 / 编辑面板 ---------------- */
let sheetEditId = null;
const sheet = $('#sheet');

function curPicker(cur) {
  const list = [...new Set([...enabled(), cur])];
  if (list.length <= 3) return `<div class="seg cur">${list.map(c => `<button type="button" data-v="${c}" class="${c === cur ? 'on' : ''}">${sym(c).trim()}</button>`).join('')}</div>`;
  return `<select class="cur-select" aria-label="${L('币种', 'Currency')}">${list.map(c => `<option value="${c}" ${c === cur ? 'selected' : ''}>${sym(c).trim()} ${curName(c)}</option>`).join('')}</select>`;
}
const catOptions = (type, sel) => {
  const list = catsOf(type).slice();
  if (sel && !list.some(c => c.id === sel)) list.push({ id: sel, zh: sel, en: sel, emoji: '🏷️' });
  return list.map(c => `<option value="${esc(c.id)}" ${c.id === sel ? 'selected' : ''}>${c.emoji} ${esc(L(c.zh || c.en, c.en || c.zh))}</option>`).join('')
    + `<option value="__edit">✏️ ${L('编辑分类…', 'Edit categories…')}</option>`;
};
function cardHtml(r, i, multi) {
  const type = r.type || 'expense';
  const accs = [...new Set([...settings.accounts, r.account].filter(Boolean))];
  return `<div class="ecard" data-i="${i}" data-type="${type}" data-cur="${r.currency || settings.defaultCurrency}">
    ${multi ? `<button type="button" class="x" aria-label="${L('去掉这条', 'Remove')}">×</button>` : ''}
    ${r.note && !sheetEditId ? `<div class="src">“${esc(r.note)}”${r.ai ? '<span class="badge">AI</span>' : r.learned ? `<span class="badge">${L('已学会的商家', 'Learned store')}</span>` : ''}</div>` : ''}
    <div class="g">
      <div class="full amount-row">
        <div class="seg type"><button type="button" data-v="expense" class="${type === 'expense' ? 'on' : ''}">${L('支出', 'Out')}</button><button type="button" data-v="income" class="${type === 'income' ? 'on' : ''}">${L('收入', 'In')}</button></div>
        <input name="amount" type="number" inputmode="decimal" step="0.01" min="0" placeholder="${L('金额', 'Amount')}" value="${r.amount ?? ''}" required>
        ${curPicker(r.currency || settings.defaultCurrency)}
      </div>
      <label>${L('商家', 'Store')}<span class="combo"><input name="store" value="${esc(r.store)}" placeholder="${L('输入或点 ▾ 选', 'Type or tap ▾')}" autocomplete="off"><button type="button" class="combo-btn" aria-label="${L('推荐商家', 'Suggested stores')}">▾</button><span class="suggest" hidden></span></span></label>
      <label>${L('物品 / 说明', 'Item / note')}<input name="item" value="${esc(r.item)}" placeholder="${L('买菜', 'groceries')}"></label>
      <label>${L('分类', 'Category')}<select name="category">${catOptions(type, r.category)}</select></label>
      <label>${L('账户', 'Account')}<select name="account"><option value="">${L('（不指定）', '(none)')}</option>${accs.map(a => `<option ${a === r.account ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select></label>
      <label class="full">${L('日期', 'Date')}<input name="date" type="date" value="${r.date || todayStr()}" required></label>
    </div></div>`;
}

let sheetRecs = [];
function saveLabel(n) { return sheetEditId ? L('保存修改', 'Save changes') : n > 1 ? L(`全部保存（${n}）`, `Save all (${n})`) : L('保存', 'Save'); }
function openSheet(recs, editId = null) {
  sheetEditId = editId;
  sheetRecs = recs;
  $('#sheetTitle').textContent = editId ? L('修改记录', 'Edit record') : recs.length > 1 ? L(`识别出 ${recs.length} 笔`, `Found ${recs.length} records`) : L('确认记录', 'Confirm record');
  $('#btnSave').textContent = saveLabel(recs.length);
  $('#btnDelete').hidden = !editId;
  $('#sheetCards').innerHTML = recs.map((r, i) => cardHtml(r, i, recs.length > 1)).join('');
  sheet.showModal();
  const empty = sheet.querySelector('input[name=amount]:invalid');
  if (empty) setTimeout(() => empty.focus(), 250);
}

$('#sheetCards').addEventListener('click', e => {
  const card = e.target.closest('.ecard');
  if (!card) return;
  if (e.target.closest('.combo-btn')) {
    const box = card.querySelector('.suggest');
    if (box.hidden) { closeSuggest(); openSuggest(card, false); } else box.hidden = true;
    return;
  }
  const sg = e.target.closest('.sg');
  if (sg) {
    const inp = card.querySelector('[name=store]');
    inp.value = sg.dataset.name;
    inp.dispatchEvent(new Event('change', { bubbles: true })); // 带出学过的分类/账户
    closeSuggest();
    return;
  }
  if (e.target.classList.contains('x')) {
    card.remove();
    const n = $$('#sheetCards .ecard').length;
    if (!n) sheet.close(); else $('#btnSave').textContent = saveLabel(n);
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
    sel.innerHTML = catOptions(b.dataset.v, guess(b.dataset.v, f('store'), f('item')));
  }
});
$('#sheetCards').addEventListener('change', e => {
  const card = e.target.closest('.ecard');
  if (e.target.classList.contains('cur-select')) { card.dataset.cur = e.target.value; return; }
  // 在分类下拉里选“编辑分类…”：打开分类编辑，关掉后刷新这张卡片的选项
  if (e.target.name === 'category' && e.target.value === '__edit') {
    const sel = e.target, prev = sel.dataset.prev || guess(card.dataset.type, '', '');
    sel.value = prev;
    openCatEditor(card.dataset.type);
    catDialog.addEventListener('close', () => { sel.innerHTML = catOptions(card.dataset.type, findCat(card.dataset.type, prev) ? prev : fallbackCat(card.dataset.type)); }, { once: true });
    return;
  }
  if (e.target.name === 'category') { e.target.dataset.prev = e.target.value; return; }
  // 改商家时，若这个商家学过，自动带出分类/账户
  if (e.target.name !== 'store') return;
  const m = memory[memoryKey(e.target.value)];
  if (m && (m.type || 'expense') === card.dataset.type) {
    card.querySelector('[name=category]').value = m.category;
    if (m.account) card.querySelector('[name=account]').value = m.account;
  }
});
// 打字时显示匹配的商家
$('#sheetCards').addEventListener('input', e => {
  if (e.target.name !== 'store') return;
  const card = e.target.closest('.ecard');
  if (e.target.value.trim()) openSuggest(card, true); else card.querySelector('.suggest').hidden = true;
});
$('#sheetCards').addEventListener('keydown', e => { if (e.key === 'Escape' && e.target.name === 'store') { e.preventDefault(); closeSuggest(); } });
$('#sheetCards').addEventListener('focusin', e => { if (e.target.name === 'category') e.target.dataset.prev = e.target.value; });

$('#sheetForm').addEventListener('submit', e => {
  if (e.submitter?.value !== 'save') return;
  e.preventDefault();
  const cards = $$('#sheetCards .ecard');
  const out = [];
  for (const card of cards) {
    const f = n => card.querySelector(`[name=${n}]`).value;
    const amount = parseFloat(f('amount'));
    if (!(amount > 0)) { card.querySelector('[name=amount]').focus(); toast(L('请填写金额', 'Please enter an amount')); return; }
    out.push({ type: card.dataset.type, amount, currency: card.dataset.cur, store: f('store'), item: f('item'),
      category: f('category'), account: f('account'), date: f('date'), note: sheetRecs[+card.dataset.i]?.note || '' });
  }
  if (sheetEditId) {
    const rec = records.find(r => r.id === sheetEditId);
    Object.assign(rec, out[0], { amount: r2(out[0].amount), store: out[0].store.trim(), item: out[0].item.trim() });
    learn(rec);
    toast(L('已更新', 'Updated'));
  } else {
    const added = out.map(addRecord);
    toast(added.length > 1 ? L(`已记 ${added.length} 笔`, `Saved ${added.length} records`) : L('已记 ', 'Saved ') + money(added[0].amount, added[0].currency));
  }
  saveRecords(); sheet.close(); render();
});
$('#btnDelete').onclick = () => {
  const rec = records.find(r => r.id === sheetEditId);
  if (!rec) return;
  records = records.filter(r => r.id !== sheetEditId);
  saveRecords(); sheet.close(); render();
  toast(L('已删除', 'Deleted'), { label: undoLabel(), fn: () => { records.push(rec); saveRecords(); render(); } });
};
sheet.addEventListener('click', e => { if (e.target === sheet) sheet.close(); });
sheet.addEventListener('close', closeSuggest);

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

/* ---------------- 设置 ---------------- */
const bindSetting = (sel, key, fn = v => v, after) => $(sel).addEventListener('change', e => {
  settings[key] = fn(e.target.type === 'checkbox' ? e.target.checked : e.target.value);
  saveSettings(); after?.(); render();
});
$('#langChips').addEventListener('change', e => { settings.lang = e.target.value; saveSettings(); applyStaticText(); render(); });
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
bindSetting('#setFont', 'font', v => v, applyAppearance);
bindSetting('#setFontEn', 'fontEn', v => v, applyAppearance);
$('#fsChips').addEventListener('change', e => { settings.fontSize = +e.target.value; saveSettings(); applyAppearance(); render(); });
$('#fwChips').addEventListener('change', e => { settings.fontWeight = e.target.value; saveSettings(); applyAppearance(); render(); });

$('#btnRate').onclick = async () => {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/NZD');
    const data = await res.json();
    if (!data?.rates?.CNY) throw new Error(L('没有数据', 'no data'));
    for (const c of CODES) if (data.rates[c]) settings.rates[c] = data.rates[c];
    settings.ratesUpdated = todayStr(); saveSettings(); render();
    toast(L('汇率已更新', 'Rates updated'));
  } catch (e) { toast(L('更新汇率失败：', 'Could not update rates: ') + e.message); }
};

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$('#btnCsv').onclick = () => {
  const head = isEn()
    ? ['Date', 'Type', 'Category', 'Store', 'Item', 'Amount', 'Currency', `In ${settings.mainCurrency}`, 'Account', 'Original text']
    : ['日期', '收支', '分类', '商家', '物品', '金额', '币种', `折算${settings.mainCurrency}`, '账户', '原话'];
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [...records].sort((a, b) => a.date.localeCompare(b.date)).map(r =>
    [r.date, r.type === 'income' ? L('收入', 'Income') : L('支出', 'Expense'), catLabel(r.type, r.category), r.store, r.item, r.amount, r.currency, r2(toMain(r.amount, r.currency)), r.account, r.note].map(q).join(','));
  download(`${L('记账', 'ledger')}-${todayStr()}.csv`, '﻿' + [head.join(','), ...lines].join('\r\n'), 'text/csv;charset=utf-8');
};
$('#btnBackup').onclick = () => download(`${L('记账备份', 'ledger-backup')}-${todayStr()}.json`, JSON.stringify({ version: 3, records, memory, settings: { ...settings, apiKey: '' } }, null, 2), 'application/json');
$('#fileRestore').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const incoming = Array.isArray(data) ? data : data.records;
    if (!Array.isArray(incoming)) throw new Error(L('格式不对', 'wrong format'));
    const ids = new Set(records.map(r => r.id));
    const added = incoming.filter(r => r && r.id && !ids.has(r.id) && r.amount > 0).map(r => ({ type: 'expense', account: '', ...r }));
    records.push(...added);
    if (data.memory) { memory = { ...data.memory, ...memory }; saveMemory(); }
    // 备份里的自定义分类：本机没有的补上
    for (const type of ['expense', 'income']) for (const c of data.settings?.cats?.[type] || [])
      if (!catsOf(type).some(x => x.id === c.id)) catsOf(type).push(c);
    adoptUnknownCats();
    saveRecords(); saveSettings(); render(); toast(L(`已恢复 ${added.length} 条记录`, `Restored ${added.length} records`));
  } catch (err) { toast(L('恢复失败：', 'Restore failed: ') + err.message); }
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
    adoptUnknownCats();
    saveRecords(); saveSettings(); render();
    const dup = rows.length - fresh.length;
    toast(L(`导入 ${fresh.length} 条${dup ? `，跳过重复 ${dup} 条` : ''}${skipped ? `，忽略转账等 ${skipped} 条` : ''}`,
      `Imported ${fresh.length}${dup ? `, skipped ${dup} duplicates` : ''}${skipped ? `, ignored ${skipped} transfers etc.` : ''}`));
  } catch (err) { console.error(err); toast(L('导入失败：', 'Import failed: ') + err.message); }
  e.target.value = '';
};
$('#btnForget').onclick = () => { if (confirm(L('清除所有已学会的商家？（记录不会删除）', 'Forget all learned stores? (Records are kept.)'))) { memory = {}; saveMemory(); render(); } };
$('#btnClear').onclick = () => {
  if (records.length && confirm(L(`确定清空全部 ${records.length} 条记录？建议先备份。`, `Delete all ${records.length} records? Back up first!`))) { records = []; saveRecords(); render(); toast(L('已清空', 'All deleted')); }
};

/* ---------------- 启动 ---------------- */
// 旧版本数据：把已有商家学进来
if (!Object.keys(memory).length) records.forEach(r => r.store && learn(r));
applyTheme();
applyStaticText();
render();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
