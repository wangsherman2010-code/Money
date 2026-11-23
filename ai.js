// 可选：用 Claude 理解一句（或几句）记账文字。需要用户自己的 Anthropic API Key。
// Key 只存在本机浏览器里，请求直接从手机发到 Anthropic，不经过任何其他服务器。
import { CURRENCIES, CODES } from './currencies.js';
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

export async function aiParse(text, ctx) {
  const { apiKey, model, today, defaultCurrency, currencies = ['NZD', 'CNY'], defaultAccount, accounts, expenseCats, incomeCats, knownStores } = ctx;
  const client = await getClient(apiKey);

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
            category: { type: 'string', enum: [...new Set([...expenseCats, ...incomeCats])] },
            account: { type: 'string', enum: accounts.length ? accounts : [''] },
          },
        },
      },
    },
  };

  const system = `你是一个记账助手。用户在新西兰和中国两地生活，会用中文、英文或中英混合写一句或几句话记账。
把每一笔钱拆成一条记录。规则：
- 今天是 ${today}。"昨天""上周五""11月20号"等换算成具体日期；没提日期就用今天。
- 币种用 ISO 代码。用户常用：${currencies.map(c => `${c}（${CURRENCIES[c].name}）`).join('、')}。其他也可以：${CODES.filter(c => !currencies.includes(c)).join('、')}。
  纽币/纽元/刀 → NZD；人民币/块/元/¥ → CNY；英镑/£ → GBP；美元/美金/美刀 → USD；欧元/€ → EUR；日元/円 → JPY；港币 → HKD；澳元 → AUD。
  只写 "$" 或 "dollar" 时，按地点判断（美国→USD，澳洲→AUD 等），看不出来就用 NZD。
  完全没说币种时：用微信或支付宝付的用 CNY；提到了外国城市/国家就用当地货币；否则用 ${defaultCurrency}。
- 收入（工资、收到培训费、退款、利息等）type=income，用收入分类；其余为 expense，用支出分类。
- 支出分类只能是：${expenseCats.join('、')}。收入分类只能是：${incomeCats.join('、')}。
- 账户只能是：${accounts.join('、')}。没提到就用「${defaultAccount}」。
- store 是商家或地点（保留原文大小写，比如 "Woolworth Westgate"）；item 是买的东西，简短，保持用户原来的语言。人名（比如给谁买的）放进 item，不要当商家。
- 一句里有几笔不同的钱就输出几条；"一共/总共"只算一条。
- 金额必须是用户说出的数字，中文数字要换算（"三十五块五"=35.5，"一千二"=1200）。没有金额的部分不要输出。
${knownStores.length ? `- 用户以前记过的商家和分类（优先沿用）：${knownStores.join('；')}` : ''}`;

  const res = await client.beta.messages.create({
    model,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content: text }],
  });

  if (res.stop_reason === 'refusal') throw new Error('AI 拒绝了这个请求');
  const block = res.content.find(b => b.type === 'text');
  if (!block) throw new Error('AI 没有返回内容');
  const data = JSON.parse(block.text);
  return (data.records || []).filter(r => r.amount > 0).map(r => ({ ...r, note: text, ai: true }));
}
