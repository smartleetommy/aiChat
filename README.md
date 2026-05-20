# AI 问答系统

## MySQL read-only query

To execute generated SQL directly against MySQL, configure a read-only database account in `.env`:

```bash
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=readonly_user
MYSQL_PASSWORD=readonly_password
MYSQL_DATABASE=your_database
MYSQL_QUERY_TIMEOUT_MS=10000
MYSQL_MAX_ROWS=200
```

## 日志、记忆与深度思考

- `logs/requests.jsonl` 会保存每次调用模型的 `upstreamRequest.body` 和 `upstreamResponse`，包含模型名称、messages、temperature、stream、原始返回体等信息；不会记录 `Authorization` header 或 API Key。
- `memory/user-profile.md` 会保存用户画像。聊天成功后后端会根据最近对话追加偏好和摘要，并在下一次请求时把画像作为本地上下文提供给模型。`memory/` 已加入 `.gitignore`。
- 页面参数里可以开启“深度思考”。开启后请求会携带 `deepThinking: true`，后端会加入深度分析提示，流式输出时页面会展示“深度思考中”；如果模型返回 `reasoning_content`，前端只展示思考状态，不展示隐藏推理内容。

The browser never receives the password. The backend only allows one read-only `SELECT` or `WITH` statement, disables multiple statements, blocks write/DDL keywords, and wraps the query with a row limit. The NL2SQL panel shows database status and can execute the SQL result, then fills the chart data box automatically.

New API endpoints:

- `GET /api/database/status`: returns MySQL configuration status without secrets.
- `POST /api/database/query`: accepts `{ "sql": "SELECT ..." }` and returns `{ columns, rows, rowCount, limited }`.

一个本地运行的多模型 AI 问答工作台。前端提供类似 ChatGPT 的会话体验，后端统一转发到 DeepSeek、GLM 或其他 OpenAI-compatible API 服务，API Key 只保存在服务端环境变量中。

## 运行

1. 复制 `.env.example` 为 `.env`
2. 在 `.env` 中填写你要接入的服务商 Key
3. 启动服务：

```bash
npm run dev
```

打开 `http://localhost:3000`。

## 已支持的后端变量

```bash
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_MODELS=deepseek-chat,deepseek-reasoner

GLM_API_KEY=...
GLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
GLM_MODEL=glm-4-plus
GLM_MODELS=glm-4-plus,glm-4-air,glm-4-flash,glm-4-long

CUSTOM_API_KEY=sk-...
CUSTOM_BASE_URL=https://your-provider.example.com/v1
CUSTOM_CHAT_PATH=/chat/completions
CUSTOM_MODEL=your-model-name
CUSTOM_MODELS=your-model-name,another-model-name
```

模型名要和服务商实际支持的名称一致。DeepSeek 常用 `deepseek-chat` 或 `deepseek-reasoner`；如果填写不存在的模型名，或把第三方聚合平台的模型名填到 DeepSeek 官方地址上，可能会返回 `Request Blocked` 或 HTML 错误页。
顶部模型下拉框来自 `*_MODELS` 变量，多个模型用英文逗号分隔；`*_MODEL` 是默认选中的模型。也支持追加编号模型，例如 `DEEPSEEK_MODEL_1=deepseek-v4-flash`、`DEEPSEEK_MODEL_2=another-model`。

## 接口

- `GET /api/providers`：返回当前服务商配置状态
- `POST /api/chat`：发送聊天请求，默认以 SSE 流式返回；传入 `"stream": false` 可使用普通 JSON 返回
- `POST /api/nl2sql`：根据自然语言和表结构生成 SQL

请求示例：

```json
{
  "provider": "deepseek",
  "model": "deepseek-chat",
  "temperature": 0.7,
  "messages": [
    { "role": "user", "content": "你好" }
  ]
}
```

NL2SQL 请求示例：

```json
{
  "provider": "deepseek",
  "model": "deepseek-chat",
  "dialect": "MySQL",
  "schema": "orders(id, user_id, amount, created_at)",
  "question": "统计最近 30 天每天的订单金额趋势"
}
```

## NL2SQL 和图表

打开页面右上角 `IDE`，在 `NL2SQL` 区域填写表结构和分析问题，点击“生成 SQL”。执行 SQL 后，可以把查询结果粘贴为 JSON 或 CSV，点击“生成图表”，前端会根据字段类型自动选择：

- 日期 + 数值：折线图
- 类目 + 数值：柱状图
- 少量类目占比：饼图
- 其他结构：表格预览

## 日志和排错

后端会把请求结果写入 `logs/requests.jsonl`，该目录已被 `.gitignore` 排除，不会提交到仓库。遇到 `fetch failed` 时，通常表示 Node 后端无法连接模型服务，可以重点检查：

- `*_BASE_URL` 是否是正确的 OpenAI-compatible 地址
- `*_MODEL` 是否被该服务商支持
- API Key 是否有效且有权限
- 当前网络、代理或防火墙是否允许 Node 访问模型服务

## 文件结构

```text
server.js          # Node 后端和模型 API 转发
public/index.html  # 页面结构
public/styles.css  # 界面样式
public/app.js      # 聊天状态、历史会话和请求逻辑
```
