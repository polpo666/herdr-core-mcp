# herdr-core-mcp（中文）

把 **herdr-core** 的终端（Claude Code / Codex / pi 等 agent，以及普通 shell）通过 MCP 暴露给
**ChatGPT 网页版** 的 connector。herdr-core 的 API 是 Unix socket 上的逐行 JSON-RPC 2.0；
ChatGPT 的自定义 connector 只接受 **公网 HTTPS + Streamable HTTP + OAuth 2.1（不支持 API key）**，
这个项目就是中间的桥。

```
ChatGPT (cloud) ──HTTPS──▶ Cloudflare Tunnel / 任意反代
                              │ 127.0.0.1:18790
                              ▼
                        herdr-core-mcp ──unix socket JSON-RPC──▶ herdr-core
                                                                    └─ 联邦机器（machine/t7）
```

## 工具（8 个）

| 工具 | 作用 | 权限 |
|---|---|---|
| `list_terminals` | 列出终端，支持机器/状态/agent/关键词过滤 | 只读 |
| `get_terminal` | status、turn、cwd、前台进程、labels | 只读 |
| `read_terminal` | 屏幕 + 最多 200 行历史（纯文本） | 只读 |
| `wait_terminal` | 等到不 working / 退出 / 出现指定输出（单次 ≤40s） | 只读 |
| `list_machines` | 联邦机器与连接状态 | 只读 |
| `send_message` | 粘贴文本并回车；blocked 时拒绝 | 写 |
| `send_keys` | 具名按键（enter/esc/ctrl+c…） | 写 |
| `interrupt_terminal` | 按停止键结束当前回合 | 写 |

**故意不提供** run / kill / rm：ChatGPT 不能新起任意命令或杀终端。写操作全部写入
`~/.herdr-mcp/audit.log`（0600）。

## 安全模型

- **只支持 OAuth 2.1**：授权码 + PKCE S256 + 动态客户端注册 + 单用户口令页。ChatGPT 不能发送
  自定义 API key，这是它唯一接受的安全方式。
- **终端输出是不可信数据**：server instructions 和每个工具描述都要求模型不要执行屏幕里的指令。
- **blocked 不代答**：`send_message` 固定 `force:false`，权限弹窗必须由人在 Herdr 里确认。
- **内容会出境**：终端屏幕会发给 OpenAI，不要暴露显示敏感信息的终端。
- 可选：`HERDR_MCP_READ_ONLY=1` 只注册只读工具；`HERDR_MCP_MACHINES=a,b` 限制机器范围。

## 快速开始

```sh
npm install
npm test        # 协议向量、fake core、OAuth + MCP 全流程
npm run build

export HERDR_MCP_OWNER_PASSWORD=dev
export HERDR_MCP_PUBLIC_URL=http://127.0.0.1:18790
npm run dev
```

冒烟（本地或公网）：

```sh
SMOKE_PASSWORD=dev npm run smoke -- --base http://127.0.0.1:18790
SMOKE_PASSWORD=dev npm run smoke -- --base https://mcp.example.com --terminal t7 --send "echo hi"
```

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `HERDR_MCP_HOST` | `127.0.0.1` | 监听地址，保持 loopback，公网交给隧道 |
| `HERDR_MCP_PORT` | `18790` | 端口 |
| `HERDR_MCP_PUBLIC_URL` | `http://127.0.0.1:18790` | OAuth issuer/resource 基址，必须与客户端使用的 URL 一致 |
| `HERDR_MCP_STATE_DIR` | `~/.herdr-mcp` | `auth.json`、`oauth.json`、`audit.log` |
| `HERDR_MCP_OWNER_PASSWORD` | — | 优先于 `auth.json` 的 `ownerPassword` |
| `HERDR_MCP_ALLOWED_HOSTS` | host + public host | Host 头白名单 |
| `HERDR_MCP_READ_ONLY` | `0` | `1` = 只注册只读工具 |
| `HERDR_MCP_MACHINES` | 全部 | 逗号分隔的机器白名单 |
| `HC_SESSION` / `HC_SOCKET` | `default` / 自动 | 连接哪个 herdr-core 会话 |

`auth.json`：`{"ownerPassword":"…"}`，权限 0600，口令用 `openssl rand -base64 24` 生成。

## 部署

任何常开、能连到 herdr-core socket 的主机都可以；仓库自带 macOS + launchd 脚本：

```sh
REMOTE=you@server PUBLIC_URL=https://mcp.example.com ./deploy/install.sh
```

它会本地构建 → rsync 到 `~/herdr-core-mcp` → `npm ci --omit=dev` → 渲染并启动 launchd
（默认 `com.herdr-core-mcp`）→ 请求 `/healthz`。

然后把隧道/反代指向 `127.0.0.1:18790`。Cloudflare Tunnel 示例：

```yaml
# ~/.cloudflared/herdr-core-mcp.yml
tunnel: <tunnel-id>
credentials-file: /home/you/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: mcp.example.com
    service: http://127.0.0.1:18790
  - service: http_status:404
```

```sh
cloudflared tunnel create herdr-core-mcp
cloudflared --config ~/.cloudflared/herdr-core-mcp.yml tunnel route dns herdr-core-mcp mcp.example.com
cloudflared --config ~/.cloudflared/herdr-core-mcp.yml tunnel run
```

注意 `tunnel route dns` 默认读 `~/.cloudflared/config.yml`，**必须显式 `--config`**，否则 CNAME
会写到别的隧道上。DNS 被劫持成 Fake-IP 的网络里，cloudflared 可能需要
`--protocol http2 --edge <真实边缘IP>:7844`。

## 接 ChatGPT

1. Settings → Apps & Connectors → Advanced → 打开 Developer mode（付费套餐）。
2. **Create** → URL 填 `https://mcp.example.com/mcp`。
3. 在授权页输入 owner 口令。
4. 新对话 `+` → More → Developer mode → 勾选 connector（每个会话都要勾）。

套餐不允许写工具时，设 `HERDR_MCP_READ_ONLY=1` 重启，connector 就只暴露 5 个只读工具。

## 排障

- **`core_not_running`**：core 没起，或 `HC_SESSION` 不对。
- **新实例打印 listening 后秒退**：端口被别的进程占着，
  `lsof -nP -iTCP:18790 -sTCP:LISTEN` 清掉后再重启。
- **ChatGPT 401 循环**：`HERDR_MCP_PUBLIC_URL` 与 connector 里的 URL 不一致，或口令错。
- **看不到某台机器**：`list_machines` 看链路；联邦机器在 core 上配置（`hc machine add`）。
- **连接被重置**：core 重启过，下一次调用会自动重连。

## 许可证

Apache-2.0，见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。协议层与 wire 向量来自
[Heeler](https://github.com/polpo666/heeler)（同为 Apache-2.0）。
