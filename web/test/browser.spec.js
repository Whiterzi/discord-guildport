import { test as base, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { previewMedia } from "../src/media.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const test = base.extend({
  demo: async ({}, use) => {
    const child = spawn(
      join(root, ".venv/bin/python"),
      ["examples/demo.py", "--seed"],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
    const stopped = once(child, "close");
    try {
      const info = await new Promise((resolve, reject) => {
        let text = "";
        child.once("error", reject);
        child.once("exit", () =>
          reject(new Error("Demo exited before ready.")),
        );
        child.stdout.on("data", (chunk) => {
          text += chunk;
          if (text.includes("\n")) {
            try {
              resolve(JSON.parse(text.split("\n")[0]));
            } catch (error) {
              reject(error);
            }
          }
        });
      });
      await use(info);
    } finally {
      child.kill("SIGTERM");
      await stopped;
    }
  },
});
async function login(page, demo) {
  await page.goto(demo.url);
  await page.getByRole("button", { name: "登入", exact: true }).click();
  await page.getByLabel("GuildPort 帳號", { exact: true }).fill(demo.username);
  await page.getByLabel("密碼", { exact: true }).fill(demo.password);
  await page
    .getByRole("button", { name: "登入 GuildPort", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "general", exact: true }),
  ).toBeVisible();
}
async function openChat(page) {
  await page.getByRole("button", { name: "general", exact: true }).click();
  await expect(page.locator("#connection")).toHaveText("已連線");
  await expect(
    page.getByText("Demo message 120", { exact: false }),
  ).toBeVisible();
}
async function externalLogin(request, demo) {
  const result = await request.post(demo.url + "/v1/login", {
    data: { username: demo.username, password: demo.password },
  });
  return (await result.json()).token;
}

