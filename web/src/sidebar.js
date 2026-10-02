// Keep the preferred desktop width in this tab only, like drafts and theme.
export function initSidebarResize(sidebar, handle, rail, narrow) {
  const defaultWidth = 232, minWidth = 216;
  let preferredWidth = defaultWidth, drag = null;
  const maxWidth = () => Math.max(minWidth, Math.min(480, innerWidth - rail.offsetWidth - 420));
  const clamp = (width) => Math.round(Math.max(minWidth, Math.min(maxWidth(), width)));

  function render() {
    const width = clamp(preferredWidth);
    sidebar.style.setProperty("--sidebar-width", `${width}px`);
    handle.setAttribute("aria-valuemax", String(maxWidth()));
    handle.setAttribute("aria-valuenow", String(width));
    handle.setAttribute("aria-valuetext", `${width} 像素`);
    return width;
  }
  function finish(cancel = false) {
    if (!drag) return;
    const previous = drag;
    drag = null;
    if (cancel) preferredWidth = previous.preferredWidth;
    document.body.classList.remove("sidebar-resizing");
    if (handle.hasPointerCapture(previous.id)) handle.releasePointerCapture(previous.id);
    render();
  }
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !event.isPrimary || narrow.matches || sidebar.inert) return;
    event.preventDefault();
    handle.focus({ preventScroll: true });
    drag = { id: event.pointerId, x: event.clientX, width: render(), preferredWidth };
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("sidebar-resizing");
  });
  handle.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    preferredWidth = clamp(drag.width + event.clientX - drag.x);
    render();
  });
  handle.addEventListener("pointerup", (event) => {
    if (event.pointerId === drag?.id) finish();
  });
  handle.addEventListener("pointercancel", () => finish(true));
  handle.addEventListener("lostpointercapture", () => finish());
  handle.addEventListener("dblclick", () => {
    preferredWidth = defaultWidth;
    render();
  });
  handle.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || narrow.matches) return;
    const step = event.shiftKey ? 24 : 8;
    let width;
    switch (event.key) {
      case "ArrowLeft": width = render() - step; break;
      case "ArrowRight": width = render() + step; break;
      case "Home": width = minWidth; break;
      case "End": width = maxWidth(); break;
      case "Enter": width = defaultWidth; break;
      case "Escape": finish(true); return;
      default: return;
    }
    event.preventDefault();
    finish();
    preferredWidth = clamp(width);
    render();
  });
  // Viewport changes constrain the visible width, without losing the user's
  // desktop preference when switching to a phone-sized drawer and back.
  addEventListener("resize", () => { finish(); render(); });
  addEventListener("blur", () => finish());
  narrow.addEventListener("change", () => { finish(); render(); });
  render();
}
