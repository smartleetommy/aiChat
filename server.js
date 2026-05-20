import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const logsDir = path.join(__dirname, "logs");
const requestLogPath = path.join(logsDir, "requests.jsonl");
const answerLogPath = path.join(logsDir, "answers.jsonl");
const memoryDir = path.join(__dirname, "memory");
const userProfilePath = path.join(memoryDir, "user-profile.md");
const port = Number(process.env.PORT || 3000);

await loadDotEnv(path.join(__dirname, ".env"));

const mysqlConfig = {
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  queryTimeoutMs: Number(process.env.MYSQL_QUERY_TIMEOUT_MS || 10000),
  maxRows: Number(process.env.MYSQL_MAX_ROWS || 200)
};

let mysqlPool;
let mysqlModule;

function parseModelList(value, fallback) {
  const models = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return models.length ? models : fallback;
}

function getProviderModels(prefix, fallback) {
  const listModels = parseModelList(process.env[`${prefix}_MODELS`], []);
  const numberedModels = Object.entries(process.env)
    .filter(([key]) => new RegExp(`^${prefix}_MODEL_\\d+$`).test(key))
    .sort(([left], [right]) => Number(left.split("_").pop()) - Number(right.split("_").pop()))
    .map(([, value]) => String(value).trim())
    .filter(Boolean);
  const defaultModel = process.env[`${prefix}_MODEL`];
  const models = [defaultModel, ...listModels, ...numberedModels].filter(Boolean);
  return models.length ? models : fallback;
}

function parseJsonEnv(value, fallback = {}) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

const providers = {
  deepseek: {
    label: "DeepSeek",
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    path: "/chat/completions",
    defaultModel: process.env.DEEPSEEK_MODEL || "deepseek-chat",
    models: getProviderModels("DEEPSEEK", ["deepseek-chat", "deepseek-reasoner"]),
    thinkingBody: parseJsonEnv(process.env.DEEPSEEK_THINKING_BODY, {
      reasoning_effort: "high",
      thinking: { type: "enabled" }
    })
  },
  glm: {
    label: "GLM",
    apiKey: process.env.GLM_API_KEY,
    baseUrl: process.env.GLM_BASE_URL || "https://open.bigmodel.cn/api/paas/v4",
    path: "/chat/completions",
    defaultModel: process.env.GLM_MODEL || "glm-4-plus",
    models: getProviderModels("GLM", ["glm-4-plus", "glm-4-air", "glm-4-flash", "glm-4-long"]),
    thinkingBody: parseJsonEnv(process.env.GLM_THINKING_BODY)
  },
  custom: {
    label: "Custom",
    apiKey: process.env.CUSTOM_API_KEY,
    baseUrl: process.env.CUSTOM_BASE_URL,
    path: process.env.CUSTOM_CHAT_PATH || "/chat/completions",
    defaultModel: process.env.CUSTOM_MODEL || "gpt-compatible-model",
    models: getProviderModels("CUSTOM", [process.env.CUSTOM_MODEL || "gpt-compatible-model"]),
    thinkingBody: parseJsonEnv(process.env.CUSTOM_THINKING_BODY)
  }
};

