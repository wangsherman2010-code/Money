// 语音/文字记账解析器：从一句中文（可夹英文）里提取 商店、物品、金额、币种、分类、日期
// 纯本地规则，不需要联网或 API Key。

const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNIT = { 十: 10, 百: 100, 千: 1000, 万: 10000 };

// 中文数字 → 数值，支持 "三十五" "一百二"(=120) "两千零五" "十二点五"
export function cnToNumber(s) {
  if (!s) return NaN;
  let [intPart, decPart] = s.split('点');
  let total = 0, section = 0, num = 0, lastUnit = 0;
  for (const ch of intPart) {
    if (ch in CN_DIGIT) { num = CN_DIGIT[ch]; if (num === 0) lastUnit = 0; }
    else if (ch in CN_UNIT) {
      const u = CN_UNIT[ch];
      if (u === 10000) { section = (section + num) * u; total += section; section = 0; }
      else { section += (num || (u === 10 ? 1 : 0)) * u; }
      num = 0; lastUnit = u;
    } else return NaN;
  }
  // 口语省略："一百二" = 120，"三千五" = 3500
  if (num && lastUnit >= 100) num *= lastUnit / 10;
  total += section + num;
  if (decPart) {
    let d = '';
    for (const ch of decPart) { if (!(ch in CN_DIGIT)) return NaN; d += CN_DIGIT[ch]; }
    total = parseFloat(total + '.' + d);
  }
  return total;
}

const NZD_WORDS = ['新西兰元', '新西兰币', '纽西兰元', '纽币', '纽元', '纽刀', 'NZD', 'nzd', 'NZ$', '刀', '澳纽币'];
const CNY_WORDS = ['人民币', 'RMB', 'rmb', 'CNY', 'cny', '¥', '￥', '块钱', '块', '元', '毛', '角'];
const NZD_RE = /新西兰元|新西兰币|纽西兰元|纽币|纽元|纽刀|NZD|NZ\$|刀/i;
const CNY_RE = /人民币|RMB|CNY|[¥￥]|块钱|块|元|毛|角/i;

const CURRENCY_TAIL = '(?:新西兰元|新西兰币|纽西兰元|纽币|纽元|纽刀|NZD|NZ\\$|刀|人民币|RMB|CNY|块钱|块|元|dollars?|bucks?)';
const CN_NUM = '[零〇一二两三四五六七八九十百千万点]+';
const SMALL = '(?:([零一二两三四五六七八九\\d])(?:毛|角)?)?(?:([一二两三四五六七八九\\d])分)?';

const SPEND_BEFORE = /(花了?|用了?|一共|总共|共计|共|付了?|刷了?|消费了?|是|要|价格|总价|合计|价值)\s*$/;