test("desktop login shell, invalid login, privacy and theme", async ({
  page,
  demo,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(demo.url);
  await expect(
    page.getByRole("heading", { name: "有什麼想聊的？" }),
  ).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: join(root, "tmp/web-login-desktop.png"),
  });
  await page.getByRole("button", { name: "登入", exact: true }).click();
  await page.getByLabel("GuildPort 帳號", { exact: true }).fill("gp_300");
  await page.getByLabel("密碼", { exact: true }).fill("wrong");
  await page
    .getByRole("button", { name: "登入 GuildPort", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveText(
    "帳號或密碼不正確，請再試一次。",
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "關於訊息隱私" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "切換深色模式" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(errors).toEqual([]);
});

test("existing account, filtering, history, multiline send, live messages and no browser storage", async ({
  page,
  context,
  demo,
  request,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page, demo);
  await page
    .getByRole("searchbox", { name: "搜尋頻道", exact: true })
    .fill("missing");
  await expect(page.getByText("找不到符合的頻道。")).toBeVisible();
  await page
    .getByRole("searchbox", { name: "搜尋頻道", exact: true })
    .fill("gen");
  await openChat(page);
  await expect(page.locator(".message")).toHaveCount(50);
  await expect(
    page.getByRole("link", { name: "Project", exact: true }),
  ).toHaveAttribute("href", "https://github.com/Whiterzi/discord-guildport");
  await page.getByRole("button", { name: "載入較早訊息" }).click();
  await expect(page.locator(".message")).toHaveCount(100);
  const input = page.getByRole("textbox", { name: "訊息內容" });
  await input.fill("Hello from GuildPort");
  await input.press("Shift+Enter");
  await input.pressSequentially("second line");
  await expect(input).toHaveValue("Hello from GuildPort\nsecond line");
  await page.getByRole("button", { name: "送出訊息", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect(
    page
      .locator(".message-body")
      .filter({ hasText: "Hello from GuildPort\nsecond line" }),
  ).toBeVisible();
  await input.fill("保留這份草稿 🌿");
  const token = await externalLogin(request, demo);
  await request.post(demo.url + "/v1/channels/200/messages", {
    headers: { Authorization: "Bearer " + token },
    data: {
      content: "<img src=x onerror=alert(1)> live message",
      request_id: crypto.randomUUID(),
    },
  });
  await expect(
    page.getByText("<img src=x onerror=alert(1)> live message", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(input).toHaveValue("保留這份草稿 🌿");
  expect(await page.locator("#messages img").count()).toBe(0);
  const cookies = await context.cookies();
  expect(cookies.find((c) => c.name === "guildport_session")?.httpOnly).toBe(
    true,
  );
  expect(
    await page.evaluate(() => ({
      cookie: document.cookie,
      local: localStorage.length,
      session: sessionStorage.length,
    })),
  ).toEqual({ cookie: "", local: 0, session: 0 });
  await page.screenshot({
    animations: "disabled",
    path: join(root, "tmp/web-chat-desktop.png"),
  });
  await page.getByRole("button", { name: "切換深色模式" }).click();
  await page.screenshot({
    animations: "disabled",
    path: join(root, "tmp/web-chat-dark.png"),
  });
  expect(errors).toEqual([]);
});

test("mobile drawer, no overflow and responsive composer", async ({
  page,
  demo,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(demo.url);
  await page.screenshot({
    animations: "disabled",
    path: join(root, "tmp/web-login-mobile.png"),
  });
  await page.getByRole("button", { name: "登入", exact: true }).click();
  await page.getByLabel("GuildPort 帳號", { exact: true }).fill(demo.username);
  await page.getByLabel("密碼", { exact: true }).fill(demo.password);
  await page
    .getByRole("button", { name: "登入 GuildPort", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "今天，想聊些什麼？" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "開啟頻道選單" }).click();
  await openChat(page);
  await expect(
    page.getByRole("button", { name: "開啟頻道選單" }),
  ).toHaveAttribute("aria-expanded", "false");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("textbox", { name: "訊息內容" })
    .fill("手機上的對話，一樣輕鬆。");
  await page.screenshot({
    animations: "disabled",
    path: join(root, "tmp/web-chat-mobile.png"),
  });
});

test("cookie restores on reload, logout removes content and session", async ({
  page,
  demo,
}) => {
  await login(page, demo);
  await openChat(page);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "general", exact: true }),
  ).toBeVisible();
  await page.locator("#account-button").click();
  await page.getByRole("button", { name: "登出這個瀏覽器" }).click();
  await expect(
    page.getByRole("heading", { name: "有什麼想聊的？" }),
  ).toBeVisible();
  await expect(page.locator(".message")).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "有什麼想聊的？" }),
  ).toBeVisible();
});

test("revoking all devices closes live stream and clears chat", async ({
  page,
  demo,
  request,
}) => {
  await previewFixtures(page);
  await login(page, demo);
  await openChat(page);
  await page.getByRole("button", { name: "在小視窗預覽：風景", exact: true }).click();
  const token = await externalLogin(request, demo);
  await request.post(demo.url + "/v1/logout-all", {
    headers: { Authorization: "Bearer " + token },
    data: {},
  });
  await expect(
    page.getByRole("heading", { name: "有什麼想聊的？" }),
  ).toBeVisible({ timeout: 12_000 });
  await expect(page.locator(".message")).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "圖片小視窗" })).toBeHidden();
  await expect(page.locator(".image-viewer img")).toHaveCount(0);
});

test("uncertain sends preserve draft and require an explicit retry decision", async ({
  page,
  demo,
}) => {
  await login(page, demo);
  await openChat(page);
  await page.route("**/web-api/channels/200/messages", (route) =>
    route.request().method() === "POST"
      ? route.abort("failed")
      : route.continue(),
  );
  const input = page.getByRole("textbox", { name: "訊息內容" });
  await input.fill("Do not automatically resend");
  await page.getByRole("button", { name: "送出訊息", exact: true }).click();
  await expect(
    page.getByText("送出結果不確定，請先查看頻道訊息，避免重複送出。"),
  ).toBeVisible();
  await expect(input).toHaveValue("Do not automatically resend");
  await expect(
    page.getByRole("button", { name: "送出訊息", exact: true }),
  ).toBeDisabled();
  await page.unroute("**/web-api/channels/200/messages");
  await page.getByRole("button", { name: "已查看歷史，允許再次送出" }).click();
  await page.getByRole("button", { name: "送出訊息", exact: true }).click();
  await expect(input).toHaveValue("");
});

