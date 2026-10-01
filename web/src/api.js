export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const headers = { "X-GuildPort-Client": "web", Accept: "application/json" };
async function response(path, options, signal) {
  const res = await fetch("/web-api" + path, {
    ...options,
    headers: { ...headers, ...options.headers },
    credentials: "same-origin",
    redirect: "error",
    cache: "no-store",
    signal,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(
      res.status,
      data?.error?.code || "http_error",
      data?.error?.message || "Request failed.",
    );
  }
  return res;
}
export async function request(path, data, signal) {
  const timeout = AbortSignal.timeout(30_000);
  const res = await response(
    path,
    data === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        },
    signal ? AbortSignal.any([signal, timeout]) : timeout,
  );
  return res.json();
}
export async function* events(channel, signal) {
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  let timer = setTimeout(() => controller.abort(), 30_000),
    reader;
  try {
    const res = await response(`/channels/${channel}/events`, {}, combined);
    clearTimeout(timer);
    if (
      !res.headers.get("content-type")?.startsWith("text/event-stream") ||
      !res.body
    )
      throw new Error("Invalid event stream.");
    reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!combined.aborted) {
      timer = setTimeout(() => controller.abort(), 45_000);
      const { value, done } = await reader.read();
      clearTimeout(timer);
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r/g, "");
      if (buffer.length > 1_048_576) throw new Error("Event stream too large.");
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let event = "message";
        const data = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
        if (data.length) yield { event, data: JSON.parse(data.join("\n")) };
      }
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}
export function delay(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}
export function errorText(error) {
  const messages = {
    invalid_login: "帳號或密碼不正確，請再試一次。",
    unauthorized: "登入已到期或被撤銷，請重新登入。",
    rate_limited: "操作太頻繁，請稍候再試。",
    slowmode: "頻道已啟用慢速模式，請稍候再送出。",
    cannot_send: "目前無法在此頻道發言，請確認 Discord 權限。",
    channel_unavailable: "此頻道已停止開放或你已無法存取。",
    access_denied: "你已無法存取此頻道。",
    stream_limit: "已達連線上限，請先關閉其他聊天視窗。",
    browser_origin: "請使用管理員提供的正確網頁網址登入。",
    delivery_unknown: "送出結果不確定。請先查看歷史訊息，避免重複送出。",
  };
  return (
    messages[error.code] ||
    (error.status === 403
      ? "此頻道目前無法存取。"
      : error.status === 503
        ? "Discord 連線暫時無法驗證，請稍候再試。"
        : "連線暫時發生問題，請稍候再試。")
  );
}
