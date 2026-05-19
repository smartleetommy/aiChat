const providerSelect = document.querySelector("#providerSelect");
const modelInput = document.querySelector("#modelInput");
const messagesEl = document.querySelector("#messages");
const chatForm = document.querySelector("#chatForm");
const promptInput = document.querySelector("#promptInput");
const sendButton = document.querySelector("#sendButton");
const chatList = document.querySelector("#chatList");
const newChatButton = document.querySelector("#newChatButton");
const settingsButton = document.querySelector("#settingsButton");
const settingsDialog = document.querySelector("#settingsDialog");
const temperatureInput = document.querySelector("#temperatureInput");
const temperatureValue = document.querySelector("#temperatureValue");
const suggestions = document.querySelector("#suggestions");
const statusDot = document.querySelector("#statusDot");
const providerStatus = document.querySelector("#providerStatus");
const menuButton = document.querySelector("#menuButton");
const sidebar = document.querySelector(".sidebar");
const ideButton = document.querySelector("#ideButton");
const closeIdeButton = document.querySelector("#closeIdeButton");
const ideDrawer = document.querySelector("#ideDrawer");
const ideBackdrop = document.querySelector("#ideBackdrop");
const sqlDialect = document.querySelector("#sqlDialect");
const schemaInput = document.querySelector("#schemaInput");
const sqlQuestionInput = document.querySelector("#sqlQuestionInput");
const generateSqlButton = document.querySelector("#generateSqlButton");
const sqlOutput = document.querySelector("#sqlOutput");
const dataInput = document.querySelector("#dataInput");
const renderChartButton = document.querySelector("#renderChartButton");
const chartSummary = document.querySelector("#chartSummary");
const chartCanvas = document.querySelector("#chartCanvas");

const state = {
  chats: [],
  activeId: null,
  providers: [],
  loading: false,
  copyIndex: 0,
  copyTimer: null
};

const heroCopies = [
  "把灵感、资料和复杂问题丢进来，让合适的模型接住下一步。",
  "DeepSeek 适合推理，GLM 擅长中文表达，自定义接口留给你的私有模型。",
  "密钥留在后端，浏览器只负责对话、切换模型和保存会话。",
  "从一句想法开始，生成方案、代码、摘要、文案和可继续追问的答案。"
];

function createChat() {
  const chat = {
    id: crypto.randomUUID(),
    title: "新的对话",
    messages: []
  };
  state.chats.unshift(chat);
  state.activeId = chat.id;
  saveChats();
  render();
}

function getActiveChat() {
  return state.chats.find((chat) => chat.id === state.activeId);
}

function saveChats() {
  localStorage.setItem("ai-console-chats", JSON.stringify({
    activeId: state.activeId,
    chats: state.chats
  }));
}

function loadChats() {
  const stored = localStorage.getItem("ai-console-chats");
  if (!stored) {
    createChat();
    return;
  }

  try {
    const parsed = JSON.parse(stored);
    state.chats = Array.isArray(parsed.chats) ? parsed.chats : [];
    state.activeId = parsed.activeId || state.chats[0]?.id || null;
  } catch {
    state.chats = [];
    state.activeId = null;
  }

  if (!state.chats.length) createChat();
}

async function loadProviders() {
  try {
    const response = await fetch("/api/providers");
    state.providers = await response.json();
    providerSelect.innerHTML = "";

    state.providers.forEach((provider) => {
      const option = document.createElement("option");
      option.value = provider.id;
      option.textContent = `${provider.label}${provider.configured ? "" : "（未配置）"}`;
      providerSelect.append(option);
    });

    const configured = state.providers.filter((provider) => provider.configured);
    providerStatus.textContent = configured.length
      ? `已配置 ${configured.map((provider) => provider.label).join(" / ")}`
      : "尚未配置 API Key";
    statusDot.classList.toggle("ready", Boolean(configured.length));
    syncModelInput();
  } catch {
    providerStatus.textContent = "后端连接失败";
    statusDot.classList.remove("ready");
  }
}