export const EXPENSE_CATS = [
  { name: '买菜', emoji: '🛒', re: /超市|买菜|蔬菜|水果|肉|鸡蛋|牛奶|面包|大米|食材|菜市场|海鲜|grocer|groceries|supermarket|countdown|woolworth|new ?world|pak ?n ?save|fresh ?choice|four ?square|farmers? market|veg|fruit|milk|bread/i },
  { name: '餐饮', emoji: '🍜', re: /饭|餐|吃|喝|咖啡|奶茶|外卖|早餐|午餐|晚餐|夜宵|火锅|烧烤|面馆|餐厅|麦当劳|肯德基|汉堡|披萨|寿司|茶|酒吧|啤酒|food|lunch|dinner|breakfast|brunch|coffee|cafe|restaurant|takeaway|kfc|mcdonald|subway|burger|pizza|sushi|bubble tea|drink|beer|bar\b|food ?court|uber ?eats|doordash/i },
  { name: '交通', emoji: '🚗', re: /打车|出租|滴滴|地铁|公交|巴士|火车|机票|航班|加油|汽油|油费|停车|过路费|车票|修车|保养|uber(?! ?eats)|taxi|bus\b|train|ferry|flight|petrol|gas|fuel|parking|z ?energy|\bbp\b|mobil|gull|caltex|wof|rego|at ?hop|toll/i },
  { name: '住房', emoji: '🏠', re: /房租|租金|水费|电费|燃气|网费|宽带|物业|贷款|房贷|rent|mortgage|power|electricity|water rates|internet|broadband|mercury|genesis|contact energy|rates/i },
  { name: '通讯', emoji: '📱', re: /话费|手机费|流量|充值|spark|one ?nz|2degrees|skinny|phone bill|mobile plan/i },
  { name: '医疗', emoji: '💊', re: /医院|看病|药|诊所|牙医|体检|医生|chemist|pharmacy|\bgp\b|doctor|dentist|hospital|medicine|physio/i },
  { name: '娱乐', emoji: '🎬', re: /电影|游戏|ktv|门票|演唱会|景点|会员|音乐|movie|cinema|film|game|concert|ticket|netflix|spotify|disney|youtube premium|event cinemas|hoyts/i },
  { name: '旅行', emoji: '✈️', re: /旅游|旅行|酒店|民宿|住宿|hotel|motel|airbnb|booking\.com|travel|holiday/i },
  { name: '学习', emoji: '📚', re: /书|课程|培训|学费|教材|文具|toastmasters|book|course|tuition|udemy|kindle|whitcoulls|paper ?plus|stationery/i },
  { name: '爱好', emoji: '🎸', re: /吉他|琴弦|乐器|摄影|镜头|相机|davinci|达芬奇|guitar|strings|camera|lens|tripod|gym|健身|运动|sport|fitness/i },
  { name: '日用', emoji: '🧴', re: /日用|纸巾|洗发|牙膏|洗衣|清洁|家居|宜家|household|warehouse|kmart|mitre ?10|bunnings|briscoes|ikea|farmers|cleaning|tissue|shampoo/i },
  { name: '服饰', emoji: '👔', re: /衣服|裤子|鞋|帽子|外套|裙|袜|包包|服装|t恤|衬衫|内衣|apparel|cloth|shirt|jacket|coat|shoe|sneaker|jeans|pants|dress|socks|uniqlo|zara|h&m|tommy|hilfiger|skechers|nike|adidas|under ?armou?r|cotton on|glassons|kathmandu/i },
  { name: '数码', emoji: '💻', re: /手机|电脑|耳机|充电|数据线|硬盘|内存卡|sd卡|苹果|三星|大疆|laptop|computer|iphone|ipad|headphone|charger|cable|ssd|hard drive|sd card|noel ?leeming|jb ?hi-?fi|pb ?tech|apple|samsung|dji/i },
  { name: '美容', emoji: '💇', re: /理发|剪头|美容|美甲|化妆|护肤|haircut|barber|salon|beauty|cosmetic|skincare|mecca|sephora/i },
  { name: '人情', emoji: '🎁', re: /红包|礼物|礼金|请客|送礼|份子|捐|gift|present|donation|treat/i },
  { name: '其他', emoji: '🏷️', re: /$^/ },
];
export const INCOME_CATS = [
  { name: '工资', emoji: '💰', re: /工资|薪水|月薪|salary|wage|payroll/i },
  { name: '培训收入', emoji: '🎤', re: /培训|讲课|课酬|授课|教练|coaching|training|workshop|讲座|咨询费|consult/i },
  { name: '奖金', emoji: '🏆', re: /奖金|年终|bonus/i },
  { name: '投资', emoji: '📈', re: /利息|分红|股息|理财|投资|interest|dividend|investment/i },
  { name: '退款', emoji: '↩️', re: /退款|退货|返现|报销|refund|cashback|reimburse/i },
  { name: '红包', emoji: '🧧', re: /红包|礼金|gift/i },
  { name: '其他收入', emoji: '💵', re: /$^/ },
];
const INCOME_RE = /收入|进账|工资|薪水|奖金|收到|入账|到账|退款|报销|利息|分红|讲课费|课酬|赚了|salary|income|refund|received|got paid|bonus|dividend|interest|cashback|reimburs/i;

export const CATEGORY_LIST = EXPENSE_CATS.map(c => c.name);

export function guessCategory(type, ...texts) {
  const t = texts.filter(Boolean).join(' ');
  const list = type === 'income' ? INCOME_CATS : EXPENSE_CATS;
  for (const c of list) if (c.re.test(t)) return c.name;
  return list[list.length - 1].name;
}

