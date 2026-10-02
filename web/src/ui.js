import { previewMedia } from "./media.js";

export const $ = (id) => document.getElementById(id);
const paths = {
  image: "M3 3h18v18H3ZM3 16l5-5 4 4 3-3 6 6M9 7h.01",
  grip: "M8 8h.01M16 8h.01M8 16h.01M16 16h.01",
  resize: "M7 20 20 7M13 20l7-7",
  "chevron-left": "m15 5-7 7 7 7",
  "chevron-right": "m9 5 7 7-7 7",
  home: "m3 10 9-7 9 7v11h-6v-7H9v7H3Z",
  plus: "M12 5v14M5 12h14",
  compose: "M13 4H4v16h16v-9M16 3l5 5-9 9H7v-5l9-9Z",
  "chevron-down": "m8 10 4 4 4-4",
  close: "m6 6 12 12M6 18 18 6",
  search: "m21 21-4.5-4.5M19 10.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0",
  refresh: "M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 3M18 18A8 8 0 0 1 5 15",
  guild: "M4 21V5h10v16M14 9h6v12M8 9h2M8 13h2M8 17h2M2 21h20",
  shield: "M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7l-9-4ZM8 12l3 3 5-6",
  hash: "m10 3-4 18M18 3l-4 18M3 9h18M2 15h18",
  "arrow-up-right": "M7 17 17 7M7 7h10v10",
  "arrow-right": "M4 12h16m-6-6 6 6-6 6",
  "arrow-down": "M12 4v16m-6-6 6 6 6-6",
  "arrow-up": "M12 20V4m-6 6 6-6 6 6",
  panel: "M3 4h18v16H3ZM9 4v16",
  moon: "M20.5 13A9 9 0 0 1 11 3.5 9 9 0 1 0 20.5 13Z",
  sun: "M12 3V1m0 22v-2M3 12H1m22 0h-2M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  chat: "M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5A8.5 8.5 0 0 1 10.5 3H13a8 8 0 0 1 8 8.5ZM7 9h9M7 13h6",
  user: "M20 21v-2a6 6 0 0 0-6-6h-4a6 6 0 0 0-6 6v2M16 6a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  lock: "M6 10h12v11H6ZM8 10V6a4 4 0 0 1 8 0v4",
  file: "M14 2H4v20h16V8l-6-6Zm0 0v6h6M8 13h8M8 17h5",
};
export function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.6",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  }))
    svg.setAttribute(key, value);
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", paths[name] || paths.chat);
  svg.append(path);
  return svg;
}
export function icons(root = document) {
  root
    .querySelectorAll("[data-icon]")
    .forEach((el) => el.replaceChildren(icon(el.dataset.icon)));
}
export function node(tag, className = "", text = "") {
  const el = document.createElement(tag);
  el.className = className;
  el.textContent = text;
  return el;
}
export function safeUrl(value) {
  try {
    const u = new URL(value);
    return ["https:", "http:"].includes(u.protocol) &&
      !u.username &&
      !u.password
      ? u.href
      : null;
  } catch {
    return null;
  }
}
function previewButton(href, label) {
  const media = previewMedia(href);
  if (!media) return null;
  const button = node("button", "media-preview-button");
  button.type = "button";
  button.dataset.previewSrc = media.src;
  button.dataset.previewHref = href;
  button.dataset.previewLabel = label;
  button.setAttribute("aria-label", `在小視窗預覽：${label}`);
  button.title = "在小視窗預覽（點擊後向原站載入）";
  button.append(icon("image"), node("span", "", "預覽"));
  return button;
}
function inline(parent, text) {
  // Text nodes only: Discord content is never interpreted as HTML.
  const tokens =
    /(\[[^\]\n]+\]\(<?https?:\/\/[^\s<>]*>?\)|\*\*[^*\n]+\*\*|`[^`\n]+`|https?:\/\/[^\s<>]+|\|\|[^|]+\|\|)/g;
  let previous = 0;
  for (const match of text.matchAll(tokens)) {
    parent.append(document.createTextNode(text.slice(previous, match.index)));
    const part = match[0];
    if (part.startsWith("**"))
      parent.append(node("strong", "", part.slice(2, -2)));
    else if (part.startsWith("`"))
      parent.append(node("code", "", part.slice(1, -1)));
    else if (part.startsWith("||")) {
      const button = node("button", "pill-button", "顯示劇透");
      button.type = "button";
      button.addEventListener("click", () =>
        button.replaceWith(document.createTextNode(part.slice(2, -2))),
      );
      parent.append(button);
    } else {
      const markdown = part.match(
        /^\[([^\]\n]+)\]\(<?(https?:\/\/[^\s<>]*?)>?\)$/,
      );
      const href = safeUrl(markdown ? markdown[2] : part);
      if (href) {
        const a = node("a", "", markdown ? markdown[1] : part);
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        parent.append(a);
        const preview = previewButton(href, markdown ? markdown[1] : "訊息圖片");
        if (preview) parent.append(preview);
      } else parent.append(document.createTextNode(part));
    }
    previous = match.index + part.length;
  }
  parent.append(document.createTextNode(text.slice(previous)));
}
export function body(content) {
  const el = node("div", "message-body");
  const sections = String(content || "").split(/```[^\n]*\n([\s\S]*?)```/g);
  sections.forEach((text, index) => {
    if (index % 2) {
      const pre = node("pre");
      pre.append(node("code", "", text));
      el.append(pre);
    } else inline(el, text);
  });
  return el;
}
export function messageNode(message, userId) {
  const author = message.relay_author ||
    message.author || { name: "未知使用者" };
  const own = author.id === userId;
  const article = node("article", `message${own ? " self" : ""}`);
  article.dataset.id = message.id;
  article.append(
    node("div", "author-avatar", Array.from(author.name || "?")[0]),
  );
  const main = node("div", "message-main"),
    meta = node("div", "message-meta");
  meta.append(node("strong", "", own ? "你" : author.name));
  if (message.relay_author) meta.append(node("span", "badge", "via GuildPort"));
  else if (message.author?.bot) meta.append(node("span", "badge", "APP"));
  const date = new Date(message.created_at),
    time = node(
      "time",
      "",
      Number.isNaN(+date)
        ? ""
        : new Intl.DateTimeFormat("zh-TW", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }).format(date),
    );
  if (!Number.isNaN(+date)) {
    time.dateTime = date.toISOString();
    time.title = date.toLocaleString("zh-TW");
  }
  meta.append(time);
  if (message.edited) meta.append(node("span", "message-edited", "已編輯"));
  main.append(meta, body(message.relay_content ?? message.content));
  for (const attachment of message.attachments || []) {
    const href = safeUrl(attachment.url);
    if (!href) continue;
    const link = node("a", "attachment");
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.append(
      icon("file"),
      document.createTextNode(attachment.name || "附件"),
    );
    const row = node("div", "attachment-row");
    row.append(link);
    const preview = previewButton(href, attachment.name || "附件圖片");
    if (preview && !attachment.name?.startsWith("SPOILER_")) row.append(preview);
    main.append(row);
  }
  article.append(main);
  return article;
}
export function dayLabel(value) {
  const date = new Date(value);
  return Number.isNaN(+date)
    ? ""
    : new Intl.DateTimeFormat("zh-TW", {
        month: "long",
        day: "numeric",
        weekday: "short",
      }).format(date);
}