async function loadDotEnv(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    text.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;

      const equalsIndex = trimmed.indexOf("=");
      if (equalsIndex === -1) return;

      const key = trimmed.slice(0, equalsIndex).trim();
      const rawValue = trimmed.slice(equalsIndex + 1).trim();
      const value = rawValue.replace(/^["']|["']$/g, "");

      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function safeError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    code: error?.code,
    status: error?.status,
    cause: error?.cause?.message || error?.cause?.code
  };
}

async function writeRequestLog(entry) {
  const record = {
    time: new Date().toISOString(),
    ...entry
  };

  try {
    await fs.mkdir(logsDir, { recursive: true });
    await fs.appendFile(requestLogPath, `${JSON.stringify(record)}\n`, "utf8");
  } catch (error) {
    console.error("Failed to write request log:", error.message);
  }
}

async function writeAnswerLog(entry) {
  const record = {
    time: new Date().toISOString(),
    ...entry
  };

  try {
    await fs.mkdir(logsDir, { recursive: true });
    await fs.appendFile(answerLogPath, `${JSON.stringify(record)}\n`, "utf8");
  } catch (error) {
    console.error("Failed to write answer log:", error.message);
  }
}

function compactText(text, maxLength = 6000) {
  const value = String(text || "");
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n...[truncated ${value.length - maxLength} chars]`;
}

function extractAssistantContent(data) {
  return data?.choices?.[0]?.message?.content || "";
}

async function readUserProfile() {
  try {
    return await fs.readFile(userProfilePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function getLastUserMessage(messages) {
  return [...messages].reverse().find((message) => message?.role === "user")?.content || "";
}

function normalizeThinkingEffort(value) {
  return value === "max" ? "max" : "high";
}

function buildThinkingBody(provider, effort) {
  const thinkingBody = { ...(provider.thinkingBody || {}) };
  return {
    ...thinkingBody,
    reasoning_effort: effort,
    thinking: thinkingBody.thinking || { type: "enabled" }
  };
}

function inferUserSignals(text) {
  const content = String(text || "").toLowerCase();
  const signals = new Set();

  if (/api|key|base url|deepseek|glm|model|模型|接口|服务商/.test(content)) signals.add("关注模型接入、API 配置和服务稳定性");
  if (/日志|报文|排查|报错|debug|error|fetch/.test(content)) signals.add("需要清晰的调试日志和可复盘的请求信息");
  if (/ui|界面|侧边栏|头像|按钮|展示|前端|浏览器/.test(content)) signals.add("重视界面交互、视觉细节和浏览器端体验");
  if (/sql|mysql|图表|数据|nl2sql|chart/.test(content)) signals.add("希望 AI 能处理数据分析、NL2SQL 和图表生成");
  if (/github|git|仓库|提交|分支/.test(content)) signals.add("使用 Git/GitHub 管理项目交付");
  if (/中文|文案|产品|需求|理财|基金|股票/.test(content)) signals.add("常用中文表达，希望回答直接、可执行");

  return Array.from(signals);
}

function buildMemoryMessages(messages, profile, deepThinking) {
  const nextMessages = [];

  if (profile.trim()) {
    nextMessages.push({
      role: "system",
      content: [
        "The following local user profile may help you personalize the answer.",
        "Use it only when relevant. Do not quote or mention the profile unless the user asks.",
        compactText(profile, 4000)
      ].join("\n")
    });
  }

  if (deepThinking) {
    nextMessages.push({
      role: "system",
      content: [
        "The user enabled deep thinking mode.",
        "Analyze the problem carefully before answering, but do not reveal hidden chain-of-thought.",
        "Show a concise thinking status or brief rationale only when useful, then provide the final answer."
      ].join("\n")
    });
  }

  return [...nextMessages, ...messages];
}

async function updateUserProfile({ messages, assistantContent, provider, model }) {
  const userText = getLastUserMessage(messages).trim();
  if (!userText) return;

  const existing = await readUserProfile();
  const now = new Date().toISOString();
  const signals = inferUserSignals(userText);
  const existingSignals = new Set(
    (existing.match(/^- .+$/gm) || [])
      .map((line) => line.slice(2).trim())
      .filter(Boolean)
  );
  signals.forEach((signal) => existingSignals.add(signal));

  const recentSection = [
    `- ${now} | ${provider}/${model}`,
    `  - 用户: ${compactText(userText.replace(/\s+/g, " "), 500)}`,
    `  - 助手摘要: ${compactText(String(assistantContent || "").replace(/\s+/g, " "), 500)}`
  ].join("\n");
  const priorRecent = existing
    .split("## 最近对话摘要")[1]
    ?.split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(0, 72)
    .join("\n") || "";

  const profile = [
    "# 用户画像",
    "",
    `更新时间: ${now}`,
    "",
    "## 偏好与画像",
    ...Array.from(existingSignals).slice(0, 24).map((signal) => `- ${signal}`),
    "",
    "## 最近对话摘要",
    recentSection,
    priorRecent ? priorRecent : ""
  ].join("\n");

  await fs.mkdir(memoryDir, { recursive: true });
  await fs.writeFile(userProfilePath, profile.trim() + "\n", "utf8");
}

function modelFetchErrorMessage(error) {
  if (error?.message === "fetch failed") {
    return "连接模型服务失败。请检查 Base URL、模型名称、API Key、网络代理或服务商访问权限；详细信息已写入后端日志。";
  }

  return error?.message || "模型服务请求失败，详细信息已写入后端日志。";
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function publicProvider(provider) {
  return {
    id: provider,
    label: providers[provider].label,
    configured: Boolean(providers[provider].apiKey && providers[provider].baseUrl),
    defaultModel: providers[provider].defaultModel,
    models: Array.from(new Set([providers[provider].defaultModel, ...providers[provider].models]))
  };
}

function publicDatabaseStatus() {
  return {
    type: "mysql",
    configured: Boolean(mysqlConfig.host && mysqlConfig.user && mysqlConfig.database),
    host: mysqlConfig.host || null,
    port: mysqlConfig.port,
    database: mysqlConfig.database || null,
    maxRows: mysqlConfig.maxRows,
    queryTimeoutMs: mysqlConfig.queryTimeoutMs
  };
}

async function getMysqlPool() {
  if (!publicDatabaseStatus().configured) {
    const error = new Error("MySQL is not configured. Please set MYSQL_HOST, MYSQL_USER and MYSQL_DATABASE.");
    error.status = 400;
    throw error;
  }

  if (!mysqlModule) {
    try {
      mysqlModule = await import("mysql2/promise");
    } catch {
      const error = new Error("mysql2 is not installed. Please run npm install before executing MySQL queries.");
      error.status = 500;
      throw error;
    }
  }

  if (!mysqlPool) {
    mysqlPool = mysqlModule.createPool({
      host: mysqlConfig.host,
      port: mysqlConfig.port,
      user: mysqlConfig.user,
      password: mysqlConfig.password,
      database: mysqlConfig.database,
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0,
      multipleStatements: false,
      supportBigNumbers: true,
      bigNumberStrings: true
    });
  }

  return mysqlPool;
}

function stripLeadingSqlComments(sql) {
  let text = sql.trim();
  let changed = true;

  while (changed) {
    changed = false;
    const lineComment = text.match(/^--[^\r\n]*(?:\r?\n|$)/);
    if (lineComment) {
      text = text.slice(lineComment[0].length).trimStart();
      changed = true;
    }

    const blockComment = text.match(/^\/\*[\s\S]*?\*\//);
    if (blockComment) {
      text = text.slice(blockComment[0].length).trimStart();
      changed = true;
    }
  }

  return text;
}

function normalizeReadonlySql(sql) {
  const trimmed = stripLeadingSqlComments(String(sql || ""));
  if (!trimmed) {
    const error = new Error("SQL cannot be empty.");
    error.status = 400;
    throw error;
  }

  const withoutTrailingSemicolon = trimmed.replace(/;\s*$/, "").trim();
  if (withoutTrailingSemicolon.includes(";")) {
    const error = new Error("Only one SQL statement is allowed.");
    error.status = 400;
    throw error;
  }

  if (!/^(select|with)\b/i.test(withoutTrailingSemicolon)) {
    const error = new Error("Only read-only SELECT or WITH queries are allowed.");
    error.status = 400;
    throw error;
  }

  const forbidden = /\b(insert|update|delete|drop|alter|create|truncate|call|replace|merge|grant|revoke|load|outfile|dumpfile|handler|lock|unlock)\b/i;
  if (forbidden.test(withoutTrailingSemicolon) || /\bfor\s+update\b/i.test(withoutTrailingSemicolon)) {
    const error = new Error("This SQL contains a blocked keyword. Only read-only queries are allowed.");
    error.status = 400;
    throw error;
  }

  return withoutTrailingSemicolon;
}

function limitReadonlySql(sql) {
  const maxRows = Number.isFinite(mysqlConfig.maxRows) && mysqlConfig.maxRows > 0 ? Math.floor(mysqlConfig.maxRows) : 200;
  return {
    sql: `SELECT * FROM (${sql}) AS readonly_query LIMIT ${maxRows + 1}`,
    maxRows
  };
}

function serializeRows(rows) {
  return rows.map((row) => Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      if (value instanceof Date) return [key, value.toISOString()];
      if (Buffer.isBuffer(value)) return [key, value.toString("base64")];
      if (typeof value === "bigint") return [key, value.toString()];
      return [key, value];
    })
  ));
}

function extractSqlFromText(text) {
  const codeBlock = text.match(/```(?:sql)?\s*([\s\S]*?)```/i);
  if (codeBlock) return codeBlock[1].trim();

  const selectIndex = text.search(/\b(select|with)\b/i);
  if (selectIndex >= 0) return text.slice(selectIndex).trim();

  return text.trim();
}

function stripHtml(text) {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function summarizeUpstreamError(text, fallback = "模型服务请求失败。") {
  if (!text) return fallback;

  const title = text.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.trim();
  const plain = stripHtml(text);
  const summary = title || plain.slice(0, 220);

  if (/request blocked/i.test(summary) || /request blocked/i.test(plain)) {
    return "模型服务请求被网关拦截了。请检查 API Key、Base URL、模型名称是否正确，或当前网络是否允许访问该模型服务。";
  }

  return summary || fallback;
}

async function parseUpstreamResponse(response) {
  const text = await response.text();
  const contentType = response.headers.get("content-type") || "";
  const looksLikeHtml = contentType.includes("text/html") || /^\s*<!doctype html/i.test(text) || /^\s*<html/i.test(text);

  if (looksLikeHtml) {
    return {
      data: null,
      rawText: text,
      errorMessage: summarizeUpstreamError(text)
    };
  }

  try {
    return { data: JSON.parse(text), rawText: text, errorMessage: null };
  } catch {
    return {
      data: null,
      rawText: text,
      errorMessage: summarizeUpstreamError(text)
    };
  }
}

function writeSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function parseStreamLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;

  const data = trimmed.slice(5).trim();
  if (!data || data === "[DONE]") return { done: true };

  try {
    return JSON.parse(data);
  } catch {
    return { error: data };
  }
}

async function proxyChatStream(upstream, res, options = {}) {
  const exposeReasoning = Boolean(options.exposeReasoning);
  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";
  let fullReasoningContent = "";
  let rawText = "";
  let reasoningSeen = false;
  let reasoningChars = 0;

  for await (const chunk of upstream.body) {
    const decoded = decoder.decode(chunk, { stream: true });
    rawText += decoded;
    buffer += decoded;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    for (const line of lines) {
      const payload = parseStreamLine(line);
      if (!payload) continue;
      if (payload.done) {
        writeSse(res, "done", { content: fullContent, reasoningContent: fullReasoningContent });
        res.end();
        return { content: fullContent, reasoningContent: fullReasoningContent, rawText };
      }

      if (payload.error) {
        writeSse(res, "error", { error: payload.error });
        continue;
      }

      const reasoning = payload.choices?.[0]?.delta?.reasoning_content
        || payload.choices?.[0]?.message?.reasoning_content
        || payload.choices?.[0]?.delta?.reasoning
        || "";
      if (reasoning && exposeReasoning) {
        const reasoningDelta = String(reasoning);
        fullReasoningContent += reasoningDelta;
        reasoningChars += reasoningDelta.length;
        writeSse(res, "reasoning", { content: reasoningDelta });
        if (!reasoningSeen || reasoningChars % 240 < reasoningDelta.length) {
          reasoningSeen = true;
          writeSse(res, "thinking", {
            status: "模型正在推理",
            detail: `已接收 ${reasoningChars} 个推理字符，正在整理为可读答案`
          });
        }
      }

      const delta = payload.choices?.[0]?.delta?.content || payload.choices?.[0]?.message?.content || "";
      if (delta) {
        fullContent += delta;
        writeSse(res, "delta", { content: delta });
      }
    }
  }

  writeSse(res, "done", { content: fullContent, reasoningContent: fullReasoningContent });
  res.end();
  return { content: fullContent, reasoningContent: fullReasoningContent, rawText };
}

async function requestModelCompletion({ providerId, model, messages, temperature }) {
  const provider = providers[providerId];

  if (!provider) {
    const error = new Error(`Unknown provider: ${providerId}`);
    error.status = 400;
    throw error;
  }

  if (!provider.apiKey || !provider.baseUrl) {
    const error = new Error(`${provider.label} is not configured. Please set its API key and base URL.`);
    error.status = 400;
    throw error;
  }

  const upstreamUrl = new URL(provider.path, provider.baseUrl);
  const requestBody = {
    model: model || provider.defaultModel,
    messages,
    temperature: Number(temperature ?? 0.2),
    stream: false
  };
  const upstream = await fetch(upstreamUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${provider.apiKey}`
    },
    body: JSON.stringify(requestBody)
  });

  const { data, rawText, errorMessage } = await parseUpstreamResponse(upstream);

  if (!upstream.ok) {
    const error = new Error(data?.error?.message || data?.error || errorMessage || "Model request failed.");
    error.status = upstream.status;
    error.requestBody = requestBody;
    error.upstreamUrl = upstreamUrl.toString();
    error.upstreamContentType = upstream.headers.get("content-type") || "";
    error.rawResponse = rawText;
    error.details = data || { raw: rawText.slice(0, 500) };
    throw error;
  }

  if (!data?.choices?.[0]?.message?.content) {
    const error = new Error(errorMessage || "模型服务没有返回有效的聊天内容，请检查模型名称和接口格式。");
    error.status = 502;
    error.requestBody = requestBody;
    error.upstreamUrl = upstreamUrl.toString();
    error.upstreamContentType = upstream.headers.get("content-type") || "";
    error.rawResponse = rawText;
    error.details = data || { raw: rawText.slice(0, 500) };
    throw error;
  }

  return {
    content: data.choices?.[0]?.message?.content || "",
    model: data.model || model || provider.defaultModel,
    usage: data.usage || null,
    requestBody,
    responseBody: data,
    rawResponse: rawText,
    upstreamUrl: upstreamUrl.toString(),
    upstreamStatus: upstream.status,
    upstreamContentType: upstream.headers.get("content-type") || ""
  };
}

