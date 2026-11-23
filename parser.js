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

const CATEGORIES = [
  ['买菜', /超市|买菜|蔬菜|水果|肉|鸡蛋|牛奶|面包|大米|食材|countdown|new ?world|pak ?n ?save|woolworths|fresh ?choice|four ?square|亚洲超市|菜市场|海鲜/i],
  ['餐饮', /饭|餐|吃|喝|咖啡|奶茶|外卖|早餐|午餐|晚餐|夜宵|火锅|烧烤|面馆|餐厅|restaurant|cafe|麦当劳|肯德基|kfc|mcdonald|subway|汉堡|披萨|pizza|寿司|茶|酒吧|啤酒/i],
  ['交通', /打车|出租|uber|滴滴|地铁|公交|巴士|bus|火车|机票|航班|加油|汽油|油费|停车|过路费|z ?energy|bp|mobil|gull|caltex|车票|wof|rego|修车|保养/i],
  ['住房', /房租|租金|水费|电费|燃气|网费|宽带|物业|rent|电力|mercury|genesis|contact energy/i],
  ['通讯', /话费|手机费|流量|spark|one ?nz|2degrees|skinny|充值/i],
  ['医疗', /医院|看病|药|诊所|牙医|体检|chemist|pharmacy|gp|医生/i],
  ['娱乐', /电影|游戏|ktv|门票|演唱会|旅游|酒店|景点|netflix|spotify|会员|健身|gym|音乐|吉他|琴弦/i],
  ['学习', /书|课程|培训|学费|教材|文具|kindle|udemy/i],
  ['日用', /日用|纸巾|洗发|牙膏|洗衣|清洁|warehouse|kmart|mitre ?10|bunnings|briscoes|宜家|ikea|家居/i],
  ['服饰', /衣服|裤子|鞋|帽子|外套|裙|袜|包包|服装|t恤|衬衫|uniqlo|优衣库|zara|h&m/i],
  ['数码', /手机|电脑|相机|镜头|耳机|充电|数据线|硬盘|内存卡|sd卡|noel ?leeming|jb ?hi-?fi|pb ?tech|apple|苹果|三星|大疆|dji/i],
  ['人情', /红包|礼物|礼金|请客|送礼|份子/i],
];

export const CATEGORY_LIST = [...CATEGORIES.map(c => c[0]), '其他'];

export function guessCategory(...texts) {
  const t = texts.filter(Boolean).join(' ');
  for (const [name, re] of CATEGORIES) if (re.test(t)) return name;
  return '其他';
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

const DATE_WORDS = /(大前天|前天|昨天|昨晚|昨日|今天|今早|今晚|今日|刚才|刚刚|上午|下午|中午|晚上|早上)/g;
const VERB = '(?:买了|买|购买了|购买|吃了|吃|喝了|喝|点了|加了|加油|打车|交了|交|充了|充值|付了|看了|订了|消费了|消费|花了|花)';

export function parseExpense(input, { defaultCurrency = 'CNY', now = new Date() } = {}) {
  const original = (input || '').trim();
  let text = original.replace(/一共/g, '共').replace(/一些|一下|一点儿?/g, '');
  const date = parseDate(text, now);
  text = text
    .replace(/(\d{1,2}|[一二三四五六七八九十]{1,3})月(\d{1,2}|[一二三四五六七八九十]{1,3})[日号]/g, '')
    .replace(/(^|[^\d.])(\d{1,2}|[一二三四五六七八九十]{1,3})[号日](?![元块])/g, '$1')
    .replace(DATE_WORDS, '')
    .replace(/^[我们]+/, '')
    .replace(/[我]/g, '');

  const amt = findAmount(text);
  let currency = amt?.currency;
  if (!currency) {
    if (NZD_RE.test(text)) currency = 'NZD';
    else if (/人民币|RMB|CNY|块|元/i.test(text)) currency = 'CNY';
    else currency = defaultCurrency;
  }

  // 去掉金额片段后剩下的文字，用于找商店和物品
  let rest = amt ? text.slice(0, amt.start) + ' ' + text.slice(amt.end) : text;
  rest = rest.replace(new RegExp(`(花了?|用了?|总共|共计|共|付了?|刷了?|合计|价值|是)\\s*$`), '');

  let store = '';
  let item = '';
  const verbRe = new RegExp(VERB);
  const storeM = rest.match(new RegExp(`(?:在|去|到|从)\\s*([^，,。！!？?]{1,30}?)\\s*(?=${VERB}|里|那里|那儿|网上)`));
  if (storeM) store = storeM[1];
  else {
    // "Countdown 买了牛奶" —— 句首到动词前的短语
    const lead = rest.match(new RegExp(`^\\s*([^，,。\\d]{1,20}?)\\s*(?=${VERB})`));
    if (lead && lead[1].trim() && !/请|给|帮|和|跟/.test(lead[1])) store = lead[1];
  }

  const vm = rest.match(new RegExp(`(?:在|去|到|从)?[^，,。]*?(买了|买|购买了|购买|吃了|吃|喝了|喝|点了|加了|交了|交|充了|付了|看了|订了|消费了|消费)`));
  if (vm) {
    const after = rest.slice(vm.index + vm[0].length);
    item = after;
    // 动词本身就是内容（加油、打车）
    if (!item.replace(/[\s，,。]/g, '') && /加油|打车/.test(rest)) item = rest.match(/加油|打车/)[0];
  } else if (/加油|打车/.test(rest)) {
    item = rest.match(/加油|打车/)[0];
  } else {
    item = store ? rest.replace(storeM ? storeM[0] : store, '') : rest;
  }

  const clean = s => (s || '')
    .replace(/^[\s，,。、:：的了在去到]+/, '')
    .replace(/[\s，,。、!！?？]+$/, '')
    .replace(/(花了?|用了?|总共|共计|共|付了?|刷了?|合计|的钱|的|了|是|一共)+$/, '')
    .replace(/(花了?|用了?|总共|共计|共|付了?)\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  store = clean(store).replace(/(那里|那儿|里)$/, '');
  item = clean(item);
  if (item.length === 1 && vm) item = vm[1].replace('了', '') + item; // "买菜"
  if (!item && !store) item = clean(rest);

  return {
    date,
    store,
    item,
    amount: amt ? amt.value : null,
    currency,
    category: guessCategory(store, item, original),
    note: original,
  };
}