// 账户识别：返回用户账户列表里匹配的那个
const ACCOUNT_HINTS = [
  [/信用卡|credit ?card|visa|master ?card|amex/i, ['信用卡', '卡', 'card']],
  [/刷卡|用卡|银行卡|借记卡|eftpos|debit|(?<!sd\s?|gift\s?|memory\s?|sim\s?)\bcard\b|^卡\s|\s卡$/i, ['卡', '银行卡', 'card', '信用卡']],
  [/现金|cash/i, ['现金', 'cash']],
  [/微信|wechat/i, ['微信', 'wechat']],
  [/支付宝|alipay/i, ['支付宝', 'alipay']],
  [/paypal/i, ['paypal']],
  [/apple ?pay/i, ['apple pay', '卡', 'card']],
];
export function detectAccount(text, accounts) {
  for (const a of accounts) if (a && text.toLowerCase().includes(a.toLowerCase()) && a.length >= 2) return { account: a, word: a };
  for (const [re, names] of ACCOUNT_HINTS) {
    const m = text.match(re);
    if (!m) continue;
    for (const n of names) {
      const hit = accounts.find(a => a.toLowerCase() === n.toLowerCase() || a.toLowerCase().includes(n.toLowerCase()));
      if (hit) return { account: hit, word: m[0] };
    }
  }
  return null;
}