async function handleNl2Sql(req, res) {
  let logContext = { endpoint: "/api/nl2sql" };
  try {
    const body = await readBody(req);
    const question = String(body.question || "").trim();
    const schema = String(body.schema || "").trim();
    const dialect = String(body.dialect || "MySQL").trim();
    logContext = {
      ...logContext,
      provider: body.provider || "deepseek",
      model: body.model,
      dialect,
      questionLength: question.length,
      schemaLength: schema.length
    };

    if (!question) {
      sendJson(res, 400, { error: "question is required." });
      return;
    }

    const messages = [
      {
        role: "system",
        content: [
          "You are a senior data analyst that writes safe SQL from natural language.",
          "Return only one SQL query. Prefer read-only SELECT or WITH queries.",
          "Use the provided schema exactly. If a requested field is missing, add a short SQL comment explaining the assumption.",
          `SQL dialect: ${dialect}.`
        ].join("\n")
      },
      {
        role: "user",
        content: `Database schema:\n${schema || "No schema provided."}\n\nQuestion:\n${question}`
      }
    ];

    const completion = await requestModelCompletion({
      providerId: body.provider || "deepseek",
      model: body.model,
      messages,
      temperature: body.temperature ?? 0.2
    });

    sendJson(res, 200, {
      sql: extractSqlFromText(completion.content),
      raw: completion.content,
      provider: body.provider || "deepseek",
      model: completion.model,
      usage: completion.usage
    });
    await writeRequestLog({
      ...logContext,
      ok: true,
      model: completion.model,
      upstreamRequest: {
        method: "POST",
        url: completion.upstreamUrl,
        body: completion.requestBody
      },
      upstreamResponse: {
        status: completion.upstreamStatus,
        contentType: completion.upstreamContentType,
        body: completion.responseBody,
        raw: completion.rawResponse
      }
    });
  } catch (error) {
    await writeRequestLog({
      ...logContext,
      ok: false,
      error: safeError(error),
      details: error.details || null,
      upstreamRequest: error.requestBody ? {
        method: "POST",
        url: error.upstreamUrl,
        body: error.requestBody
      } : null,
      upstreamResponse: error.rawResponse ? {
        status: error.status,
        contentType: error.upstreamContentType,
        raw: error.rawResponse
      } : null
    });
    sendJson(res, error.status || 500, {
      error: modelFetchErrorMessage(error),
      details: error.details || null
    });
  }
}