test("history denial fails closed and never leaves old content visible", async ({
  page,
  demo,
}) => {
  await login(page, demo);
  await page.route("**/web-api/channels/200/messages?*", (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "access_denied", message: "Denied" },
      }),
    }),
  );
  await page.getByRole("button", { name: "general", exact: true }).click();
  await expect(page.locator("#connection")).toHaveText("無法存取");
  await expect(page.locator(".message")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "訊息內容" })).toBeDisabled();
});

test("automatic reconnect refreshes deleted messages without losing the draft", async ({
  page,
  demo,
}) => {
  await login(page, demo);
  let streams = 0;
  await page.route("**/web-api/channels/200/events", (route) => {
    streams++;
    if (streams > 1) return route.continue();
    const message = {
      id: "9999",
      channel_id: "200",
      author: { id: "301", name: "Alice", bot: false },
      content: "Deleted while offline",
      created_at: new Date().toISOString(),
      attachments: [],
    };
    return route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body:
        "event: ready\ndata: {}\n\nevent: relay\ndata: " +
        JSON.stringify({ type: "message.created", message }) +
        "\n\n",
    });
  });
  await page.getByRole("button", { name: "general", exact: true }).click();
  await expect(page.locator("#connection")).toHaveText("1 秒後重新連線");
  await page
    .getByRole("textbox", { name: "訊息內容" })
    .fill("Keep this through reconnect");
  await expect(page.locator("#connection")).toHaveText("已連線");
  expect(streams).toBeGreaterThanOrEqual(2);
  await expect(page.getByText("Deleted while offline")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "訊息內容" })).toHaveValue(
    "Keep this through reconnect",
  );
  await expect(page.locator(".message")).toHaveCount(50);
});

test("two-level navigation, channel overview and collapsed sidebar preserve the draft", async ({
  page,
  demo,
}) => {
  await login(page, demo);
  await expect(page.locator(".app-rail")).toBeVisible();
  await page.getByRole("button", { name: "關閉側邊欄", exact: true }).click();
  await expect(page.locator("#sidebar")).toBeHidden();
  await page.getByRole("button", { name: "開啟頻道選單", exact: true }).click();
  await expect(page.locator("#sidebar")).toBeVisible();
  await openChat(page);
  const input = page.getByRole("textbox", { name: "訊息內容" });
  await input.fill("保留草稿，稍後繼續");
  await page.locator("#view-channels").click();
  await expect(
    page.getByRole("heading", { name: "選擇要聊天的頻道" }),
  ).toBeVisible();
  await page.getByRole("searchbox", { name: "尋找聊天頻道" }).fill("gen");
  await expect(page.locator("#home-channels button")).toHaveCount(1);
  await page.locator("#view-chat").click();
  await expect(input).toHaveValue("保留草稿，稍後繼續");
  await page.locator("#new-chat").click();
  await expect(
    page.getByRole("heading", { name: "今天，想聊些什麼？" }),
  ).toBeVisible();
  await page.locator("#home-channels button").first().click();
  await expect(input).toHaveValue("保留草稿，稍後繼續");
});

test("media recognition preserves signatures and excludes local, unsafe and non-media URLs", () => {
  for (const url of ["javascript:alert(1)", "data:image/svg+xml,hi", "file:///tmp/a.png",
    "https://localhost/a.png", "https://printer.local/a.png", "https://127.0.0.1/a.png",
    "https://[::1]/a.png", "https://2130706433/a.png", "https://0x7f000001/a.png",
    "https://images.example.com:8443/a.png", "https://user:password@images.example.com/a.png",
    "https://imgur.com/a/Abcde12", "https://example.com/page", "https://example.com/a.png.exe"])
    expect(previewMedia(url), url).toBeNull();
  const signed = "https://cdn.discordapp.com/attachments/123/456/photo.png?ex=abc&hm=a%2Bb%2Fc";
  expect(previewMedia(signed)).toEqual({ src: signed, kind: "image" });
  expect(previewMedia("http://imgur.com/Abcde12")).toEqual({ src: "https://i.imgur.com/Abcde12.jpg", kind: "image" });
  expect(previewMedia("https://i.imgur.com/Abcde12.gifv")).toEqual({ src: "https://i.imgur.com/Abcde12.mp4", kind: "video" });
  expect(previewMedia("https://images.example.com/photo?format=webp").kind).toBe("image");
});

