import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 3000);

await loadDotEnv(path.join(__dirname, ".env"));

function parseModelList(value, fallback) {
  const models = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return models.length ? models : fallback;
}

const providers = {
  deepseek: {
    label: "DeepSeek",
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    path: "/chat/completions",
    defaultModel: process.env.DEEPSEEK_MODEL || "deepseek-chat",
    models: parseModelList(process.env.DEEPSEEK_MODELS, ["deepseek-chat", "deepseek-reasoner"])
  },
  glm: {
    label: "GLM",
    apiKey: process.env.GLM_API_KEY,
    baseUrl: process.env.GLM_BASE_URL || "https://open.bigmodel.cn/api/paas/v4",
    path: "/chat/completions",
    defaultModel: process.env.GLM_MODEL || "glm-4-plus",
    models: parseModelList(process.env.GLM_MODELS, ["glm-4-plus", "glm-4-air", "glm-4-flash", "glm-4-long"])
  },
  custom: {
    label: "Custom",
    apiKey: process.env.CUSTOM_API_KEY,
    baseUrl: process.env.CUSTOM_BASE_URL,
    path: process.env.CUSTOM_CHAT_PATH || "/chat/completions",
    defaultModel: process.env.CUSTOM_MODEL || "gpt-compatible-model",
    models: parseModelList(process.env.CUSTOM_MODELS, [process.env.CUSTOM_MODEL || "gpt-compatible-model"])
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

async function proxyChatStream(upstream, res) {
  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";

  for await (const chunk of upstream.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    for (const line of lines) {
      const payload = parseStreamLine(line);
      if (!payload) continue;
      if (payload.done) {
        writeSse(res, "done", { content: fullContent });
        res.end();
        return;
      }

      if (payload.error) {
        writeSse(res, "error", { error: payload.error });
        continue;
      }

      const delta = payload.choices?.[0]?.delta?.content || payload.choices?.[0]?.message?.content || "";
      if (delta) {
        fullContent += delta;
        writeSse(res, "delta", { content: delta });
      }
    }
  }

  writeSse(res, "done", { content: fullContent });
  res.end();
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
  const upstream = await fetch(upstreamUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${provider.apiKey}`
    },
    body: JSON.stringify({
      model: model || provider.defaultModel,
      messages,
      temperature: Number(temperature ?? 0.2),
      stream: false
    })
  });

  const { data, rawText, errorMessage } = await parseUpstreamResponse(upstream);

  if (!upstream.ok) {
    const error = new Error(data?.error?.message || data?.error || errorMessage || "Model request failed.");
    error.status = upstream.status;
    error.details = data || { raw: rawText.slice(0, 500) };
    throw error;
  }

  if (!data?.choices?.[0]?.message?.content) {
    const error = new Error(errorMessage || "模型服务没有返回有效的聊天内容，请检查模型名称和接口格式。");
    error.status = 502;
    error.details = data || { raw: rawText.slice(0, 500) };
    throw error;
  }

  return {
    content: data.choices?.[0]?.message?.content || "",
    model: data.model || model || provider.defaultModel,
    usage: data.usage || null
  };
}

async function handleNl2Sql(req, res) {
  try {
    const body = await readBody(req);
    const question = String(body.question || "").trim();
    const schema = String(body.schema || "").trim();
    const dialect = String(body.dialect || "MySQL").trim();

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
  } catch (error) {
    sendJson(res, error.status || 500, {
      error: error.message || "NL2SQL request failed.",
      details: error.details || null
    });
  }
}

async function handleChat(req, res) {
  try {
    const body = await readBody(req);
    const providerId = body.provider || "deepseek";
    const provider = providers[providerId];

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
    const upstreamUrl = new URL(provider.path, provider.baseUrl);
    const upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${provider.apiKey}`
      },
      body: JSON.stringify({
        model: body.model || provider.defaultModel,
        messages,
        temperature: Number(body.temperature ?? 0.7),
        stream
      })
    });

    if (stream) {
      const contentType = upstream.headers.get("content-type") || "";

      if (!upstream.ok || contentType.includes("text/html")) {
        const { data, rawText, errorMessage } = await parseUpstreamResponse(upstream);
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

      await proxyChatStream(upstream, res);
      return;
    }

    const { data, rawText, errorMessage } = await parseUpstreamResponse(upstream);

    if (!upstream.ok) {
      sendJson(res, upstream.status, {
        error: data?.error?.message || data?.error || errorMessage || "模型服务请求失败。",
        details: data || { raw: rawText.slice(0, 500) }
      });
      return;
    }

    if (!data?.choices?.[0]?.message?.content) {
      sendJson(res, 502, {
        error: errorMessage || "模型服务没有返回有效的聊天内容，请检查模型名称和接口格式。",
        details: data || { raw: rawText.slice(0, 500) }
      });
      return;
    }

    sendJson(res, 200, {
      provider: providerId,
      model: data.model || body.model || provider.defaultModel,
      content: data.choices?.[0]?.message?.content || "",
      usage: data.usage || null
    });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "服务器内部错误。" });
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
    res.writeHead(200, { "content-type": mimeTypes[ext] || "application/octet-stream" });
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

  if (req.method === "POST" && req.url === "/api/chat") {
    await handleChat(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/nl2sql") {
    await handleNl2Sql(req, res);
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
