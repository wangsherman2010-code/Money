# 家庭同步服务器（装在你自己的 VPS 上）

两台手机通过这个小程序共用一个账本。它同时提供 App 网页和同步接口，数据只存在你的 VPS 上，不经过任何第三方云。

- 只有一个文件 `server.js`，不需要安装任何依赖，Node.js 18 以上就能跑
- 数据存在 `data/ledger.json`，每天自动备份一份（保留 30 天）
- 用“家庭密码”保护；连续输错 10 次会封锁该 IP 15 分钟
- 两人各自离线记账，有网时自动同步；同一条记录两人都改了，以后改的为准

## 需要准备

1. 一台 VPS（Ubuntu / Debian 为例），能用 SSH 登录
2. 一个域名，指向 VPS 的 IP（比如 `money.你的域名.com`）。
   **没有域名也可以**：用 `你的IP.sslip.io`，比如 IP 是 `203.0.113.5`，地址就是 `203-0-113-5.sslip.io`，免费、不用注册。
3. 手机上的 App 必须用 **https** 打开，所以下面用 Caddy 自动申请免费证书。

## 第 1 步：装 Node.js 和 Caddy

```bash
# Node.js（如果已经有 18 以上版本可以跳过；用 node -v 查看）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Caddy（自动 HTTPS 的网页服务器）
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

## 第 2 步：放上代码

```bash
sudo mkdir -p /opt/money && sudo chown $USER /opt/money
git clone https://github.com/wangsherman2010-code/Money.git /opt/money
cd /opt/money && git checkout ccr-4060ec46-7qzv3i   # 合并到 main 之后可以省略这一步
```

> 仓库是私有的？`git clone` 会要密码：在 GitHub → Settings → Developer settings → Personal access tokens 建一个只读 token 当密码用；或者在电脑上下载 ZIP，用 `scp` 传到 `/opt/money`。

## 第 3 步：设置家庭密码，开机自动运行

先想一个长一点的家庭密码（至少 8 位，建议 16 位以上，可以用 `openssl rand -base64 18` 生成一个）。

```bash
mkdir -p /opt/money/server/data                       # 数据目录（服务只允许写这里）
sudo cp /opt/money/server/voice-ledger.service /etc/systemd/system/
sudo nano /etc/systemd/system/voice-ledger.service   # 把 TOKEN= 后面换成你的家庭密码；User= 换成你的用户名
sudo systemctl daemon-reload
sudo systemctl enable --now voice-ledger
sudo systemctl status voice-ledger                    # 看到 active (running) 就成功了
```

## 第 4 步：配置 HTTPS

```bash
sudo nano /etc/caddy/Caddyfile
```

把内容换成（域名换成你自己的，或者 `203-0-113-5.sslip.io` 这种）：

```
money.你的域名.com {
    encode gzip
    reverse_proxy 127.0.0.1:8787
}
```

```bash
sudo systemctl reload caddy
```

防火墙要放行 80 和 443 端口（Caddy 申请证书要用 80）：`sudo ufw allow 80,443/tcp`。8787 端口**不要**对外开放。

> 已经在用 Nginx？不装 Caddy 也行，在你的 server 配置里加
> `location / { proxy_pass http://127.0.0.1:8787; proxy_set_header X-Forwarded-For $remote_addr; }`，证书用 certbot。

## 第 5 步：两台手机加入

1. 手机浏览器打开 `https://money.你的域名.com`
2. 设置 → 家庭共享：服务器地址会自动填好；填 **家庭密码** 和 **你的名字**（比如 Sherman / Lily）→ 连接并同步
3. 另一台手机做同样的事，名字填她自己的
4. 浏览器菜单里 **添加到主屏幕**

之后谁记一笔，另一台手机打开 App 或过几秒就能看到，记录上会显示“👤 Lily”这样的名字；统计页会多出“按人”一栏。

### 以前在别的网址（比如 GitHub Pages）记过账？

不同网址的数据在手机上是分开存的。搬家方法任选一种：
- **简单**：在旧网址的 App 里也连上这个服务器（地址填 `https://money.你的域名.com`），同步一次，旧记录就上传了；然后改用新网址。
- **或者**：旧网址里“备份 JSON”，新网址里“恢复备份”，再连接同步。

## 日常维护

| 要做什么 | 命令 |
|---|---|
| 看运行日志 | `journalctl -u voice-ledger -f` |
| 更新到最新版本 | `cd /opt/money && git pull && sudo systemctl restart voice-ledger` |
| 手动备份 | 复制 `/opt/money/server/data/` 整个文件夹（`ledger.json` 就是全部数据） |
| 导出全部数据 | `curl -H "Authorization: Bearer 你的家庭密码" https://money.你的域名.com/api/export -o ledger.json` |
| 换家庭密码 | 改 service 文件里的 TOKEN → `sudo systemctl daemon-reload && sudo systemctl restart voice-ledger` → 两台手机在设置里填新密码，点“重新连接” |

## 可选的环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `TOKEN` | （必填） | 家庭密码 |
| `PORT` | `8787` | 端口 |
| `HOST` | `127.0.0.1` | 只监听本机，由 Caddy 对外提供 HTTPS |
| `DATA_DIR` | `server/data` | 数据目录 |
| `STATIC_DIR` | 上一级目录 | App 网页所在目录；设成空字符串则只提供同步接口 |
| `ALLOW_ORIGIN` | `*` | App 放在别的网址时允许跨域调用 |