async function handleDatabaseStatus(req, res) {
  sendJson(res, 200, publicDatabaseStatus());
}

async function handleDatabaseQuery(req, res) {
  const startedAt = Date.now();
  let logContext = { endpoint: "/api/database/query" };

  try {
    const body = await readBody(req);
    const readonlySql = normalizeReadonlySql(body.sql);
    const limitedQuery = limitReadonlySql(readonlySql);
    const pool = await getMysqlPool();

    const [rows, fields] = await pool.query({
      sql: limitedQuery.sql,
      timeout: Number.isFinite(mysqlConfig.queryTimeoutMs) && mysqlConfig.queryTimeoutMs > 0
        ? mysqlConfig.queryTimeoutMs
        : 10000
    });

    const limited = rows.length > limitedQuery.maxRows;
    const visibleRows = serializeRows(rows.slice(0, limitedQuery.maxRows));
    const columns = fields.map((field) => ({
      name: field.name,
      table: field.table || null,
      type: field.type
    }));

    await writeRequestLog({
      ...logContext,
      ok: true,
      durationMs: Date.now() - startedAt,
      rowCount: visibleRows.length,
      limited
    });

    sendJson(res, 200, {
      columns,
      rows: visibleRows,
      rowCount: visibleRows.length,
      limited
    });
  } catch (error) {
    await writeRequestLog({
      ...logContext,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: safeError(error)
    });
    sendJson(res, error.status || 500, {
      error: error.status ? error.message : "MySQL query failed. Please check database configuration, SQL syntax or permissions."
    });
  }
}

