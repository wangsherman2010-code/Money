// 可选：用 AI 理解一句（或几句）记账文字。支持 Claude（Anthropic）和 DeepSeek，需要用户自己的 API Key。
// Key 只存在本机浏览器里，请求直接从手机发到对应的服务商，不经过任何其他服务器。
import { CURRENCIES, CODES } from './currencies.js';

const fmtCat = c => `${c.id} = ${c.label}${c.kw?.length ? '：' + c.kw.join('、') : ''}`;

function buildSystem(ctx) {
  const { today, defaultCurrency, currencies = ['NZD', 'CNY'], defaultAccount, accounts, expenseCats, incomeCats, knownStores } = ctx;
  return `你是一个记账助手。用户在新西兰和中国两地生活，会用中文、英文或中英混合写一句或几句话记账。
把每一笔钱拆成一条记录。规则：
- 今天是 ${today}。"昨天""上周五""11月20号"等换算成具体日期；没提日期就用今天。
- 币种用 ISO 代码。用户常用：${currencies.map(c => `${c}（${CURRENCIES[c].name}）`).join('、')}。其他也可以：${CODES.filter(c => !currencies.includes(c)).join('、')}。
  纽币/纽元/刀 → NZD；人民币/块/元/¥ → CNY；英镑/£ → GBP；美元/美金/美刀 → USD；欧元/€ → EUR；日元/円 → JPY；港币 → HKD；澳元 → AUD。
  只写 "$" 或 "dollar" 时，按地点判断（美国→USD，澳洲→AUD 等），看不出来就用 NZD。
  完全没说币种时：用微信或支付宝付的用 CNY；提到了外国城市/国家就用当地货币；否则用 ${defaultCurrency}。
- 收入（工资、收到培训费、退款、利息等）type=income，用收入分类；其余为 expense，用支出分类。
- category 填分类的 id。支出分类（id = 名称：关键词）：${expenseCats.map(fmtCat).join('；')}。
  收入分类：${incomeCats.map(fmtCat).join('；')}。
- 账户只能是：${accounts.join('、')}。没提到就用「${defaultAccount}」。
- store 是商家或地点（保留原文大小写，比如 "Woolworth Westgate"）；item 是买的东西，简短，保持用户原来的语言。人名（比如给谁买的）放进 item，不要当商家。
- 一句里有几笔不同的钱就输出几条；"一共/总共"只算一条。
- 金额必须是用户说出的数字，中文数字要换算（"三十五块五"=35.5，"一千二"=1200）。没有金额的部分不要输出。
${knownStores.length ? `- 用户以前记过的商家和分类（优先沿用）：${knownStores.join('；')}` : ''}`;
}

// 无论哪家 AI，结果都过一遍：字段不对的改成默认值，没金额的丢掉
function clean(records, ctx, text) {
  const catIds = new Set([...ctx.expenseCats, ...ctx.incomeCats].map(c => c.id));
  return (Array.isArray(records) ? records : []).map(r => {
    const amount = Math.abs(parseFloat(r?.amount));
    return {
      type: r?.type === 'income' ? 'income' : 'expense',
      date: /^\d{4}-\d{2}-\d{2}$/.test(r?.date) ? r.date : ctx.today,
      store: String(r?.store ?? '').trim(),
      item: String(r?.item ?? '').trim(),
      amount,
      currency: CODES.includes(String(r?.currency).toUpperCase()) ? String(r.currency).toUpperCase() : ctx.defaultCurrency,
      category: catIds.has(r?.category) ? r.category : '',
      account: ctx.accounts.includes(r?.account) ? r.account : ctx.defaultAccount,
      note: text, ai: true,
    };
  }).filter(r => r.amount > 0);
}

/* ---------------- Claude（Anthropic 官方 SDK） ---------------- */
const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.6.0/+esm';
let clientPromise = null, clientKey = null;
async function getClient(apiKey) {
  if (!clientPromise || clientKey !== apiKey) {
    clientKey = apiKey;
    clientPromise = import(SDK_URL).then(({ default: Anthropic }) =>
      new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 1, timeout: 60_000 }));
  }
  return clientPromise;
}

async function claudeParse(text, ctx) {
  const client = await getClient(ctx.apiKey);
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['records'],
    properties: {
      records: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'date', 'store', 'item', 'amount', 'currency', 'category', 'account'],
          properties: {
            type: { type: 'string', enum: ['expense', 'income'] },
            date: { type: 'string', description: 'YYYY-MM-DD' },
            store: { type: 'string', description: '商家/地点/付款方，没有就空字符串' },
            item: { type: 'string', description: '买了什么/什么收入，简短，没有就空字符串' },
            amount: { type: 'number' },
            currency: { type: 'string', enum: CODES },
            category: { type: 'string', enum: [...new Set([...ctx.expenseCats, ...ctx.incomeCats].map(c => c.id))] },
            account: { type: 'string', enum: ctx.accounts.length ? ctx.accounts : [''] },
          },
        },
      },
    },
  };
  const res = await client.beta.messages.create({
    model: ctx.model,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    system: buildSystem(ctx),
    messages: [{ role: 'user', content: text }],
  });
  if (res.stop_reason === 'refusal') throw new Error('AI 拒绝了这个请求');
  const block = res.content.find(b => b.type === 'text');
  if (!block) throw new Error('AI 没有返回内容');
  return clean(JSON.parse(block.text).records, ctx, text);
}

/* ---------------- DeepSeek（OpenAI 兼容接口，直接用 fetch） ---------------- */
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

async function deepseekParse(text, ctx) {
  // DeepSeek 的 JSON 模式要求提示里写明 JSON 格式并给例子
  const system = buildSystem(ctx) + `

只输出 JSON，不要任何别的文字。格式：
{"records":[{"type":"expense","date":"${ctx.today}","store":"Woolworth Westgate","item":"牛奶","amount":12.5,"currency":"NZD","category":"${ctx.expenseCats[0]?.id ?? ''}","account":"${ctx.defaultAccount}"}]}
type 只能是 "expense" 或 "income"；amount 是数字；没有就输出 {"records":[]}。`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  let res;
  try {
    res = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.apiKey}` },
      body: JSON.stringify({
        model: ctx.model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: text }],
        response_format: { type: 'json_object' },
        max_tokens: 2000,
        temperature: 0.1,
        stream: false,
      }),
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'DeepSeek 超时' : 'DeepSeek 连接失败（' + e.message + '）');
  } finally { clearTimeout(timer); }
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json())?.error?.message || ''; } catch { /* 非 JSON 错误 */ }
    const hint = { 401: 'API Key 不对', 402: '账户余额不足', 429: '请求太频繁', 503: '服务繁忙' }[res.status];
    const err = new Error(`DeepSeek ${res.status}${hint ? ' ' + hint : ''}${msg ? '：' + msg : ''}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('DeepSeek 没有返回内容');
  // 万一包了 ```json 代码块，取出里面的 JSON
  const json = content.match(/\{[\s\S]*\}/)?.[0] ?? content;
  const parsed = JSON.parse(json);
  return clean(parsed.records ?? (Array.isArray(parsed) ? parsed : [parsed]), ctx, text);
}

export async function aiParse(text, ctx) {
  return ctx.provider === 'deepseek' ? deepseekParse(text, ctx) : claudeParse(text, ctx);
}
