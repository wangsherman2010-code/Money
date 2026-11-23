// 导入其他记账 App 导出的 Excel / CSV（例如 Money Manager 的 “导出到 Excel”）。
// 自动识别表头：日期、账户、分类、备注/商家、描述、金额、币种、收支。
const XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm';

const CAT_MAP = {
  food: '餐饮', 'eating out': '餐饮', restaurant: '餐饮', groceries: '买菜', grocery: '买菜',
  apparel: '服饰', clothing: '服饰', clothes: '服饰', culture: '娱乐', entertainment: '娱乐',
  transportation: '交通', transport: '交通', car: '交通', household: '日用', health: '医疗', medical: '医疗',
  education: '学习', gift: '人情', gifts: '人情', beauty: '美容', 'social life': '人情', travel: '旅行',
  housing: '住房', rent: '住房', utilities: '住房', phone: '通讯', telecom: '通讯', hobby: '爱好', sports: '爱好',
  electronics: '数码', other: '其他', others: '其他',
  salary: '工资', allowance: '其他收入', bonus: '奖金', 'petty cash': '其他收入', interest: '投资', investment: '投资',
  refund: '退款', 'other income': '其他收入',
};

const CUR = s => {
  const t = String(s || '').trim().toUpperCase();
  if (/^(CNY|RMB|¥|￥|CN¥|人民币)$/.test(t)) return 'CNY';
  if (/^(NZD|NZ\$|\$|纽币)$/.test(t)) return 'NZD';
  return null;
};

function pick(headers, ...tests) {
  for (const t of tests) {
    const i = headers.findIndex(h => t.test(h));
    if (i >= 0) return i;
  }
  return -1;
}

function toDate(v) {
  if (v instanceof Date && !isNaN(v)) return v;
  if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400000) + new Date().getTimezoneOffset() * 60000);
  const s = String(v || '').trim();
  let m = s.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (m) return new Date(+m[1], m[2] - 1, +m[3]);
  m = s.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) {
    let [a, b, y] = [+m[1], +m[2], +m[3]];
    if (y < 100) y += 2000;
    // 新西兰习惯 日/月/年；若第二个数 > 12 则一定是 月/日/年
    const [d, mo] = b > 12 ? [b, a] : [a, b];
    return new Date(y, mo - 1, d);
  }
  const t = Date.parse(s);
  return isNaN(t) ? null : new Date(t);
}
const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const num = v => typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[^\d.\-]/g, ''));

export async function importSpreadsheet(file) {
  const XLSX = await import(XLSX_URL);
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellDates: true, codepage: 65001 });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
  // 找表头行（前 10 行里含“日期/date/period”的那行）
  const hi = grid.slice(0, 10).findIndex(row => row.some(c => /^(date|period|日期|时间|time)/i.test(String(c).trim())));
  if (hi < 0) throw new Error('找不到“日期”这一列');
  const headers = grid[hi].map(h => String(h).trim().toLowerCase());

  const iDate = pick(headers, /^(date|period|日期)/, /time|时间/);
  const iAcc = pick(headers, /^accounts?$/, /account|账户/);
  const iCat = pick(headers, /^category$/, /category|分类|类别/);
  const iSub = pick(headers, /subcategory|子分类/);
  const iNote = pick(headers, /^note$/, /note|备注|商家|merchant|payee/);
  const iDesc = pick(headers, /^description$/, /desc|描述|说明|memo/);
  const iType = pick(headers, /income\/expense|in\/out|type|收支|类型/);
  const iAmt = pick(headers, /^amount$/, /^金额$/);
  const iCur = pick(headers, /^currency$/, /currency|币种|货币/);
  const iMain = headers.findIndex(h => CUR(h)); // 例如表头叫 "NZD" 或 "CNY" 的金额列
  if (iDate < 0 || (iAmt < 0 && iMain < 0)) throw new Error('找不到日期或金额列');

  const rows = []; let skipped = 0;
  for (const row of grid.slice(hi + 1)) {
    if (!row || row.every(c => c === '' || c == null)) continue;
    const d = toDate(row[iDate]);
    const typeRaw = iType >= 0 ? String(row[iType]).toLowerCase() : '';
    if (/transfer|转账/.test(typeRaw)) { skipped++; continue; }
    let amount, currency;
    const cur = iCur >= 0 ? CUR(row[iCur]) : null;
    if (iAmt >= 0 && cur) { amount = num(row[iAmt]); currency = cur; }
    else if (iMain >= 0) { amount = num(row[iMain]); currency = CUR(headers[iMain]); }
    else { amount = num(row[iAmt]); currency = cur || 'NZD'; }
    if (!d || !isFinite(amount) || amount === 0) { skipped++; continue; }
    let type = /inc|收入/.test(typeRaw) ? 'income' : 'expense';
    if (!typeRaw && amount > 0 && iType < 0) type = 'expense';
    if (!typeRaw && amount < 0) type = 'expense';
    amount = Math.abs(Math.round(amount * 100) / 100);
    const rawCat = String(row[iCat] ?? '').replace(/^[^\p{L}]+/u, '').trim(); // 去掉表情前缀
    const category = CAT_MAP[rawCat.toLowerCase()] || rawCat || (type === 'income' ? '其他收入' : '其他');
    const sub = iSub >= 0 ? String(row[iSub] || '').trim() : '';
    const store = iNote >= 0 ? String(row[iNote] || '').trim() : '';
    const desc = iDesc >= 0 ? String(row[iDesc] || '').trim() : '';
    rows.push({
      type, date: fmt(d), store, item: [sub, desc].filter(Boolean).join(' · '), amount, currency, category,
      account: iAcc >= 0 ? String(row[iAcc] || '').trim() : '', note: '导入',
    });
  }
  return { rows, skipped };
}