function syncModelInput() {
  const provider = state.providers.find((item) => item.id === providerSelect.value);
  const models = provider?.models?.length ? provider.models : [provider?.defaultModel].filter(Boolean);
  modelInput.innerHTML = "";

  models.forEach((model) => {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    modelInput.append(option);
  });

  modelInput.value = provider?.defaultModel || models[0] || "";
}

function render() {
  renderChatList();
  renderMessages();
}

function renderChatList() {
  chatList.innerHTML = "";
  state.chats.forEach((chat) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = chat.title;
    button.className = chat.id === state.activeId ? "active" : "";
    button.addEventListener("click", () => {
      state.activeId = chat.id;
      saveChats();
      render();
      sidebar.classList.remove("open");
    });
    chatList.append(button);
  });
}

function renderMessages() {
  const chat = getActiveChat();
  messagesEl.innerHTML = "";

  if (!chat?.messages.length) {
    startHeroCopyCarousel();
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `
      <div>
        <h1>把问题交给合适的模型。</h1>
        <p class="hero-copy" id="heroCopy">${heroCopies[state.copyIndex]}</p>
        <div class="copy-dots" aria-label="创意文案轮播">
          ${heroCopies.map((_, index) => `<span class="${index === state.copyIndex ? "active" : ""}"></span>`).join("")}
        </div>
      </div>
    `;
    messagesEl.append(empty);
    suggestions.hidden = false;
    return;
  }

  stopHeroCopyCarousel();
  suggestions.hidden = true;
  chat.messages.forEach((message) => {
    messagesEl.append(createMessageNode(message));
  });
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function startHeroCopyCarousel() {
  if (state.copyTimer) return;
  state.copyTimer = setInterval(() => {
    const copy = document.querySelector("#heroCopy");
    const dots = document.querySelectorAll(".copy-dots span");
    if (!copy || !dots.length) return;

    state.copyIndex = (state.copyIndex + 1) % heroCopies.length;
    copy.classList.remove("copy-enter");
    copy.classList.add("copy-exit");

    window.setTimeout(() => {
      copy.textContent = heroCopies[state.copyIndex];
      copy.classList.remove("copy-exit");
      copy.classList.add("copy-enter");
      dots.forEach((dot, index) => dot.classList.toggle("active", index === state.copyIndex));
    }, 180);
  }, 3200);
}

function stopHeroCopyCarousel() {
  if (!state.copyTimer) return;
  clearInterval(state.copyTimer);
  state.copyTimer = null;
}

function createMessageNode(message) {
  const item = document.createElement("article");
  item.className = `message ${message.role}${message.error ? " error" : ""}`;

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  if (message.role === "assistant") {
    const img = document.createElement("img");
    img.src = "/assets/assistant-avatar.png";
    img.alt = "问答助手头像";
    avatar.append(img);
  } else {
    avatar.textContent = "你";
  }

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  if (message.pending) {
    bubble.innerHTML = `<span class="typing"><span></span><span></span><span></span></span>`;
  } else {
    bubble.textContent = message.content;
  }

  item.append(avatar, bubble);
  return item;
}

function autoResizeInput() {
  promptInput.style.height = "auto";
  promptInput.style.height = `${Math.min(promptInput.scrollHeight, 180)}px`;
}

async function sendMessage(content) {
  const chat = getActiveChat();
  if (!chat || state.loading || !content.trim()) return;

  const firstUserMessage = chat.messages.length === 0;
  chat.messages.push({ role: "user", content: content.trim() });
  if (firstUserMessage) {
    chat.title = content.trim().slice(0, 28);
  }

  const pending = { role: "assistant", content: "", pending: true };
  chat.messages.push(pending);
  state.loading = true;
  sendButton.disabled = true;
  promptInput.value = "";
  autoResizeInput();
  saveChats();
  render();

  try {
    const apiMessages = chat.messages
      .filter((message) => !message.pending && !message.error)
      .map(({ role, content }) => ({ role, content }));

    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: providerSelect.value,
        model: modelInput.value.trim(),
        temperature: temperatureInput.value,
        messages: apiMessages
      })
    });

    const data = await response.json();
    pending.pending = false;
    pending.content = response.ok ? data.content : data.error;
    pending.error = !response.ok;
  } catch (error) {
    pending.pending = false;
    pending.error = true;
    pending.content = error.message || "请求失败，请检查后端服务。";
  } finally {
    state.loading = false;
    sendButton.disabled = false;
    saveChats();
    render();
  }
}

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage(promptInput.value);
});

