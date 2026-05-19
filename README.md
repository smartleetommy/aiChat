# AI 问答系统

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

GLM_API_KEY=...
GLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
GLM_MODEL=glm-4-plus

CUSTOM_API_KEY=sk-...
CUSTOM_BASE_URL=https://your-provider.example.com/v1
CUSTOM_CHAT_PATH=/chat/completions
CUSTOM_MODEL=your-model-name
```

## 接口

- `GET /api/providers`：返回当前服务商配置状态
- `POST /api/chat`：发送聊天请求
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

## 文件结构

```text
server.js          # Node 后端和模型 API 转发
public/index.html  # 页面结构
public/styles.css  # 界面样式
public/app.js      # 聊天状态、历史会话和请求逻辑
```