function fmtDate(d) {
  const z = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

function parseDate(text, now) {
  const d = new Date(now);
  let m;
  if (/大前天/.test(text)) d.setDate(d.getDate() - 3);
  else if (/前天/.test(text)) d.setDate(d.getDate() - 2);
  else if (/昨天|昨晚|昨日/.test(text)) d.setDate(d.getDate() - 1);
  else if ((m = text.match(/(\d{1,2}|[一二三四五六七八九十]{1,3})月(\d{1,2}|[一二三四五六七八九十]{1,3})[日号]/))) {
    const mo = /\d/.test(m[1]) ? +m[1] : cnToNumber(m[1]);
    const da = /\d/.test(m[2]) ? +m[2] : cnToNumber(m[2]);
    const cand = new Date(d.getFullYear(), mo - 1, da);
    if (cand > d) cand.setFullYear(cand.getFullYear() - 1);
    return fmtDate(cand);
  } else if ((m = text.match(/(\d{1,2}|[一二三四五六七八九十]{1,3})[号日]/))) {
    const da = /\d/.test(m[1]) ? +m[1] : cnToNumber(m[1]);
    const cand = new Date(d.getFullYear(), d.getMonth(), da);
    if (cand > d) cand.setMonth(cand.getMonth() - 1);
    return fmtDate(cand);
  }
  return fmtDate(d);
}

function digitVal(s) { return /\d/.test(s) ? +s : CN_DIGIT[s]; }

// 找出所有金额候选并打分，返回最佳候选
function findAmount(text) {
  const re = new RegExp(
    `(?:NZ\\$|\\$|[¥￥])?\\s*(\\d+(?:\\.\\d+)?|${CN_NUM})\\s*(${CURRENCY_TAIL})?${SMALL}`, 'gi');
  const cands = [];
  let m;
  while ((m = re.exec(text))) {
    if (!m[0].trim()) { re.lastIndex++; continue; }
    const raw = m[1];
    const isArabic = /\d/.test(raw);
    let value = isArabic ? parseFloat(raw) : cnToNumber(raw);
    if (!isFinite(value) || value <= 0) continue;
    const prefix = m[0].trimStart().match(/^(NZ\$|\$|[¥￥])/i)?.[1];
    const tail = m[2];
    if (tail && (m[3] || m[4])) {
      // "十二块五" / "12块5毛" / "3块2毛5分"
      if (m[3]) value += digitVal(m[3]) / 10;
      if (m[4]) value += digitVal(m[4]) / 100;
    }
    const before = text.slice(0, m.index);
    const after = text.slice(m.index + m[0].length);
    let score = 0;
    if (tail || prefix) score += 3;
    if (SPEND_BEFORE.test(before)) score += 2;
    if (/^\s*(号|日|月|点钟|点半|个|件|斤|公斤|瓶|杯|份|盒|包|袋|只|条|双|张|次|天|年|岁|人|位|楼|号线|路|%)/.test(after) && !tail) score -= 5;
    if (!isArabic && score <= 0) continue; // 中文数字必须有货币词或"花了"等提示，避免把"一件"当金额
    let currency = null;
    const cur = (tail || prefix || '');
    if (/^\$$/.test(cur) || /dollar|buck/i.test(cur)) currency = 'NZD';
    else if (NZD_RE.test(cur)) currency = 'NZD';
    else if (CNY_RE.test(cur)) currency = 'CNY';
    cands.push({ value: Math.round(value * 100) / 100, currency, score, start: m.index, end: m.index + m[0].length });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.score - a.score || b.start - a.start);
  return cands[0];
}

const DATE_WORDS = /(大前天|前天|昨天|昨晚|昨日|今天|今早|今晚|今日|刚才|刚刚|上午|下午|中午|晚上|早上|\btoday\b|\byesterday\b)/gi;
const VERB = '(?:买了|买|购买了|购买|吃了|吃|喝了|喝|点了|加了|加油|打车|交了|交|充了|充值|付了|看了|订了|消费了|消费|花了|花)';
const CN = /[一-鿿]/;
const norm = s => (s || '').toLowerCase().replace(/[\s'’`.\-_]/g, '');

// 已学会的商家：memory = { 规范化名: { name, category, account, currency, type } }
function matchMemory(text, memory) {
  const t = norm(text);
  let best = null;
  for (const [k, v] of Object.entries(memory)) {
    if (k.length >= 2 && t.includes(k) && (!best || k.length > best.key.length)) best = { key: k, ...v };
  }
  return best;
}

// 在原文里找到与 memory 规范化名对应的原始片段（保留大小写和空格）
function locate(text, key) {
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    let j = i, acc = '';
    while (j < chars.length && acc.length < key.length) { acc += norm(chars[j]); j++; }
    if (acc === key && norm(chars[i])) return { start: i, end: j, raw: chars.slice(i, j).join('') };
  }
  return null;
}

// 英文/无动词句子：把“物品关键词”及其后的词当物品，前面的当商家
const ITEM_WORDS = /^(groceries|grocery|food|lunch|dinner|breakfast|brunch|coffee|coffees|drinks?|snacks?|petrol|fuel|gas|parking|shirts?|jacket|coat|shoes?|sneakers|jeans|pants|dress|socks|movie|ticket|tickets|book|books|haircut|gift|medicine|rent|power|internet|phone|taxi|uber|bus|train|clothes|top|hoodie|cap|bag|lens|camera|strings|guitar|sd|card|cable|charger|meat|veg|vegetables|fruit|milk|bread|eggs|beer|wine|pizza|burger|sushi|noodles|ramen|tea|cake)$/i;

function splitStoreItem(rest) {
  // "lunch at Albany mall" / "coffee @ Starbucks"
  let m = rest.match(/^(.+?)\s+(?:at|@|from|in)\s+(.+)$/i) || rest.match(/^(.+?)\s*@\s*(.+)$/);
  if (m) return { item: m[1], store: m[2] };
  const words = rest.split(/\s+/).filter(Boolean);
  // 中英混排："Sherman 衬衫 加德" —— 中文部分当物品
  if (CN.test(rest) && /[a-z]/i.test(rest)) {
    const latin = words.filter(w => !CN.test(w)), cn = words.filter(w => CN.test(w));
    if (latin.length && cn.length) return { store: latin.join(' '), item: cn.join(' ') };
  }
  const idx = words.findIndex((w, i) => i > 0 && ITEM_WORDS.test(w.replace(/[^a-z]/gi, '')));
  if (idx > 0) return { store: words.slice(0, idx).join(' '), item: words.slice(idx).join(' ') };
  if (words.length && ITEM_WORDS.test(words[0]) && words.length > 1) return { item: words[0], store: words.slice(1).join(' ') };
  return { store: rest, item: '' };
}

export function parseExpense(input, opts = {}) {
  const { defaultCurrency = 'NZD', now = new Date(), accounts = [], defaultAccount = '', memory = {} } = opts;
  const original = (input || '').trim();
  let text = original.replace(/一共/g, '共').replace(/一些|一下|一点儿?/g, '');
  const date = parseDate(text, now);
  text = text
    .replace(/(\d{1,2}|[一二三四五六七八九十]{1,3})月(\d{1,2}|[一二三四五六七八九十]{1,3})[日号]/g, '')
    .replace(/(^|[^\d.])(\d{1,2}|[一二三四五六七八九十]{1,3})[号日](?![元块])/g, '$1')
    .replace(DATE_WORDS, '')
    .replace(/^[我们]+/, '')
    .replace(/我/g, '');

  const type = INCOME_RE.test(text) ? 'income' : 'expense';

  // 账户（刷卡/现金/微信…），识别后从文本里去掉
  const acc = detectAccount(text, accounts);
  if (acc) text = text.replace(new RegExp(`(用|刷|by|with|paid by|pay by|via)?\\s*${acc.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(支付|付款|付的|付)?`, 'i'), ' ');

  const amt = findAmount(text);
  let currency = amt?.currency;
  if (!currency) {
    if (NZD_RE.test(text)) currency = 'NZD';
    else if (/人民币|RMB|CNY|块|元/i.test(text)) currency = 'CNY';
  }

  let rest = amt ? text.slice(0, amt.start) + ' ' + text.slice(amt.end) : text;
  rest = rest
    .replace(/(花了?|用了?|总共|共计|共|付了?|刷了?|合计|价值|是)\s*$/, '')
    .replace(/\b(spent|paid|cost|for|total|nzd|rmb|cny|dollars?|bucks?)\b/gi, ' ')
    .replace(/收到|收入|进账|入账|到账|received|got paid/gi, ' ');

  let store = '', item = '';
  const learned = matchMemory(rest, memory);

  const storeM = rest.match(new RegExp(`(?:在|去|到|从)\\s*([^，,。！!？?]{1,30}?)\\s*(?=${VERB}|里|那里|那儿|网上)`));
  const vm = rest.match(new RegExp(`(?:在|去|到|从)?[^，,。]*?(买了|买|购买了|购买|吃了|吃|喝了|喝|点了|加了|交了|交|充了|付了|看了|订了|消费了|消费)`));

  if (storeM) store = storeM[1];
  else if (learned) {
    const loc = locate(rest, learned.key);
    store = learned.name;
    if (loc) rest = rest.slice(0, loc.start) + ' ' + rest.slice(loc.end);
  } else {
    const lead = rest.match(new RegExp(`^\\s*([^，,。\\d]{1,20}?)\\s*(?=${VERB})`));
    if (lead && lead[1].trim() && !/请|给|帮|和|跟/.test(lead[1])) store = lead[1];
  }

  if (vm && !learned) {
    item = rest.slice(vm.index + vm[0].length);
    if (!item.replace(/[\s，,。]/g, '') && /加油|打车/.test(rest)) item = rest.match(/加油|打车/)[0];
  } else if (learned) {
    const vm2 = rest.match(new RegExp(`(买了|买|购买了|购买|吃了|吃|喝了|喝|点了|加了|交了|充了|付了|看了|订了|消费了)`));
    item = vm2 ? rest.slice(vm2.index + vm2[0].length) : rest;
  } else if (/加油|打车/.test(rest)) {
    item = rest.match(/加油|打车/)[0];
  } else if (storeM) {
    item = rest.replace(storeM[0], '');
  } else {
    // 没有中文动词：英文或简写，比如 "Woolworth Westgate groceries 41"
    const r = rest.replace(/[，,。]+/g, ' ').replace(/\s+/g, ' ').trim();
    const sp = splitStoreItem(r);
    store = sp.store; item = sp.item;
    // 纯中文短语（"房租" "工资"）当物品而不是商家
    if (!item && CN.test(store) && !/[a-z]/i.test(store) && !/(超市|商店|店|餐厅|饭店|酒楼|商场|市场|药房|药店|面馆|诊所|医院|影院|mall)$/i.test(store)) { item = store; store = ''; }
  }

  const clean = s => (s || '')
    .replace(/^[\s，,。、:：的了在去到]+/, '')
    .replace(/[\s，,。、!！?？:：]+$/, '')
    .replace(/(花了?|用了?|总共|共计|共|付了?|刷了?|合计|的钱|的|了|是|一共)+$/, '')
    .replace(/(花了?|用了?|总共|共计|共|付了?)\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  store = clean(store).replace(/(那里|那儿|里)$/, '');
  item = clean(item);
  if (item.length === 1 && vm) item = vm[1].replace('了', '') + item;
  if (!item && !store) item = clean(rest);

  const category = learned?.category && (learned.type || 'expense') === type
    ? learned.category : guessCategory(type, store, item, original);

  return {
    type,
    date,
    store,
    item,
    amount: amt ? amt.value : null,
    currency: currency || learned?.currency || (/微信|支付宝|wechat|alipay/i.test(acc?.account || '') ? 'CNY' : defaultCurrency),
    category,
    account: acc?.account || learned?.account || defaultAccount,
    note: original,
    learned: !!learned,
  };
}

// 一次输入多条：按换行、分号、"另外/还有" 拆开
export function parseMany(input, opts) {
  return (input || '')
    .split(/\n|；|;|另外|还有|then|\band also\b/i)
    .map(s => s.trim())
    .filter(s => s.length > 1)
    .map(s => parseExpense(s, opts));
}

export function memoryKey(store) { return norm(store); }
