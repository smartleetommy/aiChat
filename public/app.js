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
      option.dataset.model = provider.defaultModel;
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
  const option = providerSelect.selectedOptions[0];
  modelInput.value = option?.dataset.model || "";
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
  avatar.textContent = message.role === "assistant" ? "AI" : "你";

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
