// 货币表：代码、符号、中文名、可识别的说法、小数位、默认汇率（1 纽币 = ? 该货币，在线更新后会被替换）
export const CURRENCIES = {
  CNY: { sym: '¥',   name: '人民币', en: 'Chinese yuan',   dec: 2, rate: 4.1,   words: ['人民币', 'RMB', 'CNY', '块钱', '块', '元', '毛', '角'], prefix: ['¥', '￥', 'CN¥'] },
  NZD: { sym: 'NZ$', name: '纽币', en: 'NZ dollar',     dec: 2, rate: 1,     words: ['新西兰元', '新西兰币', '纽西兰元', '纽币', '纽元', '纽刀', 'NZD'], prefix: ['NZ$'] },
  USD: { sym: 'US$', name: '美元', en: 'US dollar',     dec: 2, rate: 0.58,  words: ['美元', '美金', '美刀', 'USD', 'US dollars?'], prefix: ['US$', 'U$'] },
  GBP: { sym: '£',   name: '英镑', en: 'British pound',     dec: 2, rate: 0.45,  words: ['英镑', '镑', 'GBP', 'pounds?', 'quid'], prefix: ['£'] },
  EUR: { sym: '€',   name: '欧元', en: 'Euro',     dec: 2, rate: 0.51,  words: ['欧元', 'EUR', 'euros?'], prefix: ['€'] },
  AUD: { sym: 'A$',  name: '澳元', en: 'Australian dollar',     dec: 2, rate: 0.89,  words: ['澳元', '澳币', '澳大利亚元', 'AUD'], prefix: ['A$', 'AU$'] },
  JPY: { sym: 'JP¥', name: '日元', en: 'Japanese yen',     dec: 0, rate: 88,    words: ['日元', '日币', '円', 'JPY', 'yen'], prefix: ['JP¥'] },
  HKD: { sym: 'HK$', name: '港币', en: 'HK dollar',     dec: 2, rate: 4.5,   words: ['港币', '港元', '港纸', 'HKD'], prefix: ['HK$'] },
  CAD: { sym: 'C$',  name: '加元', en: 'Canadian dollar',     dec: 2, rate: 0.8,   words: ['加元', '加币', '加拿大元', 'CAD'], prefix: ['C$', 'CA$'] },
  SGD: { sym: 'S$',  name: '新加坡元', en: 'Singapore dollar', dec: 2, rate: 0.76,  words: ['新加坡元', '新加坡币', '新币', 'SGD'], prefix: ['S$'] },
  TWD: { sym: 'NT$', name: '新台币', en: 'Taiwan dollar',   dec: 0, rate: 18.5,  words: ['新台币', '台币', 'TWD', 'NTD'], prefix: ['NT$'] },
  KRW: { sym: '₩',   name: '韩元', en: 'Korean won',     dec: 0, rate: 820,   words: ['韩元', '韩币', 'KRW', 'won'], prefix: ['₩'] },
  THB: { sym: '฿',   name: '泰铢', en: 'Thai baht',     dec: 2, rate: 20,    words: ['泰铢', 'THB', 'baht'], prefix: ['฿'] },
  MYR: { sym: 'RM',  name: '马币', en: 'Malaysian ringgit',     dec: 2, rate: 2.6,   words: ['马币', '令吉', '林吉特', 'MYR', 'ringgit'], prefix: ['RM'] },
  CHF: { sym: 'CHF', name: '瑞士法郎', en: 'Swiss franc', dec: 2, rate: 0.47,  words: ['瑞士法郎', '法郎', 'CHF', 'francs?'], prefix: [] },
};
export const CODES = Object.keys(CURRENCIES);

const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isPattern = w => /[?]/.test(w); // 'pounds?' 这类写法保留为正则

// 所有说法（长的在前，避免 "元" 抢先匹配 "美元"），再加上通用的 "刀/dollar/$"
const WORD_LIST = CODES.flatMap(c => CURRENCIES[c].words.map(w => ({ w, c })));
WORD_LIST.push({ w: '刀', c: '$' }, { w: 'dollars?', c: '$' }, { w: 'bucks?', c: '$' });
WORD_LIST.sort((a, b) => b.w.length - a.w.length);
const PREFIX_LIST = CODES.flatMap(c => CURRENCIES[c].prefix.map(p => ({ p, c }))).concat([{ p: '$', c: '$' }])
  .sort((a, b) => b.p.length - a.p.length);

const asSrc = w => isPattern(w) ? w : reEsc(w);
export const CURRENCY_TAIL_SRC = `(?:${WORD_LIST.map(x => /^[a-z]/i.test(x.w) ? `${asSrc(x.w)}\\b` : asSrc(x.w)).join('|')})`;
const prefSrc = p => /^[a-z]+$/i.test(p) ? `\\b${reEsc(p)}` : reEsc(p); // 纯字母前缀（RM）要求在词首
export const CURRENCY_PREFIX_SRC = `(?:${PREFIX_LIST.map(x => prefSrc(x.p)).join('|')})`;
const ANY_RE = new RegExp(`${CURRENCY_PREFIX_SRC}|${WORD_LIST.map(x => /^[a-z]/i.test(x.w) ? `\\b${asSrc(x.w)}\\b` : asSrc(x.w)).join('|')}`, 'i');

// 把一个说法/符号换成货币代码。"$"、"刀"、"dollar" 等没说哪国的，用 dollarDefault
export function codeOf(word, dollarDefault = 'NZD') {
  if (!word) return null;
  const w = word.trim();
  for (const { p, c } of PREFIX_LIST) if (w.toLowerCase() === p.toLowerCase()) return c === '$' ? dollarDefault : c;
  for (const { w: x, c } of WORD_LIST) {
    if (new RegExp(`^${asSrc(x)}$`, 'i').test(w)) return c === '$' ? dollarDefault : c;
  }
  return null;
}
// 在整句话里找第一个出现的货币说法
export function findCurrencyIn(text, dollarDefault) {
  const m = text.match(ANY_RE);
  return m ? codeOf(m[0], dollarDefault) : null;
}
// "$" 这类没说国家的，默认当成哪种元：若默认货币本身是某种元就用它，否则用纽币
export const dollarFor = def => ['NZD', 'USD', 'AUD', 'CAD', 'HKD', 'SGD', 'TWD'].includes(def) ? def : 'NZD';

export const sym = c => CURRENCIES[c]?.sym ?? c + ' ';
export const dec = c => CURRENCIES[c]?.dec ?? 2;
export const cname = (c, en = false) => (en ? CURRENCIES[c]?.en : CURRENCIES[c]?.name) ?? c;
export const defaultRates = () => Object.fromEntries(CODES.map(c => [c, CURRENCIES[c].rate]));
