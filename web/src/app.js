import "./style.css";
import { $, node, icon, icons, messageNode, dayLabel } from "./ui.js";
import { ApiError, request, events, delay, errorText } from "./api.js";
import { createImageViewer } from "./image-viewer.js";
import { customEmoji } from "./media.js";
import { initSidebarResize } from "./sidebar.js";

icons();
const imageViewer = createImageViewer(() => $("message-input"));
let showEmoji = true;
function emojiToggle() {
  $("emoji-toggle").setAttribute("aria-pressed", String(showEmoji));
  $("emoji-toggle").title = showEmoji ? "自訂表情符號：顯示（點擊關閉）" : "自訂表情符號：隱藏（點擊顯示）";
}
$("emoji-toggle").onclick = () => {
  showEmoji = !showEmoji;
  emojiToggle();
  imageViewer.close();
  if (active) drawMessages(active);
};
emojiToggle();
function previewItems() {
  const unique = new Map();
  for (const button of $("messages").querySelectorAll("[data-preview-src]")) {
    const { previewSrc: src, previewHref: href, previewLabel: label } = button.dataset;
    if (!unique.has(src)) unique.set(src, { src, href, label });
  }
  return [...unique.values()];
}
$("messages").addEventListener("click", (event) => {
  const button = event.target.closest("[data-preview-src]");
  if (button) imageViewer.show(previewItems(), button.dataset.previewSrc, button);
});
let user = null,
  guilds = [],
  channels = [],
  active = null,
  lifetime = new AbortController(),
  navigation = null;