const previewOne = "https://images.example.com/one.png?signature=a%2Bb&ex=123";
async function previewFixtures(page) {
  const requests = [];
  await page.route(/^https:\/\/(images\.example\.com|i\.imgur\.com)\//, (route) => {
    requests.push({ url: route.request().url(), headers: route.request().headers() });
    if (route.request().url().includes("missing.png")) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 440"><defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#ccdce6"/><stop offset="1" stop-color="#f5e8d4"/></linearGradient></defs><path fill="url(#sky)" d="M0 0h640v440H0z"/><circle cx="480" cy="95" r="36" fill="#fff6df"/><path fill="#819d93" d="m0 270 150-145 165 160 165-112 160 123v144H0z"/><path fill="#405e54" d="m0 335 175-135 225 175 125-90 115 74v81H0z"/><path fill="#ced9cc" d="m285 330 105 10 75 100H200z"/></svg>' });
  });
  await page.route("**/web-api/channels/200/messages?*", async (route) => {
    const response = await route.fetch(), data = await response.json();
    const last = data.messages.at(-1);
    if (last) {
      last.content += `\n[風景](${previewOne})\nhttps://imgur.com/Abcde12\nhttps://images.example.com/missing.png\n` +
        "`https://images.example.com/code.png`\n||https://images.example.com/spoiler.png||";
      last.attachments = [{ name: "第二張.png", url: "https://images.example.com/two.webp" },
        { name: "重複圖片.png", url: previewOne }, { name: "SPOILER_hidden.png", url: "https://images.example.com/hidden.png" }];
    }
    await route.fulfill({ response, json: data });
  });
  return { requests };
}

test("floating previews load on demand, keep the composer usable and support gallery, drag and resize", async ({ page, demo, request }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const fixtures = await previewFixtures(page);
  await login(page, demo);
  await openChat(page);
  const viewer = page.getByRole("dialog", { name: "圖片小視窗" });
  const open = page.getByRole("button", { name: "在小視窗預覽：風景", exact: true });
  await expect(open).toBeVisible();
  expect(fixtures.requests).toEqual([]);
  await expect(page.locator("#messages img, #messages video")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /在小視窗預覽：SPOILER/ })).toHaveCount(0);
  await open.click();
  await expect(viewer).toBeVisible();
  await expect(viewer.locator("img")).toHaveAttribute("src", previewOne);
  await expect(viewer.locator(".image-viewer-stage")).toHaveAttribute("aria-busy", "false");
  await expect(viewer.getByText("1 / 4", { exact: true })).toBeVisible();
  expect(fixtures.requests).toHaveLength(1);
  expect(fixtures.requests[0].headers.referer).toBeUndefined();
  expect(fixtures.requests[0].headers.cookie).toBeUndefined();
  const input = page.getByRole("textbox", { name: "訊息內容" });
  await input.fill("看圖時仍能繼續打字");
  const token = await externalLogin(request, demo);
  await request.post(demo.url + "/v1/channels/200/messages", {
    headers: { Authorization: "Bearer " + token }, data: { content: "A new message while viewing", request_id: crypto.randomUUID() },
  });
  await expect(page.getByText("A new message while viewing", { exact: true })).toBeVisible();
  await expect(viewer.locator("img")).toHaveAttribute("src", previewOne);
  expect(fixtures.requests).toHaveLength(1);
  const before = await viewer.boundingBox();
  const drag = await viewer.getByRole("button", { name: "移動圖片視窗" }).boundingBox();
  await page.mouse.move(drag.x + 25, drag.y + 15);
  await page.mouse.down(); await page.mouse.move(drag.x - 100, drag.y + 70); await page.mouse.up();
  expect((await viewer.boundingBox()).x).toBeLessThan(before.x);
  const resize = viewer.getByRole("button", { name: "調整圖片視窗大小" });
  await resize.focus(); await page.keyboard.press("ArrowRight");
  expect((await viewer.boundingBox()).width).toBeGreaterThan(before.width);
  await viewer.getByRole("button", { name: "小型圖片視窗" }).click();
  expect((await viewer.boundingBox()).width).toBe(300);
  await viewer.getByRole("button", { name: "中型圖片視窗" }).click();
  await page.screenshot({ path: join(root, "tmp/web-image-viewer.png"), animations: "disabled" });
  await page.getByRole("button", { name: "切換深色模式" }).click();
  await page.screenshot({ path: join(root, "tmp/web-image-viewer-dark.png"), animations: "disabled" });
  await viewer.getByRole("button", { name: "下一張圖片" }).click();
  await expect(viewer.locator("img")).toHaveAttribute("src", "https://i.imgur.com/Abcde12.jpg");
  await page.keyboard.press("ArrowRight");
  await expect(viewer.getByText(/無法顯示/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();
  await expect(page.locator(".image-viewer img, .image-viewer video")).toHaveCount(0);
  await expect(input).toHaveValue("看圖時仍能繼續打字");
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
  expect(errors).toEqual([]);
});