promptInput.addEventListener("input", autoResizeInput);
promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});

providerSelect.addEventListener("change", syncModelInput);
newChatButton.addEventListener("click", createChat);
settingsButton.addEventListener("click", () => settingsDialog.showModal());
temperatureInput.addEventListener("input", () => {
  temperatureValue.value = temperatureInput.value;
});
menuButton.addEventListener("click", () => sidebar.classList.toggle("open"));
ideButton.addEventListener("click", openIde);
closeIdeButton.addEventListener("click", closeIde);
ideBackdrop.addEventListener("click", closeIde);
generateSqlButton.addEventListener("click", generateSql);
renderChartButton.addEventListener("click", renderDataChart);

function openIde() {
  ideDrawer.classList.add("open");
  ideDrawer.setAttribute("aria-hidden", "false");
  ideBackdrop.hidden = false;
}

function closeIde() {
  ideDrawer.classList.remove("open");
  ideDrawer.setAttribute("aria-hidden", "true");
  ideBackdrop.hidden = true;
}

async function generateSql() {
  const question = sqlQuestionInput.value.trim();
  if (!question) {
    sqlOutput.textContent = "请先输入你想分析的问题。";
    return;
  }

  generateSqlButton.disabled = true;
  sqlOutput.textContent = "正在生成 SQL...";

  try {
    const response = await fetch("/api/nl2sql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: providerSelect.value,
        model: modelInput.value.trim(),
        temperature: 0.2,
        dialect: sqlDialect.value,
        schema: schemaInput.value.trim(),
        question
      })
    });
    const data = await response.json();
    sqlOutput.textContent = response.ok ? data.sql : data.error;
  } catch (error) {
    sqlOutput.textContent = error.message || "生成 SQL 失败，请检查后端服务。";
  } finally {
    generateSqlButton.disabled = false;
  }
}

function parseTabularData(raw) {
  const text = raw.trim();
  if (!text) return [];

  if (text.startsWith("[") || text.startsWith("{")) {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.rows)) return parsed.rows;
    return [parsed];
  }

  const lines = text.split(/\r?\n/).filter(Boolean);
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = splitCsvLine(line);
    return headers.reduce((row, header, index) => {
      row[header] = coerceValue(values[index]);
      return row;
    }, {});
  });
}

function splitCsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;

  for (const char of line) {
    if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(coerceValue(cell.trim()));
      cell = "";
    } else {
      cell += char;
    }
  }

  cells.push(coerceValue(cell.trim()));
  return cells;
}

function coerceValue(value) {
  if (value === undefined || value === "") return "";
  const numeric = Number(value);
  return Number.isFinite(numeric) && value !== "" ? numeric : value;
}

function inferChart(rows) {
  const sample = rows[0] || {};
  const columns = Object.keys(sample);
  const numericColumns = columns.filter((column) => rows.some((row) => Number.isFinite(Number(row[column]))));
  const textColumns = columns.filter((column) => !numericColumns.includes(column));
  const dateColumn = columns.find((column) => rows.some((row) => !Number.isNaN(Date.parse(row[column]))));
  const categoryColumn = dateColumn || textColumns[0] || columns[0];
  const valueColumn = numericColumns[0];
  const uniqueCategories = new Set(rows.map((row) => row[categoryColumn])).size;

  let type = "table";
  if (dateColumn && valueColumn) type = "line";
  else if (valueColumn && uniqueCategories > 1 && uniqueCategories <= 6 && rows.length <= 8) type = "pie";
  else if (valueColumn && categoryColumn) type = "bar";

  return { type, categoryColumn, valueColumn, columns };
}