let emojiRequest = null, emojiItems = [], emojiState = null, emojiSelection = [0, 0];
function closeEmojiPicker() {
  emojiRequest?.abort();
  emojiRequest = null;
  emojiItems = [];
  emojiState = null;
  $("emoji-picker-items").replaceChildren();
  $("emoji-search").value = "";
  $("emoji-picker-status").textContent = "";
  $("emoji-picker").close();
}
$("emoji-picker").addEventListener("close", () => {
  if (!$("emoji-picker").open) closeEmojiPicker();
});
function drawEmojiPicker() {
  const query = $("emoji-search").value.trim().toLocaleLowerCase();
  const items = emojiItems.filter(item => item.name.toLocaleLowerCase().includes(query));
  $("emoji-picker-items").replaceChildren(...items.map(item => {
    const token = `<${item.animated ? "a" : ""}:${item.name}:${item.id}>`;
    const emoji = customEmoji(token);
    if (!emoji) return node("span");
    const button = node("button", "emoji-choice");
    button.type = "button";
    button.setAttribute("aria-label", `插入 :${item.name}:`);
    button.title = `${item.name}${item.animated ? " · 動畫" : ""}`;
    if (showEmoji) {
      const image = node("img");
      image.alt = ""; image.loading = "lazy"; image.referrerPolicy = "no-referrer";
      image.onerror = () => image.remove();
      image.src = emoji.url;
      button.append(image);
    }
    button.append(node("span", "", `:${item.name}:`));
    button.onclick = () => {
      if (active !== emojiState || !active?.channel.can_send || active.sending || active.revoked) return;
      const input = $("message-input");
      const [start, end] = emojiSelection, insertion = token + " ";
      const result = input.value.slice(0, start) + insertion + input.value.slice(end);
      if (Array.from(result).length > 1800) return toast("訊息超過 1800 字，請先縮短內容。");
      input.setRangeText(insertion, start, end, "end");
      rememberDraft(); updateComposer(); closeEmojiPicker(); input.focus();
    };
    return button;
  }));
  $("emoji-picker-status").textContent = items.length ? `${items.length} 個可用表情符號`
    : emojiItems.length ? "找不到符合的表情符號" : "這個伺服器目前沒有你與 bot 都可使用的表情符號。";
}
$("emoji-search").oninput = drawEmojiPicker;
$("open-emoji-picker").onclick = async () => {
  if (!active?.channel.can_send || active.sending || active.revoked) return;
  closeEmojiPicker();
  emojiState = active;
  emojiSelection = [$("message-input").selectionStart, $("message-input").selectionEnd];
  const state = emojiState, controller = emojiRequest = new AbortController();
  $("emoji-picker-status").textContent = "載入中…";
  $("emoji-picker").showModal(); $("emoji-search").focus();
  try {
    const data = await request(`/channels/${state.channel.id}/emojis`, undefined, controller.signal);
    if (controller.signal.aborted || active !== state) return;
    emojiItems = data.emojis;
    drawEmojiPicker();
  } catch (error) {
    if (controller.signal.aborted) return;
    if (authError(error)) return;
    if ([403, 404].includes(error.status)) return denied(state, errorText(error));
    $("emoji-picker-status").textContent = errorText(error);
  }
};
const drafts = new Map();
let toastTimer;
function toast(text) {
  $("toast").textContent = text;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 5000);
}
function notice(text) {
  $("chat-notice").textContent = text;
  $("chat-notice").hidden = !text;
}
function status(text, state = "") {
  const el = $("connection");
  el.lastElementChild.textContent = text;
  el.dataset.state = state;
}
function mobile(open) {
  if (narrow.matches) document.body.classList.toggle("sidebar-open", open);
  else document.body.classList.toggle("sidebar-collapsed", !open);
  $("sidebar-scrim").hidden = !open || !narrow.matches;
  $("open-sidebar").setAttribute("aria-expanded", String(open));
  sidebarAccessibility();
  if (open) $("close-sidebar").focus();
  else $("open-sidebar").focus();
}
const narrow = matchMedia("(max-width:700px)");
initSidebarResize($("sidebar"), $("sidebar-resizer"), document.querySelector(".app-rail"), narrow);
function sidebarAccessibility() {
  const open = document.body.classList.contains("sidebar-open");
  $("sidebar").inert = narrow.matches
    ? !open
    : document.body.classList.contains("sidebar-collapsed");
  document.querySelector(".main-panel").inert = narrow.matches && open;
}
narrow.addEventListener("change", () => {
  if (!narrow.matches) {
    document.body.classList.remove("sidebar-open");
    $("sidebar-scrim").hidden = true;
    $("open-sidebar").setAttribute("aria-expanded", "false");
  }
  sidebarAccessibility();
});
sidebarAccessibility();
$("open-sidebar").onclick = () => mobile(true);
$("choose-channel").onclick = () => mobile(true);
$("close-sidebar").onclick = $("sidebar-scrim").onclick = () => mobile(false);
function openLogin() {
  if (document.body.classList.contains("sidebar-open")) mobile(false);
  if (!$("login-dialog").open) $("login-dialog").showModal();
  $("username").focus();
}
$("login-open").onclick =
  $("start-login").onclick =
  $("home-login").onclick =
    openLogin;
$("login-dialog").addEventListener("close", () => {
  $("password").value = "";
});
function view(mode) {
  if (mode === "channels" && !user) return openLogin();
  if (mode !== "chat") imageViewer.close();
  if (mode !== "chat") closeEmojiPicker();
  document.body.dataset.view = mode;
  $("login-view").hidden = !!user;
  $("empty-view").hidden = !user || (mode === "chat" && !!active);
  $("chat-view").hidden = mode !== "chat" || !active;
  $("view-chat").setAttribute("aria-pressed", String(mode !== "channels"));
  $("view-channels").setAttribute("aria-pressed", String(mode === "channels"));
  $("empty-title").textContent =
    mode === "channels" ? "選擇要聊天的頻道" : "今天，想聊些什麼？";
  $("rail-home").classList.toggle("selected", mode !== "channels");
  $("rail-channels").classList.toggle("selected", mode === "channels");
  renderSuggestions();
  if (!$("chat-view").hidden) {
    drawMessages(active, true);
    updateComposer();
  }
}
function home() {
  view("home");
  if (document.body.classList.contains("sidebar-open")) mobile(false);
}
function searchChannels() {
  if (!user) return openLogin();
  mobile(true);
  $("channel-search").focus();
}
$("rail-home").onclick =
  $("sidebar-home").onclick =
  $("new-chat").onclick =
    home;
