# 一句话记账 PWA

一个可以装在手机主屏幕上的记账 App。**打一句话（或说一句话）就记一笔**，自动识别商家、物品、金额、币种（人民币 / 纽币）、分类、账户和日期。

```
Woolworth Westgate 买菜 41               → 买菜 · Woolworth Westgate · NZ$41 · 卡
Tommy Hilfiger Westgate jacket 344 card  → 服饰 · Tommy Hilfiger Westgate · jacket · NZ$344
昨天在麦当劳吃午饭 35 块 微信              → 餐饮 · 麦当劳 · 午饭 · ¥35 · 微信 · 昨天
收到培训费 3000 纽币                      → 收入 · 培训收入 · NZ$3000
Albany mall food court lunch 25.5 cash   → 餐饮 · Albany mall · NZ$25.5 · 现金
```
一次可以输入多行，每行一笔。

## 功能
| | |
|---|---|
| 📒 明细 | 每日 / 日历 / 月度三种看法；收入、支出、结余按主货币折算 |
| 📊 统计 | 按分类的支出/收入占比，近 6 个月趋势；点分类看明细 |
| 💳 账户 | 卡、现金、微信、支付宝……每个账户本月和累计的收支 |
| 🔍 搜索 | 按商家、物品、分类、金额搜索全部记录 |
| 🧠 越用越聪明 | 记住每个商家的分类、账户和币种，下次只写“Woolworth Westgate 41”就够了 |
| 🤖 AI 识别（可选） | 填入 Anthropic API Key，用 Claude 理解更复杂的句子，比如“给 Ingrid 在 Under Amore 买内衣 106，又在 Skechers 买鞋 120”会拆成两笔 |
| 💱 双币种 | 每笔保留原币种，统计时按汇率折算，汇率可一键在线更新 |
| 📥 导入 | 可直接导入 Money Manager 等 App 导出的 Excel（.xls/.xlsx/.csv） |
| 📤 导出 | CSV（Excel 能打开）、JSON 备份与恢复 |
| 📴 离线 | 本地识别完全离线；数据只保存在你的手机里 |

## 两种识别方式
- **本地规则**（默认）：免费、离线、即时。适合“商家 物品 金额”这种写法，中英文都行。
- **AI（Claude）**：在“设置 → 识别方式”切换，填入你自己的 [Anthropic API Key](https://console.anthropic.com/)。
  - 默认 Claude Opus 5.5，记一笔大约花不到 0.01 美元；也可以选更便宜的 Sonnet 5.5 或 Haiku 5.5。
  - Key 只存在手机本地，请求从手机直接发给 Anthropic。
  - 没网或出错时自动退回本地规则。

## 从 Money App 搬家
在 Money App 里：更多 → 备份 → **导出到 Excel**，把文件传到手机，然后在本 App 的“设置 → 导入 Money 的 Excel”选择它。转账记录会被跳过，重复的记录不会重复导入，英文分类会自动对应到中文分类（Food→餐饮、Groceries→买菜、Apparel→服饰……）。

## 发布到手机（GitHub Pages，免费）
1. 把分支合并到 `main`
2. 仓库 Settings → Pages → Source 选 “Deploy from a branch”，分支 `main`，目录 `/ (root)`
3. 打开 `https://<你的用户名>.github.io/Money/`，在浏览器菜单里“添加到主屏幕”

## 文件
| 文件 | 作用 |
|---|---|
| `index.html` / `style.css` | 页面和样式（自动深色模式） |
| `app.js` | 界面、保存、统计、导入导出 |
| `parser.js` | 本地识别规则（中文数字、币种、商家、分类、账户、日期、学习过的商家） |
| `ai.js` | 可选的 Claude 识别 |
| `importer.js` | Excel / CSV 导入 |
| `sw.js` / `manifest.webmanifest` | 离线和安装 |

本地测试：`python3 -m http.server 8000`，打开 http://localhost:8000
