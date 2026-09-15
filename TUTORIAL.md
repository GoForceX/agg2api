# agg2api — 分步部署教程

每一步都给出**命令 + 预期输出**。所有命令都在本机实测过（`bun run tutorial` 会跑完整流程）。

预计 5 分钟。

---

## 步骤 0：确认前提

```bash
bun --version     # 需要 ≥ 1.4
```

Docker 方式还需要 `docker` 与 `docker compose`。

---

## 步骤 1：拿到代码

```bash
git clone <your-repo> agg2api
cd agg2api
```

---

## 步骤 2：生成 admin token

管理端所有操作靠这一个 token 保护。**非本机绑定时它是必需的** —— 为空则服务拒绝启动。

```bash
openssl rand -hex 32
# 例如：9f2c1a...（记下来，下面要用）
```

---

## 步骤 3A：Docker Compose 启动（推荐）

```bash
cp .env.example .env
sed -i "s/^AGG2API_ADMIN_TOKEN=.*/AGG2API_ADMIN_TOKEN=$(openssl rand -hex 32)/" .env

docker compose up -d --build
docker compose logs -f agg2api      # Ctrl-C 退出日志
```

预期日志：

```
agg2api listening on http://0.0.0.0:8787
admin UI: http://127.0.0.1:8787/admin/
```

> 首次 `--build` 会拉取基础镜像并安装依赖，需要几分钟，且**需要容器能访问网络**。

---

## 步骤 3B：或用单文件二进制（不想装 Docker）

```bash
bun run build          # → dist/agg2api
bun run build:web      # → web/dist

mkdir -p /opt/agg2api/data
cp dist/agg2api /opt/agg2api/
cp -r web/dist /opt/agg2api/web/dist

cd /opt/agg2api
AGG2API_ADMIN_TOKEN=<你的token> \
AGG2API_HOST=127.0.0.1 \
AGG2API_DB_PATH=/opt/agg2api/data/agg2api.db \
./agg2api
```

> 二进制**从磁盘读取 `web/dist`**，不在自身内。务必在同一目录下运行，或设 `AGG2API_WEB_ROOT=/绝对路径`。

---

## 步骤 4：确认服务起来了 ⚠️ 此时还没配 provider

```bash
curl -s localhost:8787/healthz
```

**预期返回 503，这是正确的：**

```json
{"status":"degraded","providers_total":0,"providers_enabled":0,"routes":0,
 "detail":"no enabled provider: every completion request will fail"}
```

> 别被 503 吓到。新装的网关没有任何 provider，此刻它对每个请求都会失败 —— 健康检查如实反映了这一点。下面配好之后会变 200。

---

## 步骤 5：添加第一个 provider

```bash
TOKEN=$(grep '^AGG2API_ADMIN_TOKEN=' .env | cut -d= -f2)   # 二进制方式请手动填

curl -s localhost:8787/admin/api/providers \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
        "name": "openai",
        "kind": "openai-chat",
        "base_url": "https://api.openai.com",
        "api_key": "sk-你的真实key",
        "priority": 100
      }'
```

预期返回 `200` 和新建的 provider（含 `"id":1`）。

`kind` 三选一：

| kind | 用于 |
|---|---|
| `openai-chat` | OpenAI 兼容的 Chat Completions（vLLM / DeepSeek / Ollama / 各类中转） |
| `openai-responses` | 仅提供 Responses API 的上游 |
| `workbuddy2api` | Sliverkiss/workbuddy2api（额外显示 credit 余额） |

> **`base_url` 不要带 `/v1`** —— 网关自己会拼 `/v1/chat/completions`。

---

## 步骤 6：拉取模型列表并发布为路由 ⚠️ 这步最容易漏

**只加 provider 不够。** 必须把发现的模型发布成「路由」，否则 `/v1` 对任何模型都返回 404。

```bash
curl -sX POST localhost:8787/admin/api/discover    -H "Authorization: Bearer $TOKEN"
curl -sX POST localhost:8787/admin/api/routes/sync -H "Authorization: Bearer $TOKEN"
```

预期：

```json
{"created":["gpt-4o-mini","gpt-4o"],"updated":[],"removed":[]}
```

---

## 步骤 7：验证可用