$("rail-channels").onclick = $("view-channels").onclick = () =>
  view("channels");
$("view-chat").onclick = () => view(active ? "chat" : "home");
$("rail-search").onclick = $("sidebar-search").onclick = searchChannels;
$("composer-tools").onclick = $("composer-context").onclick = () =>
  view("channels");
document.addEventListener("keydown", (event) => {
  if (
    event.key === "Escape" &&
    document.body.classList.contains("sidebar-open")
  )
    mobile(false);
  if (
    event.key === "/" &&
    user &&
    !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName) &&
    !document.querySelector("dialog[open]")
  ) {
    event.preventDefault();
    searchChannels();
  }
});
let dark = matchMedia("(prefers-color-scheme: dark)").matches;
function theme() {
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  $("theme-button").replaceChildren(icon(dark ? "sun" : "moon"));
  $("theme-button").setAttribute(
    "aria-label",
    dark ? "切換淺色模式" : "切換深色模式",
  );
  $("theme-button").title = $("theme-button").getAttribute("aria-label");
}
$("theme-button").onclick = () => {
  dark = !dark;
  theme();
};
theme();
$("show-password").onclick = () => {
  const show = $("password").type === "password";
  $("password").type = show ? "text" : "password";
  $("show-password").setAttribute("aria-label", show ? "隱藏密碼" : "顯示密碼");
};
$("privacy-button").onclick = () => $("privacy-dialog").showModal();
$("sidebar-privacy").onclick = $("privacy-button").onclick;
document
  .querySelectorAll(".dialog-close")
  .forEach(
    (button) => (button.onclick = () => button.closest("dialog").close()),
  );
$("account-button").onclick = () => {
  if (!user) return openLogin();
  $("account-details").textContent =
    `${user.username} · Discord ${user.discord_id}`;
  $("account-dialog").showModal();
};
$("top-account-button").onclick = $("account-button").onclick;
const broadcast =
  typeof BroadcastChannel === "function"
    ? new BroadcastChannel("guildport-session")
    : null;
if (broadcast)
  broadcast.onmessage = () =>
    reset("帳號登入狀態已在另一個視窗變更，請重新登入。");