function renderDataChart() {
  try {
    const rows = parseTabularData(dataInput.value);
    if (!rows.length) {
      chartSummary.textContent = "请先粘贴 JSON 或 CSV 数据。";
      chartCanvas.innerHTML = "";
      return;
    }

    const chart = inferChart(rows);
    chartSummary.textContent = `已识别 ${rows.length} 行数据，推荐 ${chart.type.toUpperCase()} 图表。`;
    chartCanvas.innerHTML = createChartMarkup(rows, chart);
  } catch (error) {
    chartSummary.textContent = error.message || "数据解析失败。";
    chartCanvas.innerHTML = "";
  }
}

function createChartMarkup(rows, chart) {
  if (!chart.valueColumn || chart.type === "table") return createTableMarkup(rows, chart.columns);
  if (chart.type === "line") return createLineChart(rows, chart);
  if (chart.type === "pie") return createPieChart(rows, chart);
  return createBarChart(rows, chart);
}

function createTableMarkup(rows, columns) {
  const head = columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("");
  const body = rows.slice(0, 8).map((row) => (
    `<tr>${columns.map((column) => `<td>${escapeHtml(row[column])}</td>`).join("")}</tr>`
  )).join("");
  return `<table class="data-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function createBarChart(rows, chart) {
  const values = rows.map((row) => Number(row[chart.valueColumn]) || 0);
  const max = Math.max(...values, 1);
  const bars = rows.slice(0, 10).map((row, index) => {
    const value = Number(row[chart.valueColumn]) || 0;
    const height = Math.max(6, (value / max) * 150);
    const x = 34 + index * 44;
    const y = 178 - height;
    return `
      <g>
        <rect x="${x}" y="${y}" width="26" height="${height}" rx="4"></rect>
        <text x="${x + 13}" y="198">${escapeHtml(row[chart.categoryColumn])}</text>
      </g>
    `;
  }).join("");
  return `<svg class="chart-svg bar-chart" viewBox="0 0 500 220" role="img">${bars}</svg>`;
}

function createLineChart(rows, chart) {
  const values = rows.map((row) => Number(row[chart.valueColumn]) || 0);
  const max = Math.max(...values, 1);
  const points = rows.slice(0, 12).map((row, index, list) => {
    const value = Number(row[chart.valueColumn]) || 0;
    const x = 28 + index * (430 / Math.max(list.length - 1, 1));
    const y = 178 - (value / max) * 145;
    return `${x},${y}`;
  });
  const dots = points.map((point) => {
    const [x, y] = point.split(",");
    return `<circle cx="${x}" cy="${y}" r="4"></circle>`;
  }).join("");
  return `<svg class="chart-svg line-chart" viewBox="0 0 500 220" role="img"><polyline points="${points.join(" ")}"></polyline>${dots}</svg>`;
}

function createPieChart(rows, chart) {
  const total = rows.reduce((sum, row) => sum + (Number(row[chart.valueColumn]) || 0), 0) || 1;
  let offset = 0;
  const palette = ["#0f766e", "#c6533b", "#d69d2f", "#345c7c", "#7b5a9a", "#5f7a45"];
  const slices = rows.slice(0, 6).map((row, index) => {
    const value = Number(row[chart.valueColumn]) || 0;
    const percent = value / total;
    const dash = `${percent * 100} ${100 - percent * 100}`;
    const slice = `<circle r="56" cx="95" cy="85" fill="transparent" stroke="${palette[index % palette.length]}" stroke-width="42" stroke-dasharray="${dash}" stroke-dashoffset="${-offset}"></circle>`;
    offset += percent * 100;
    return slice;
  }).join("");
  const legend = rows.slice(0, 6).map((row, index) => (
    `<span><i style="background:${palette[index % palette.length]}"></i>${escapeHtml(row[chart.categoryColumn])}</span>`
  )).join("");
  return `<div class="pie-wrap"><svg class="chart-svg pie-chart" viewBox="0 0 190 170" role="img">${slices}</svg><div class="pie-legend">${legend}</div></div>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

suggestions.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  promptInput.value = button.textContent;
  autoResizeInput();
  promptInput.focus();
});

loadChats();
render();
loadProviders();