```bash
# 1) 现在是 ok 了
curl -s localhost:8787/healthz
# -> {"status":"ok","providers_total":1,"providers_enabled":1,"routes":2}

# 2) 看模型列表
curl -s localhost:8787/v1/models

# 3) 发一次真实请求
curl -s localhost:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

第 3 条返回 `choices[0].message.content` 即部署成功。

---

## 步骤 8：打开管理界面

浏览器访问 <http://127.0.0.1:8787/admin/>

1. 会弹出 **Admin token required**
2. 粘贴步骤 2 的 token → 自动进入 Dashboard

界面里能看：provider 健康、缓存率、用量、成本、请求日志，以及改路由/加 provider/建 key。

> **注意：`/admin/` 的 HTML 必须不被缓存。** 前端是内容哈希构建，如果反代缓存了 `index.html`，升级后你会一直看到旧界面（我实测踩过这个坑）。`/v1/*` 则绝不能缓冲，否则流式失效。

---

## 步骤 9：给客户端发 key（可选，但生产建议）

默认 `/v1` 允许匿名。要限制：

```bash
curl -sX POST localhost:8787/admin/api/keys \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"my-app","rate_limit_rpm":600}'
```

返回里 **`key` 字段就是完整密钥，只在这一刻出现**，之后任何接口都只返回掩码：

```json
{"id":1,"name":"my-app","masked":"sk-agg…c4a0",
 "key":"sk-agg-78eaa1b2...","rate_limit_rpm":600}
```

**先复制保存**，然后才开启强制：

```bash
# 编辑 .env，加一行后重启
AGG2API_REQUIRE_CLIENT_KEY=true
docker compose up -d          # 或重启二进制
```

> 顺序不能反。先开 `REQUIRE_CLIENT_KEY` 再想建 key，会发现 `/v1` 全变 401 且自己没 key 可用。

客户端这样用：

```bash
curl -H "Authorization: Bearer sk-agg-..." ... /v1/chat/completions
```

---

## 步骤 10：接到客户端

三种协议，指向网关根地址即可：

```bash
# OpenAI 兼容（官方 SDK 改 base_url）
OPENAI_BASE_URL=http://127.0.0.1:8787/v1
OPENAI_API_KEY=<client key 或任意值>

# Anthropic 兼容
ANTHROPIC_BASE_URL=http://127.0.0.1:8787/anthropic
```

顺便建议加一个头，能显著提升缓存命中：

```http
x-session-id: <你的会话 id>
```

---

## 步骤 11：备份

状态只有一个 SQLite 文件：

```bash
docker compose stop agg2api
docker run --rm -v agg2api_agg2api-data:/data -v "$PWD:/backup" alpine \
  tar czf /backup/agg2api-$(date +%F).tar.gz -C /data .
docker compose start agg2api
```

> 别用 `cp` 直接拷正在运行的 WAL 数据库，可能拿到撕裂的副本。

---

## 排障速查

| 现象 | 原因 |
|---|---|
| `/healthz` 一直 503 `no enabled provider` | 步骤 5 没做，或 provider `enabled:false` |
| `/healthz` 503 `no routes` | **步骤 6 没做**（最常见） |
| `/v1` 全部 404 | 同上，或模型名与 `/v1/models` 里的不一致 |
| 启动即退出 `admin_token is empty while host is 0.0.0.0` | 步骤 2 的 token 没设 |
| `/admin/` 是白页或旧界面 | 反代缓存了 `index.html`，或 `web/dist` 没构建/不在 `web_root` |
| 流式不流（一次性出完） | 反代缓冲了响应，需 `proxy_buffering off` |
| 某个 provider 一直 401 | 上游 key 错；看 Dashboard → Providers 的 last error |
| 费用一直是 0 | 没给 provider 设 `input_price` / `output_price` |

---

## 一键自检

想跳过手工验证，直接跑完整流程（用 mock 上游，不会消耗你的真实额度）：

```bash
bun run tutorial        # 打印每一步的命令与预期输出
```

它会依次执行：启动网关 → 确认 degraded → 加 provider → discovery → route sync → 确认 ok → 发真实补全 → 建 client key → 输出用量，全部成功才退出 0。