function stopChannel() {
  imageViewer.close();
  closeEmojiPicker();
  if (active) {
    active.controller.abort();
    clearTimeout(active.refreshTimer);
  }
  active = null;
}
function reset(message = "") {
  lifetime.abort();
  lifetime = new AbortController();
  navigation?.abort();
  stopChannel();
  user = null;
  guilds = [];
  channels = [];
  drafts.clear();
  document.body.dataset.session = "signed-out";
  $("login-open").hidden = false;
  $("top-account-button").hidden = true;
  $("emoji-toggle").hidden = true;
  $("home-channel-search").value = "";
  $("home-channels").replaceChildren();
  $("login-view").hidden = false;
  $("empty-view").hidden = $("chat-view").hidden = true;
  $("messages").replaceChildren();
  $("message-input").value = "";
  $("message-input").disabled = true;
  $("send-button").disabled = true;
  $("channels").replaceChildren(
    node("p", "nav-empty", "登入後，你的頻道會出現在這裡。"),
  );
  $("guild-select").replaceChildren(new Option("登入後選擇伺服器", ""));
  $("guild-select").disabled = true;
  $("channel-search").value = "";
  $("channel-search").disabled = $("refresh-channels").disabled = true;
  $("account-name").textContent = "尚未登入";
  $("account-avatar").textContent = "G";
  $("header-title").textContent = "GuildPort";
  $("header-subtitle").textContent = "你的社群，隨時連線";
  status("等待登入");
  notice("");
  $("login-error").textContent = message;
  $("login-error").hidden = !message;
  $("password").value = "";
  document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
  document.body.classList.remove("sidebar-open");
  $("sidebar-scrim").hidden = true;
  $("open-sidebar").setAttribute("aria-expanded", "false");
  sidebarAccessibility();
  view("home");
  if (message) openLogin();
}
function authError(error) {
  if (error.status === 401) {
    reset(errorText(error));
    return true;
  }
  return false;
}
async function signedIn(me) {
  user = me;
  document.body.dataset.session = "signed-in";
  $("login-open").hidden = true;
  $("top-account-button").hidden = false;
  $("emoji-toggle").hidden = false;
  $("login-dialog").close();
  view("home");
  $("login-view").hidden = true;
  $("empty-view").hidden = false;
  $("account-name").textContent = me.username;
  $("account-avatar").textContent = me.username.slice(0, 1).toUpperCase();
  $("account-button").disabled = false;
  $("refresh-channels").disabled = false;
  status("已登入");
  await loadGuilds();
}
$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("login-submit").disabled = true;
  $("login-error").hidden = true;
  const signal = lifetime.signal;
  try {
    const result = await request(
      "/login",
      { username: $("username").value.trim(), password: $("password").value },
      signal,
    );
    if (signal.aborted) return;
    $("password").value = "";
    broadcast?.postMessage("session-changed");
    await signedIn({ ...result.user, expires_at: result.expires_at });
  } catch (error) {
    if (!signal.aborted) {
      $("login-error").textContent = errorText(error);
      $("login-error").hidden = false;
    }
  } finally {
    $("login-submit").disabled = false;
  }
});
async function logout(all = false) {
  if (active?.sending) {
    toast("訊息正在送出，請稍候再登出。");
    return;
  }
  $("logout-button").disabled = $("logout-all-button").disabled = true;
  try {
    await request(all ? "/logout-all" : "/logout", {});
    broadcast?.postMessage("session-changed");
    reset();
  } catch (error) {
    if (!authError(error)) toast("登出尚未完成，請恢復連線後再試。");
  } finally {
    $("logout-button").disabled = $("logout-all-button").disabled = false;
  }
}
$("logout-button").onclick = () => logout();
$("logout-all-button").onclick = () => logout(true);
function navigationTask() {
  navigation?.abort();
  navigation = new AbortController();
  return {
    signal: AbortSignal.any([navigation.signal, lifetime.signal]),
  };
}
async function loadGuilds() {
  const task = navigationTask();
  $("refresh-channels").disabled = true;
  $("channels").replaceChildren(node("p", "nav-empty", "正在載入你的伺服器…"));
  try {
    const result = await request("/guilds", undefined, task.signal);
    if (task.signal.aborted) return;
    guilds = result.guilds;
    const selected = $("guild-select").value;
    $("guild-select").replaceChildren(
      ...guilds.map((g) => new Option(g.name, g.id)),
    );
    $("guild-select").disabled = !guilds.length;
    if (!guilds.length) {
      stopChannel();
      $("messages").replaceChildren();
      $("chat-view").hidden = true;
      $("empty-view").hidden = false;
      view("home");
      channels = [];
      renderChannels();
      $("empty-description").textContent =
        "目前沒有可用頻道。請確認管理員已啟用 GuildPort，且你與 bot 都有存取權限。";
      status("沒有可用頻道");
      return;
    }
    if (guilds.some((g) => g.id === selected))
      $("guild-select").value = selected;
    await loadChannels();
  } catch (error) {
    if (!task.signal.aborted && !authError(error)) {
      $("channels").replaceChildren(
        node("p", "nav-empty", "載入失敗，請按上方重新整理。"),
      );
      toast(errorText(error));
    }
  } finally {
    if (user) $("refresh-channels").disabled = false;
  }
}
async function loadChannels() {
  if (active?.sending) {
    toast("訊息正在送出，請稍候再切換。");
    $("guild-select").value = active.channel.guild_id;
    return;
  }
  const task = navigationTask(),
    guild = $("guild-select").value;
  stopChannel();
  $("messages").replaceChildren();
  $("chat-view").hidden = true;
  $("empty-view").hidden = false;
  view("home");
  $("header-title").textContent = "GuildPort";
  $("header-subtitle").textContent =
    guilds.find((g) => g.id === guild)?.name || "";
  status("載入頻道…");
  channels = [];
  renderChannels();
  $("channel-search").value = "";
  $("home-channel-search").value = "";
  $("channel-search").disabled = true;
  try {
    const result = await request(
      `/guilds/${guild}/channels`,
      undefined,
      task.signal,
    );
    if (task.signal.aborted) return;
    channels = result.channels;
    $("channel-search").disabled = false;
    renderChannels();
    status("已登入");
    $("empty-description").textContent = channels.length
      ? "從左側選擇一個頻道，接上正在發生的對話。"
      : "此伺服器目前沒有可用頻道，請洽管理員。";
  } catch (error) {
    if (!task.signal.aborted && !authError(error)) {
      status("載入失敗", "error");
      toast(errorText(error));
      $("channels").replaceChildren(
        node("p", "nav-empty", "載入失敗，請重新整理。"),
      );
    }
  }
}
$("guild-select").onchange = () => loadChannels();
$("refresh-channels").onclick = () => {
  if (active?.sending) {
    toast("訊息正在送出，請稍候。");
    return;
  }
  loadGuilds();
};
$("channel-search").oninput = () => {
  $("home-channel-search").value = $("channel-search").value;
  renderChannels();
};
$("home-channel-search").oninput = () => {
  $("channel-search").value = $("home-channel-search").value;
  renderChannels();
};
function renderSuggestions() {
  const query = $("home-channel-search").value.trim().toLocaleLowerCase();
  const items = channels.filter((channel) =>
    channel.name.toLocaleLowerCase().includes(query),
  );
  const limit = document.body.dataset.view === "channels" || query ? 50 : 3;
  $("home-channels").replaceChildren(
    ...items.slice(0, limit).map((channel) => {
      const button = node("button", "suggestion-channel");
      button.append(
        icon("hash"),
        node("span", "", channel.name),
        node(
          "span",
          "suggestion-guild",
          guilds.find((g) => g.id === channel.guild_id)?.name || "",
        ),
      );
      button.onclick = () => selectChannel(channel);
      return button;
    }),
  );
  if (query && !items.length)
    $("home-channels").append(node("p", "nav-empty", "沒有符合的頻道"));
}
function renderChannels() {
  renderSuggestions();
  const filtered = channels.filter((channel) =>
    channel.name
      .toLocaleLowerCase()
      .includes($("channel-search").value.trim().toLocaleLowerCase()),
  );
  const children = filtered.map((channel) => {
    const button = node("button", "channel-button");
    button.append(icon("hash"), node("span", "channel-name", channel.name));
    button.setAttribute(
      "aria-current",
      String(active?.channel.id === channel.id),
    );
    if (!channel.can_send) {
      const lock = node("span", "channel-lock");
      lock.append(icon("lock"));
      button.append(lock);
      button.title = "唯讀頻道";
    }
    button.onclick = () => selectChannel(channel);
    return button;
  });
  $("channels").replaceChildren(
    ...(children.length
      ? children
      : [
          node(
            "p",
            "nav-empty",
            channels.length ? "找不到符合的頻道。" : "目前沒有可用頻道。",
          ),
        ]),
  );
}
function rememberDraft() {
  if (!active) return;
  const value = $("message-input").value;
  if (value)
    drafts.set(active.channel.id, { text: value, uncertain: active.uncertain });
  else drafts.delete(active.channel.id);
  while (drafts.size > 20) drafts.delete(drafts.keys().next().value);
}
function updateComposer() {
  const text = $("message-input").value,
    count = Array.from(text).length;
  $("character-count").textContent = `${count} / 1800`;
  $("character-count").classList.toggle("over-limit", count > 1800);
  $("message-input").disabled =
    !active || !active.channel.can_send || active.sending || active.revoked;
  $("open-emoji-picker").disabled = $("message-input").disabled;
  $("send-button").disabled =
    !active ||
    !active.connected ||
    !active.channel.can_send ||
    active.sending ||
    active.revoked ||
    active.uncertain ||
    !text.trim() ||
    count > 1800;
  $("confirm-retry").hidden = !active?.uncertain;
  $("message-input").style.height = "auto";
  $("message-input").style.height =
    Math.min(160, $("message-input").scrollHeight) + "px";
}
let composerWidth = 0;
new ResizeObserver(([entry]) => {
  if (entry.contentRect.width === composerWidth) return;
  composerWidth = entry.contentRect.width;
  if (active && !$("chat-view").hidden) updateComposer();
}).observe($("message-input"));
function selectChannel(channel) {
  if (active?.sending) {
    toast("訊息正在送出，請稍候再切換。");
    return;
  }
  rememberDraft();
  stopChannel();
  const draft = drafts.get(channel.id);
  const state = (active = {
    channel,
    controller: new AbortController(),
    messages: new Map(),
    connected: false,
    sending: false,
    uncertain: !!draft?.uncertain,
    revoked: false,
    loadingOlder: false,
    exhausted: false,
    unread: 0,
    refreshTimer: null,
    revealedSpoilers: new Set(),
  });
  $("empty-view").hidden = $("login-view").hidden = true;
  $("chat-view").hidden = false;
  view("chat");
  $("messages").replaceChildren();
  $("new-messages").hidden = true;
  $("header-title").textContent = "# " + channel.name;
  $("header-subtitle").textContent =
    guilds.find((g) => g.id === channel.guild_id)?.name || "";
  $("composer-channel").textContent = channel.name;
  $("message-input").value = draft?.text || "";
  $("message-input").placeholder = channel.can_send
    ? `傳送訊息到 #${channel.name}…`
    : "這是唯讀頻道";
  $("load-older").hidden = false;
  $("load-older").disabled = true;
  $("history-status").textContent = "";
  notice(
    channel.can_send
      ? ""
      : "唯讀頻道。" +
          (channel.send_block_reason || "你目前無法在此頻道發言。"),
  );
  renderChannels();
  updateComposer();
  if (document.body.classList.contains("sidebar-open")) mobile(false);
  void stream(state);
}
function sorted(state) {
  return [...state.messages.values()].sort((a, b) =>
    BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0,
  );
}
function merge(state, messages) {
  for (const message of messages) {
    if (/^[1-9]\d{0,19}$/.test(message.id))
      state.messages.set(message.id, message);
  }
  const all = sorted(state);
  for (const message of all.slice(0, Math.max(0, all.length - 500)))
    state.messages.delete(message.id);
  for (const key of state.revealedSpoilers)
    if (!state.messages.has(key.split(":")[0])) state.revealedSpoilers.delete(key);
}
function nearBottom() {
  const el = $("messages-scroll");
  return el.scrollHeight - el.scrollTop - el.clientHeight < 90;
}
function drawMessages(state, follow = false) {
  if (active !== state || $("chat-view").hidden) return;
  const scroll = $("messages-scroll"),
    atBottom = follow || nearBottom(),
    oldTop = scroll.scrollTop,
    oldHeight = scroll.scrollHeight;
  const visible = [...$("messages").children].find(
    (el) =>
      el.dataset.id &&
      el.getBoundingClientRect().bottom >= scroll.getBoundingClientRect().top,
  );
  const anchor = visible
    ? { id: visible.dataset.id, top: visible.getBoundingClientRect().top }
    : null;
  const fragment = document.createDocumentFragment();
  let day = "";
  for (const message of sorted(state)) {
    const label = dayLabel(message.created_at);
    if (label !== day) {
      day = label;
      fragment.append(node("div", "date-divider", label));
    }
    fragment.append(messageNode(message, user?.discord_id, {
      showEmoji, revealedSpoilers: state.revealedSpoilers,
      onReveal(key) {
        if (active !== state || state.revoked) return;
        if (state.revealedSpoilers.has(key)) state.revealedSpoilers.delete(key);
        else state.revealedSpoilers.add(key);
        drawMessages(state);
      },
    }));
  }
  if (!state.messages.size)
    fragment.append(
      node("p", "nav-empty", "這個頻道還沒有訊息。第一句，就從你開始。"),
    );
  $("messages").replaceChildren(fragment);
  imageViewer.sync(previewItems());
  if (atBottom) {
    scroll.scrollTop = scroll.scrollHeight;
    state.unread = 0;
  } else {
    const found =
      anchor &&
      [...$("messages").children].find((el) => el.dataset.id === anchor.id);
    scroll.scrollTop = found
      ? oldTop + found.getBoundingClientRect().top - anchor.top
      : oldTop + scroll.scrollHeight - oldHeight;
  }
  $("load-older").hidden = state.exhausted || state.messages.size >= 500;
  $("load-older").disabled = state.loadingOlder || !state.connected;
  $("history-status").textContent =
    state.messages.size >= 500
      ? "本次最多保留 500 則訊息"
      : state.exhausted
        ? "已到最早的訊息"
        : "";
  $("new-messages").hidden = nearBottom();
  $("new-messages").lastElementChild.textContent = state.unread
    ? `${state.unread} 則新訊息`
    : "回到最新訊息";
}
async function recent(state, initial = false) {
  const existing = new Set(state.messages.keys());
  const data = await request(
    `/channels/${state.channel.id}/messages?limit=50`,
    undefined,
    state.controller.signal,
  );
  if (active !== state) return;
  if (data.messages.length) {
    const minimum = BigInt(data.messages[0].id),
      ids = new Set(data.messages.map((m) => m.id));
    for (const id of existing)
      if (BigInt(id) >= minimum && !ids.has(id)) state.messages.delete(id);
  } else for (const id of existing) state.messages.delete(id);
  merge(state, data.messages);
  if (initial) state.exhausted = data.messages.length < 50;
  drawMessages(state, initial);
}
function denied(state, message) {
  if (active !== state) return;
  imageViewer.close();
  closeEmojiPicker();
  state.revoked = true;
  state.connected = false;
  state.controller.abort();
  state.messages.clear();
  state.revealedSpoilers.clear();
  drafts.delete(state.channel.id);
  $("message-input").value = "";
  $("messages").replaceChildren(node("p", "nav-empty", message));
  $("load-older").hidden = true;
  $("history-status").textContent = "";
  $("new-messages").hidden = true;
  status("無法存取", "error");
  notice(message);
  updateComposer();
}
async function stream(state) {
  let failures = 0,
    first = true;
  const signal = state.controller.signal;
  while (!signal.aborted && active === state) {
    try {
      status(failures ? "重新連線中…" : "連線中…");
      state.connected = false;
      updateComposer();
      for await (const event of events(state.channel.id, signal)) {
        if (signal.aborted || active !== state) return;
        if (event.event === "ready") {
          await recent(state, first);
          if (signal.aborted) return;
          state.connected = true;
          first = false;
          failures = 0;
          status(
            state.channel.can_send ? "已連線" : "已連線 · 唯讀",
            "connected",
          );
          updateComposer();
          $("load-older").disabled = false;
        } else if (event.event === "revoked") {
          if (event.data.code === "unauthorized") {
            reset("登入已到期或被撤銷，請重新登入。");
            return;
          }
          throw new ApiError(403, event.data.code, "Access revoked.");
        } else if (event.data.type === "resync_required")
          throw new Error("Resync required.");
        else if (event.data.type === "message.created") {
          const message = event.data.message;
          if (!state.messages.has(message.id) && !nearBottom()) state.unread++;
          merge(state, [message]);
          drawMessages(state);
        } else if (event.data.type === "message.deleted") {
          for (const key of state.revealedSpoilers) if (key.startsWith(event.data.message_id + ":")) state.revealedSpoilers.delete(key);
          state.messages.delete(event.data.message_id);
          drawMessages(state);
        } else if (event.data.type === "message.updated") {
          for (const key of state.revealedSpoilers) if (key.startsWith(event.data.message_id + ":")) state.revealedSpoilers.delete(key);
          if (state.messages.has(event.data.message_id)) {
            const item = state.messages.get(event.data.message_id);
            item.content =
              "這則訊息已編輯；較早的訊息請至 Discord 查看最新內容。";
            delete item.relay_content;
            item.attachments = [];
            item.media = [];
            item.edited = true;
            drawMessages(state);
          }
          if (!state.refreshTimer)
            state.refreshTimer = setTimeout(() => {
              state.refreshTimer = null;
              recent(state).catch((error) => {
                if (signal.aborted) return;
                if (authError(error)) return;
                if ([403, 404].includes(error.status))
                  denied(state, errorText(error));
                else notice("更新訊息失敗，請重新開啟頻道。");
              });
            }, 350);
        }
      }
      if (!signal.aborted) throw new Error("Disconnected.");
    } catch (error) {
      if (signal.aborted || active !== state) return;
      if (authError(error)) return;
      if ([403, 404].includes(error.status)) {
        denied(state, errorText(error));
        return;
      }
      state.connected = false;
      updateComposer();
      const wait = Math.min(1000 * 2 ** Math.min(failures++, 5), 30000);
      status(`${wait / 1000} 秒後重新連線`, "error");
      await delay(wait, signal);
    }
  }
}
$("load-older").onclick = async () => {
  const state = active;
  if (
    !state ||
    state.loadingOlder ||
    state.exhausted ||
    !state.messages.size ||
    state.messages.size >= 500
  )
    return;
  state.loadingOlder = true;
  $("load-older").disabled = true;
  $("load-older").textContent = "載入中…";
  try {
    const before = sorted(state)[0].id,
      data = await request(
        `/channels/${state.channel.id}/messages?limit=50&before=${before}`,
        undefined,
        state.controller.signal,
      );
    if (active !== state) return;
    state.exhausted = data.messages.length < 50;
    const capacity = 500 - state.messages.size;
    merge(state, data.messages.slice(-capacity));
    drawMessages(state);
  } catch (error) {
    if (!state.controller.signal.aborted && !authError(error)) {
      if ([403, 404].includes(error.status)) denied(state, errorText(error));
      else notice(errorText(error));
    }
  } finally {
    state.loadingOlder = false;
    if (active === state) {
      $("load-older").disabled = false;
      $("load-older").textContent = "載入較早訊息";
    }
  }
};
$("message-input").oninput = () => {
  rememberDraft();
  updateComposer();
};
$("message-input").onkeydown = (event) => {
  if (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.isComposing &&
    event.keyCode !== 229
  ) {
    event.preventDefault();
    $("composer-form").requestSubmit();
  }
};
$("composer-form").onsubmit = async (event) => {
  event.preventDefault();
  const state = active,
    text = $("message-input").value;
  if (!state || $("send-button").disabled || !text.trim()) return;
  state.sending = true;
  notice("正在送出…");
  updateComposer();
  try {
    await request(
      `/channels/${state.channel.id}/messages`,
      { content: text, request_id: crypto.randomUUID() },
      state.controller.signal,
    );
    if (active !== state) return;
    $("message-input").value = "";
    drafts.delete(state.channel.id);
    notice("");
  } catch (error) {
    if (active !== state) return;
    if (authError(error)) return;
    state.uncertain =
      !(error instanceof ApiError) || error.code === "delivery_unknown";
    notice(
      state.uncertain
        ? "送出結果不確定，請先查看頻道訊息，避免重複送出。"
        : errorText(error),
    );
    rememberDraft();
  } finally {
    state.sending = false;
    if (active === state) {
      updateComposer();
      $("message-input").focus();
    }
  }
};
$("confirm-retry").onclick = () => {
  if (!active) return;
  active.uncertain = false;
  notice("已解除送出鎖定，請確認不會重複發送後再送出。");
  rememberDraft();
  updateComposer();
};
$("messages-scroll").onscroll = () => {
  if (!active) return;
  if (nearBottom()) {
    active.unread = 0;
    $("new-messages").hidden = true;
  } else $("new-messages").hidden = false;
};
$("new-messages").onclick = () => {
  $("messages-scroll").scrollTop = $("messages-scroll").scrollHeight;
};
async function restore() {
  const signal = lifetime.signal;
  try {
    const me = await request("/me", undefined, signal);
    if (!signal.aborted) await signedIn(me);
  } catch (error) {
    if (!signal.aborted && error.status !== 401) toast(errorText(error));
  }
}
window.addEventListener("pagehide", () => reset());
window.addEventListener("pageshow", (event) => {
  if (event.persisted) void restore();
});
void restore();