test("mobile preview stays in the viewport and clears on navigation and access denial", async ({ page, demo }) => {
  await previewFixtures(page);
  await login(page, demo);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "開啟頻道選單" }).click();
  await openChat(page);
  const open = () => page.getByRole("button", { name: "在小視窗預覽：風景", exact: true }).click();
  const viewer = page.getByRole("dialog", { name: "圖片小視窗" });
  await open();
  await viewer.getByRole("button", { name: "大型圖片視窗" }).click();
  await page.screenshot({ path: join(root, "tmp/web-image-viewer-mobile.png"), animations: "disabled" });
  let rect = await viewer.boundingBox();
  expect(rect.x).toBeGreaterThanOrEqual(12);
  expect(rect.x + rect.width).toBeLessThanOrEqual(378);
  await page.setViewportSize({ width: 844, height: 390 });
  rect = await viewer.boundingBox();
  await expect.poll(async () => { const r = await viewer.boundingBox(); return r.y + r.height; }).toBeLessThanOrEqual(378);
  await page.locator("#view-channels").click();
  await expect(viewer).toBeHidden();
  await expect(page.locator(".image-viewer img")).toHaveCount(0);
  await page.locator("#view-chat").click();
  await open();
  await page.route("**/web-api/channels/200/messages?*", (route) => route.fulfill({ status: 403,
    contentType: "application/json", body: JSON.stringify({ error: { code: "access_denied", message: "Denied" } }) }));
  await page.getByRole("button", { name: "載入較早訊息", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#connection")).toHaveText("無法存取");
  await expect(viewer).toBeHidden();
  await expect(page.locator(".image-viewer img")).toHaveCount(0);
});

test("channel changes and logout discard the active preview", async ({ page, demo }) => {
  await previewFixtures(page);
  await login(page, demo); await openChat(page);
  const viewer = page.getByRole("dialog", { name: "圖片小視窗" });
  await page.getByRole("button", { name: "在小視窗預覽：風景", exact: true }).click();
  await page.locator("#channels").getByRole("button", { name: "general", exact: true }).click();
  await expect(viewer).toBeHidden();
  await expect(page.locator(".image-viewer img")).toHaveCount(0);
  await expect(page.locator("#connection")).toHaveText("已連線");
  await page.getByRole("button", { name: "在小視窗預覽：風景", exact: true }).click();
  await page.locator("#account-button").click();
  await page.getByRole("button", { name: "登出這個瀏覽器" }).click();
  await expect(page.locator(".media-preview-button")).toHaveCount(0);
  await expect(page.locator(".image-viewer a")).not.toHaveAttribute("href");
});
