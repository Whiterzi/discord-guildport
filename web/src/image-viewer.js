import { node, icon } from "./ui.js";
import { previewMedia } from "./media.js";

export function createImageViewer(fallbackFocus) {
  const panel = node("section", "image-viewer");
  panel.hidden = true;
  panel.tabIndex = -1;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-label", "圖片小視窗");
  let items = [], index = 0, media = null, returnFocus = null, gesture = null;
  let size = "medium", customSize = false;
  const presets = { small: [300, 320], medium: [420, 440], large: [640, 600] };
  const button = (label, symbol, className = "icon-button") => {
    const el = node("button", className);
    el.type = "button";
    el.title = label;
    el.setAttribute("aria-label", label);
    el.append(icon(symbol));
    return el;
  };
  const header = node("header", "image-viewer-header");
  const drag = button("移動圖片視窗", "grip", "image-viewer-drag");
  drag.append(node("span", "", "圖片"));
  drag.setAttribute("aria-description", "拖曳或使用方向鍵移動");
  const sizes = node("div", "image-viewer-sizes");
  sizes.setAttribute("role", "group");
  sizes.setAttribute("aria-label", "圖片視窗大小");
  for (const [value, label] of [["small", "小"], ["medium", "中"], ["large", "大"]]) {
    const el = node("button", "", label);
    el.type = "button";
    el.dataset.size = value;
    el.setAttribute("aria-label", `${label}型圖片視窗`);
    el.onclick = () => { size = value; customSize = false; applySize(); };
    sizes.append(el);
  }
  const closeButton = button("關閉圖片小視窗", "close");
  header.append(drag, sizes, closeButton);
  const title = node("p", "image-viewer-title");
  const stage = node("div", "image-viewer-stage");
  const source = node("div", "image-viewer-source");
  const host = node("span");
  const original = node("a", "", "開啟原始連結 ↗");
  original.target = "_blank";
  original.rel = "noopener noreferrer";
  source.append(host, original);
  const privacy = node("p", "image-viewer-privacy", "直接向圖片原站載入，原站可得知你的 IP；不傳送 Referer。");
  const nav = node("footer", "image-viewer-navigation");
  const previous = button("上一張圖片", "chevron-left"), next = button("下一張圖片", "chevron-right");
  const count = node("span");
  count.setAttribute("aria-live", "polite");
  count.setAttribute("aria-atomic", "true");
  nav.append(previous, count, next);
  panel.append(header, title, stage, source, privacy, nav);
  document.body.append(panel);

  function bounds() {
    const v = window.visualViewport;
    return { left: v?.offsetLeft || 0, top: v?.offsetTop || 0,
      width: v?.width || innerWidth, height: v?.height || innerHeight };
  }
  function position(left, top, width, height) {
    const v = bounds(), min = (n, total) => Math.min(n, total - 24);
    width = Math.max(min(260, v.width), Math.min(width, v.width - 24));
    height = Math.max(min(260, v.height), Math.min(height, v.height - 24));
    left = Math.max(v.left + 12, Math.min(left, v.left + v.width - width - 12));
    top = Math.max(v.top + 12, Math.min(top, v.top + v.height - height - 12));
    Object.assign(panel.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
  }
  function applySize() {
    const rect = panel.getBoundingClientRect();
    position(rect.left, rect.top, ...presets[size]);
    updateSizes();
  }
  function updateSizes() {
    for (const el of sizes.children) el.setAttribute("aria-pressed", String(!customSize && el.dataset.size === size));
  }
  function keepInView() {
    if (panel.hidden) return;
    const r = panel.getBoundingClientRect();
    position(r.left, r.top, r.width, r.height);
  }
  window.addEventListener("resize", keepInView);
  window.visualViewport?.addEventListener("resize", keepInView);
  window.visualViewport?.addEventListener("scroll", keepInView);

  function releaseMedia() {
    if (media) {
      media.onload = media.onerror = media.onloadedmetadata = null;
      if (media.tagName === "VIDEO") media.pause();
      media.removeAttribute("src");
      if (media.tagName === "VIDEO") media.load();
      media.remove();
      media = null;
    }
    stage.replaceChildren();
  }
  function close(restoreFocus = false) {
    panel.hidden = true;
    releaseMedia();
    items = [];
    gesture = null;
    title.textContent = host.textContent = count.textContent = "";
    title.removeAttribute("title");
    original.removeAttribute("href");
    if (restoreFocus) (returnFocus?.isConnected ? returnFocus : fallbackFocus())?.focus({ preventScroll: true });
    returnFocus = null;
  }
  function labels() {
    const item = items[index];
    title.textContent = item.label;
    title.title = item.label;
    host.textContent = new URL(item.src).hostname;
    original.href = item.href;
    count.textContent = `${index + 1} / ${items.length}`;
    previous.disabled = index === 0;
    next.disabled = index === items.length - 1;
  }
  function render() {
    releaseMedia();
    labels();
    stage.setAttribute("aria-busy", "true");
    const status = node("p", "image-viewer-status", "載入中…");
    status.setAttribute("role", "status");
    stage.append(status);
    const item = items[index], kind = previewMedia(item.src)?.kind;
    const el = node(kind === "video" ? "video" : "img");
    media = el;
    if (kind === "video") {
      el.controls = true;
      el.muted = true;
      el.playsInline = true;
      el.preload = "metadata";
      el.setAttribute("aria-label", item.label);
    } else {
      el.alt = item.label;
      el.decoding = "async";
      el.referrerPolicy = "no-referrer";
    }
    el.onload = el.onloadedmetadata = () => {
      if (media !== el) return;
      stage.setAttribute("aria-busy", "false");
      status.remove();
    };
    el.onerror = () => {
      if (media !== el) return;
      stage.setAttribute("aria-busy", "false");
      el.remove();
      status.textContent = "無法顯示，連結可能已過期或原站限制預覽。可開啟原始連結。";
    };
    stage.append(el);
    el.src = item.src;
  }
  function step(delta) {
    const value = Math.max(0, Math.min(items.length - 1, index + delta));
    if (value !== index) { index = value; render(); }
  }
  previous.onclick = () => step(-1);
  next.onclick = () => step(1);
  closeButton.onclick = () => close(true);
  panel.onkeydown = (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
    if (event.target.tagName === "VIDEO") return;
    if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault(); event.stopPropagation(); step(event.key === "ArrowLeft" ? -1 : 1);
    }
  };

  function resize(rect, corner, dx, dy) {
    const v = bounds();
    const clamp = (value, min, max) => Math.max(min, Math.min(value, max));
    const minWidth = Math.min(260, v.width - 24), minHeight = Math.min(260, v.height - 24);
    let left = rect.left, top = rect.top, right = rect.right, bottom = rect.bottom;
    if (corner.endsWith("w")) left = clamp(left + dx, v.left + 12, right - minWidth);
    else right = clamp(right + dx, left + minWidth, v.left + v.width - 12);
    if (corner.startsWith("n")) top = clamp(top + dy, v.top + 12, bottom - minHeight);
    else bottom = clamp(bottom + dy, top + minHeight, v.top + v.height - 12);
    customSize = true;
    updateSizes();
    position(left, top, right - left, bottom - top);
  }
  function pointerControl(el, corner = null) {
    el.onpointerdown = (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      el.focus?.({ preventScroll: true });
      gesture = { rect: panel.getBoundingClientRect(), x: event.clientX, y: event.clientY };
      el.setPointerCapture(event.pointerId);
    };
    el.onpointermove = (event) => {
      if (!gesture) return;
      const { rect, x, y } = gesture;
      if (corner) resize(rect, corner, event.clientX - x, event.clientY - y);
      else position(rect.left + event.clientX - x, rect.top + event.clientY - y, rect.width, rect.height);
    };
    el.onpointerup = el.onpointercancel = el.onlostpointercapture = () => { gesture = null; };
    el.onkeydown = (event) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const rect = panel.getBoundingClientRect();
      const dx = event.key === "ArrowLeft" ? -20 : event.key === "ArrowRight" ? 20 : 0;
      const dy = event.key === "ArrowUp" ? -20 : event.key === "ArrowDown" ? 20 : 0;
      if (corner) resize(rect, corner, dx, dy);
      else position(rect.left + dx, rect.top + dy, rect.width, rect.height);
    };
  }
  pointerControl(drag);
  for (const corner of ["nw", "ne", "sw", "se"]) {
    const handle = corner === "se" ? button("調整圖片視窗大小", "resize", "image-viewer-resize resize-se")
      : node("span", `image-viewer-resize resize-${corner}`);
    if (corner !== "se") handle.setAttribute("aria-hidden", "true");
    else handle.setAttribute("aria-description", "拖曳角落或使用方向鍵調整大小");
    pointerControl(handle, corner);
    panel.append(handle);
  }
  return {
    close,
    show(available, src, trigger) {
      const selected = available.findIndex((item) => item.src === src);
      if (selected < 0) return;
      const wasHidden = panel.hidden;
      items = available; index = selected; returnFocus = trigger;
      panel.hidden = false;
      if (wasHidden) {
        const v = bounds();
        position(v.left + v.width - presets[size][0] - 24, v.top + 76, ...presets[size]);
        customSize = false; updateSizes();
      }
      render(); panel.focus({ preventScroll: true });
    },
    sync(available) {
      if (panel.hidden) return;
      const selected = available.findIndex((item) => item.src === items[index]?.src);
      if (selected < 0) return close();
      items = available; index = selected; labels();
    },
  };
}
