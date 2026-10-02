// Like ChatPTT, resolve media locally and let the browser decode it on demand.
// Never fetch arbitrary message URLs through the relay.
const imageExtension = /\.(?:jpe?g|jfif|png|apng|gif|webp|avif|bmp|svg|ico)$/i;
const imageFormat = /^(?:image\/)?(?:jpe?g|png|apng|gif|webp|avif|bmp|svg(?:\+xml)?|ico)$/i;

export function discordAttachmentKey(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
        !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname)) return null;
    return /^\/(?:ephemeral-)?attachments\/[1-9]\d{0,19}\/[1-9]\d{0,19}\/[^/]+$/.test(url.pathname) ? url.pathname : null;
  } catch { return null; }
}

export function resolvedMediaUrl(raw, candidates = [], now = Date.now()) {
  const key = discordAttachmentKey(raw);
  if (!key) return raw;
  let best = raw, expiry = 0;
  for (const candidate of [raw, ...candidates]) {
    if (discordAttachmentKey(candidate) !== key) continue;
    const url = new URL(candidate), params = url.searchParams;
    const expires = /^[\da-f]{1,12}$/i.test(params.get("ex") || "") ? parseInt(params.get("ex"), 16) : 0;
    if (params.get("is") && params.get("hm") && expires * 1000 > now && expires > expiry) {
      best = candidate; expiry = expires;
    }
  }
  return best;
}

export function customEmoji(raw) {
  const match = /^<(a?):([A-Za-z0-9_]{1,32}):([1-9]\d{0,19})>$/.exec(raw);
  if (!match) return null;
  return { name: match[2], id: match[3], animated: !!match[1],
    url: `https://cdn.discordapp.com/emojis/${match[3]}.webp?size=96${match[1] ? "&animated=true" : ""}` };
}

export function previewMedia(raw) {
  if (typeof raw !== "string" || raw.length > 8192) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || /[:\[\]]/.test(host) || /^[\d.]+$/.test(host) ||
      /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(host)) return null;
  url.protocol = "https:";
  url.hash = "";
  if (["imgur.com", "www.imgur.com", "m.imgur.com", "i.imgur.com"].includes(host)) {
    const match = url.pathname.match(/^\/([A-Za-z0-9]{5,12})(?:\.(jpe?g|png|gif|webp|avif|apng|gifv|mp4|webm))?\/?$/i);
    if (!match) return null;
    url.hostname = "i.imgur.com";
    url.pathname = `/${match[1]}.${match[2]?.toLowerCase() === "gifv" ? "mp4" : match[2] || "jpg"}`;
  }
  if (/\.(?:mp4|webm)$/i.test(url.pathname)) return { src: url.href, kind: "video" };
  const direct = imageExtension.test(url.pathname);
  const format = ["format", "fm", "output", "ext", "content-type", "response-content-type"]
    .some((key) => imageFormat.test(url.searchParams.get(key) || ""));
  const filename = ["filename", "file", "image", "img"]
    .some((key) => imageExtension.test(url.searchParams.get(key) || ""));
  const cdn = url.pathname !== "/" && (["images.plurk.com", "i.meee.com.tw", "i.ibb.co", "i.postimg.cc"].includes(host) ||
    /(?:^|\.)googleusercontent\.com$/.test(host));
  return direct || format || filename || cdn ? { src: url.href, kind: "image" } : null;
}