async function handleChat(req, res) {
  let logContext = { endpoint: "/api/chat" };
  let upstreamRequest = null;
  let upstreamResponse = null;
  try {
    const body = await readBody(req);
    const providerId = body.provider || "deepseek";
    const provider = providers[providerId];
    logContext = {
      ...logContext,
      provider: providerId,
      model: body.model || provider?.defaultModel,
      stream: body.stream !== false,
      deepThinking: Boolean(body.deepThinking),
      thinkingEffort: normalizeThinkingEffort(body.thinkingEffort),
      messageCount: Array.isArray(body.messages) ? body.messages.length : 0
    };

    if (!provider) {
      sendJson(res, 400, { error: `未知 provider: ${providerId}` });
      return;
    }

    if (!provider.apiKey || !provider.baseUrl) {
      sendJson(res, 400, {
        error: `${provider.label} 尚未配置。请设置对应 API Key 和 Base URL 环境变量。`
      });
      return;
    }

    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!messages.length) {
      sendJson(res, 400, { error: "messages 不能为空。" });
      return;
    }

    const stream = body.stream !== false;
    const deepThinking = Boolean(body.deepThinking);
    const thinkingEffort = normalizeThinkingEffort(body.thinkingEffort);
    const profile = await readUserProfile();
    const upstreamMessages = buildMemoryMessages(messages, profile, deepThinking);
    const upstreamUrl = new URL(provider.path, provider.baseUrl);
    const upstreamRequestBody = {
      model: body.model || provider.defaultModel,
      messages: upstreamMessages,
      temperature: Number(body.temperature ?? 0.7),
      stream,
      ...(deepThinking ? buildThinkingBody(provider, thinkingEffort) : {})
    };
    upstreamRequest = {
      method: "POST",
      url: upstreamUrl.toString(),
      body: upstreamRequestBody
    };
    const upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${provider.apiKey}`
      },
      body: JSON.stringify(upstreamRequestBody)
    });

    if (stream) {
      const contentType = upstream.headers.get("content-type") || "";

      if (!upstream.ok || contentType.includes("text/html")) {
        const { data, rawText, errorMessage } = await parseUpstreamResponse(upstream);
        await writeRequestLog({
          ...logContext,
          ok: false,
          upstreamStatus: upstream.status,
          upstreamContentType: contentType,
          upstreamRequest: {
            method: "POST",
            url: upstreamUrl.toString(),
            body: upstreamRequestBody
          },
          upstreamResponse: {
            status: upstream.status,
            contentType,
            body: data,
            raw: rawText
          },
          error: { message: data?.error?.message || data?.error || errorMessage || "Model stream request failed." },
          details: data || { raw: rawText.slice(0, 500) }
        });
        sendJson(res, upstream.ok ? 502 : upstream.status, {
          error: data?.error?.message || data?.error || errorMessage || "Model stream request failed.",
          details: data || { raw: rawText.slice(0, 500) }
        });
        return;
      }

      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      });

      if (deepThinking) {
        writeSse(res, "thinking", {
          status: "深度思考已开启",
          detail: "正在结合上下文、用户画像和当前问题进行分析"
        });
      }
      const streamResult = await proxyChatStream(upstream, res, { exposeReasoning: deepThinking });
      await updateUserProfile({
        messages,
        assistantContent: streamResult?.content || "",
        provider: providerId,
        model: body.model || provider.defaultModel
      });
      await writeAnswerLog({
        endpoint: "/api/chat",
        provider: providerId,
        model: body.model || provider.defaultModel,
        deepThinking,
        thinkingEffort,
        request: {
          question: getLastUserMessage(messages),
          messages
        },
        response: {
          content: streamResult?.content || "",
          reasoningContent: streamResult?.reasoningContent || ""
        }
      });
      await writeRequestLog({
        ...logContext,
        ok: true,
        upstreamStatus: upstream.status,
        upstreamContentType: contentType,
        streamed: true,
        upstreamRequest: {
          method: "POST",
          url: upstreamUrl.toString(),
          body: upstreamRequestBody
        },
        upstreamResponse: {
          status: upstream.status,
          contentType,
          raw: streamResult?.rawText || "",
          content: streamResult?.content || "",
          reasoningContent: streamResult?.reasoningContent || ""
        },
        memory: { profilePath: userProfilePath }
      });
      return;
    }

    const { data, rawText, errorMessage } = await parseUpstreamResponse(upstream);
    upstreamResponse = {
      status: upstream.status,
      contentType: upstream.headers.get("content-type") || "",
      body: data,
      raw: rawText
    };

    if (!upstream.ok) {
      await writeRequestLog({
        ...logContext,
        ok: false,
        upstreamStatus: upstream.status,
        upstreamContentType: upstreamResponse.contentType,
        upstreamRequest,
        upstreamResponse,
        error: { message: data?.error?.message || data?.error || errorMessage || "模型服务请求失败。" },
        details: data || { raw: rawText.slice(0, 500) }
      });
      sendJson(res, upstream.status, {
        error: data?.error?.message || data?.error || errorMessage || "模型服务请求失败。",
        details: data || { raw: rawText.slice(0, 500) }
      });
      return;
    }

    if (!data?.choices?.[0]?.message?.content) {
      await writeRequestLog({
        ...logContext,
        ok: false,
        upstreamStatus: upstream.status,
        upstreamContentType: upstreamResponse.contentType,
        upstreamRequest,
        upstreamResponse,
        error: { message: errorMessage || "模型服务没有返回有效的聊天内容，请检查模型名称和接口格式。" },
        details: data || { raw: rawText.slice(0, 500) }
      });
      sendJson(res, 502, {
        error: errorMessage || "模型服务没有返回有效的聊天内容，请检查模型名称和接口格式。",
        details: data || { raw: rawText.slice(0, 500) }
      });
      return;
    }

    const assistantContent = extractAssistantContent(data);
    upstreamResponse = {
      status: upstream.status,
      contentType: upstream.headers.get("content-type") || "",
      body: data,
      raw: rawText
    };
    sendJson(res, 200, {
      provider: providerId,
      model: data.model || body.model || provider.defaultModel,
      content: assistantContent,
      usage: data.usage || null
    });
    await updateUserProfile({
      messages,
      assistantContent,
      provider: providerId,
      model: data.model || body.model || provider.defaultModel
    });
    await writeAnswerLog({
      endpoint: "/api/chat",
      provider: providerId,
      model: data.model || body.model || provider.defaultModel,
      deepThinking,
      thinkingEffort,
      request: {
        question: getLastUserMessage(messages),
        messages
      },
      response: {
        content: assistantContent,
        reasoningContent: data.choices?.[0]?.message?.reasoning_content || ""
      }
    });
    await writeRequestLog({
      ...logContext,
      ok: true,
      upstreamStatus: upstream.status,
      model: data.model || body.model || provider.defaultModel,
      usage: data.usage || null,
      upstreamRequest,
      upstreamResponse,
      memory: { profilePath: userProfilePath }
    });
  } catch (error) {
    await writeRequestLog({
      ...logContext,
      ok: false,
      error: safeError(error),
      upstreamRequest,
      upstreamResponse
    });
    sendJson(res, 500, { error: modelFetchErrorMessage(error) });
  }
}

async function serveStatic(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(requestUrl.pathname);
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(publicDir, safePath));

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const file = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "content-type": mimeTypes[ext] || "application/octet-stream",
      "cache-control": "no-store, no-cache, must-revalidate, private"
    });
    res.end(file);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url?.startsWith("/api/providers")) {
    sendJson(res, 200, Object.keys(providers).map(publicProvider));
    return;
  }

  if (req.method === "GET" && req.url === "/api/database/status") {
    await handleDatabaseStatus(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/chat") {
    await handleChat(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/nl2sql") {
    await handleNl2Sql(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/database/query") {
    await handleDatabaseQuery(req, res);
    return;
  }

  if (req.method === "GET") {
    await serveStatic(req, res);
    return;
  }

  res.writeHead(405, { allow: "GET, POST" });
  res.end("Method not allowed");
});

server.listen(port, () => {
  console.log(`AI chat server running at http://localhost:${port}`);
});
