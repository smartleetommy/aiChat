import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 3000);

await loadDotEnv(path.join(__dirname, ".env"));

const providers = {
  deepseek: {
    label: "DeepSeek",
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    path: "/chat/completions",
    defaultModel: process.env.DEEPSEEK_MODEL || "deepseek-chat"
  },
  glm: {
    label: "GLM",
    apiKey: process.env.GLM_API_KEY,
    baseUrl: process.env.GLM_BASE_URL || "https://open.bigmodel.cn/api/paas/v4",
    path: "/chat/completions",
    defaultModel: process.env.GLM_MODEL || "glm-4-plus"
  },
  custom: {
    label: "Custom",
    apiKey: process.env.CUSTOM_API_KEY,
    baseUrl: process.env.CUSTOM_BASE_URL,
    path: process.env.CUSTOM_CHAT_PATH || "/chat/completions",
    defaultModel: process.env.CUSTOM_MODEL || "gpt-compatible-model"
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
    defaultModel: providers[provider].defaultModel
  };
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
        stream: false
      })
    });

    const text = await upstream.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }

    if (!upstream.ok) {
      sendJson(res, upstream.status, {
        error: data?.error?.message || data?.error || "模型服务请求失败。",
        details: data
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
