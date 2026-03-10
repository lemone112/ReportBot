import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import worker from "./index";
import type { Env, TelegramUpdate, LinearWebhookPayload } from "./types";

// ============================================================
// Mocks & Helpers
// ============================================================

let fetchCalls: { url: string; init: RequestInit; body?: unknown }[] = [];
let kvStore: Map<string, { value: string; opts?: unknown }>;
let r2Store: Map<string, { body: ArrayBuffer; opts?: unknown }>;

function createMockEnv(): Env {
  kvStore = new Map();
  r2Store = new Map();

  return {
    TELEGRAM_BOT_TOKEN: "TEST_BOT_TOKEN",
    OPENAI_API_KEY: "TEST_OPENAI_KEY",
    GEMINI_API_KEY: "TEST_GEMINI_KEY",
    LINEAR_API_KEY: "TEST_LINEAR_KEY",
    LINEAR_TEAM_ID: "test-team-id",
    ALLOWED_CHATS: "-5036236504,7908321073",
    ADMIN_USERS: "123",
    BUG_REPORTS: {
      get: vi.fn(async (key: string) => {
        const entry = kvStore.get(key);
        return entry ? entry.value : null;
      }),
      put: vi.fn(async (key: string, value: string, opts?: unknown) => {
        kvStore.set(key, { value, opts });
      }),
      delete: vi.fn(async (key: string) => {
        kvStore.delete(key);
      }),
      list: vi.fn(async () => ({ keys: [] })),
    } as unknown as KVNamespace,
    MEDIA_BUCKET: {
      get: vi.fn(async (key: string) => {
        const entry = r2Store.get(key);
        if (!entry) return null;
        return {
          body: entry.body,
          httpMetadata: { contentType: "image/jpeg" },
        };
      }),
      put: vi.fn(async (key: string, body: ArrayBuffer, opts?: unknown) => {
        r2Store.set(key, { body, opts });
      }),
    } as unknown as R2Bucket,
  };
}

function createMockCtx(): ExecutionContext {
  return {
    waitUntil: vi.fn((p: Promise<unknown>) => p),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
}

function webhookRequest(body: TelegramUpdate, origin = "https://bot.test"): Request {
  return new Request(`${origin}/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function linearWebhookRequest(body: LinearWebhookPayload, origin = "https://bot.test"): Request {
  return new Request(`${origin}/linear-webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function mediaRequest(key: string, origin = "https://bot.test"): Request {
  return new Request(`${origin}/media/${key}`, { method: "GET" });
}

// Parse body from a fetch call
function parseFetchBody(call: { body?: unknown }): Record<string, unknown> {
  if (typeof call.body === "string") return JSON.parse(call.body);
  return call.body as Record<string, unknown>;
}

// Find fetch calls to a specific URL pattern
function findFetchCalls(pattern: string | RegExp): typeof fetchCalls {
  return fetchCalls.filter((c) =>
    typeof pattern === "string" ? c.url.includes(pattern) : pattern.test(c.url),
  );
}

// Standard OpenAI mock response
function openAIResponse(report: { title: string; description: string; priority: number; labels: string[]; assignee?: string | null }) {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(report) } }],
    }),
  };
}

// Standard Gemini mock response
function geminiResponse(report: { title: string; description: string; priority: number; labels: string[]; assignee?: string | null }) {
  return {
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify(report) }] } }],
    }),
  };
}

// Standard Composio mock response for issue creation
function composioCreateIssueResponse(id = "linear-issue-id-123", identifier = "VAL-10") {
  return {
    ok: true,
    json: async () => ({
      data: {
        id,
        ticket_url: `https://linear.app/valwin/issue/${identifier}/test-issue`,
      },
    }),
  };
}

// Standard Composio mock response for other tools
function composioOKResponse(data: Record<string, unknown> = {}) {
  return { ok: true, json: async () => ({ data }) };
}

// Telegram sendMessage response
function telegramOKResponse() {
  return { ok: true, json: async () => ({ ok: true, result: {} }) };
}

// Telegram getFile response
function telegramFileResponse(filePath: string) {
  return {
    ok: true,
    json: async () => ({ ok: true, result: { file_id: "fid", file_unique_id: "uid", file_path: filePath } }),
  };
}

// Binary file download response
function fileDownloadResponse(contentType = "image/jpeg") {
  const buffer = new ArrayBuffer(16);
  return {
    ok: true,
    arrayBuffer: async () => buffer,
    headers: new Headers({ "content-type": contentType }),
  };
}

// Setup global fetch mock with routing
function setupFetchMock(overrides: Record<string, () => unknown> = {}) {
  fetchCalls = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    let body: unknown;
    if (init?.body) {
      if (typeof init.body === "string") {
        try { body = JSON.parse(init.body); } catch { body = init.body; }
      } else {
        body = init.body; // ArrayBuffer or other binary
      }
    }
    fetchCalls.push({ url, init: init || {}, body });

    // Check overrides first
    for (const [pattern, handler] of Object.entries(overrides)) {
      if (url.includes(pattern)) return handler();
    }

    // Default routing
    if (url.includes("/sendMessage") || url.includes("/editMessageText") ||
        url.includes("/answerCallbackQuery")) {
      return telegramOKResponse();
    }
    if (url.includes("/getFile")) {
      return telegramFileResponse("photos/test.jpg");
    }
    if (url.includes("api.telegram.org/file/")) {
      return fileDownloadResponse();
    }
    if (url.includes("api.openai.com")) {
      return openAIResponse({
        title: "Тестовый баг",
        description: "## Описание\nТест",
        priority: 3,
        labels: ["Баг", "Фронтенд"],
      });
    }
    if (url.includes("generativelanguage.googleapis.com/upload/")) {
      return {
        ok: true,
        json: async () => ({
          file: { name: "files/test123", uri: "https://generativelanguage.googleapis.com/v1beta/files/test123", state: "ACTIVE" },
        }),
      };
    }
    if (url.includes("generativelanguage.googleapis.com")) {
      return geminiResponse({
        title: "Тестовый баг (видео)",
        description: "## Описание\nТест видео",
        priority: 3,
        labels: ["Баг", "Фронтенд"],
      });
    }
    if (url.includes("LINEAR_CREATE_LINEAR_ISSUE")) {
      return composioCreateIssueResponse();
    }
    if (url.includes("LINEAR_SEARCH_ISSUES")) {
      return composioOKResponse({ issues: [] });
    }
    if (url.includes("LINEAR_UPDATE_ISSUE")) {
      return composioOKResponse({});
    }
    if (url.includes("LINEAR_CREATE_LINEAR_COMMENT")) {
      return composioOKResponse({});
    }
    if (url.includes("LINEAR_GET_LINEAR_ISSUE")) {
      return composioOKResponse({
        title: "Test Issue",
        state: { name: "В работе" },
        priority: 2,
        url: "https://linear.app/test/issue/VAL-5/test",
      });
    }
    if (url.includes("LINEAR_LIST_ISSUES_BY_TEAM_ID")) {
      return composioOKResponse({ issues: [] });
    }
    if (url.includes("composio.dev")) {
      return composioOKResponse({});
    }

    return { ok: false, status: 404, text: async () => "Not found" };
  }) as unknown as typeof fetch;
}

// ============================================================
// Base message templates
// ============================================================

const baseUser = { id: 123, first_name: "Тестер", last_name: "Иванов", username: "tester" };

function textMessage(text: string, chatId = -5036236504): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 100,
      from: baseUser,
      chat: { id: chatId, type: "group" },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  };
}

function photoMessage(caption = "/report Баг на экране", chatId = -5036236504): TelegramUpdate {
  return {
    update_id: 2,
    message: {
      message_id: 101,
      from: baseUser,
      chat: { id: chatId, type: "group" },
      date: Math.floor(Date.now() / 1000),
      caption,
      photo: [
        { file_id: "small", file_unique_id: "s1", width: 90, height: 90 },
        { file_id: "large", file_unique_id: "l1", width: 800, height: 600 },
      ],
    },
  };
}

function videoMessage(caption = "/report Видео бага", chatId = -5036236504): TelegramUpdate {
  return {
    update_id: 3,
    message: {
      message_id: 102,
      from: baseUser,
      chat: { id: chatId, type: "group" },
      date: Math.floor(Date.now() / 1000),
      caption,
      video: {
        file_id: "vid1",
        file_unique_id: "v1",
        width: 1920,
        height: 1080,
        duration: 10,
        thumbnail: { file_id: "thumb1", file_unique_id: "t1", width: 320, height: 180 },
        file_name: "bug.mp4",
        mime_type: "video/mp4",
        file_size: 5 * 1024 * 1024,
      },
    },
  };
}

function mediaGroupMessage(
  groupId: string,
  msgId: number,
  fileId: string,
  caption?: string,
  chatId = -5036236504,
): TelegramUpdate {
  return {
    update_id: 10 + msgId,
    message: {
      message_id: msgId,
      from: baseUser,
      chat: { id: chatId, type: "group" },
      date: Math.floor(Date.now() / 1000),
      caption,
      media_group_id: groupId,
      photo: [
        { file_id: `${fileId}_small`, file_unique_id: `${fileId}_s`, width: 90, height: 90 },
        { file_id: fileId, file_unique_id: `${fileId}_l`, width: 800, height: 600 },
      ],
    },
  };
}

function callbackQuery(action: string, linearIssueId: string): TelegramUpdate {
  return {
    update_id: 50,
    callback_query: {
      id: "cq-1",
      from: baseUser,
      message: {
        message_id: 200,
        chat: { id: -5036236504, type: "group" },
        date: Math.floor(Date.now() / 1000),
      },
      data: `${action}:${linearIssueId}`,
    },
  };
}

// ============================================================
// Tests
// ============================================================

describe("Bug Reporter Bot", () => {
  let env: Env;
  let ctx: ExecutionContext;

  beforeEach(() => {
    env = createMockEnv();
    ctx = createMockCtx();
    setupFetchMock();
  });

  // ----------------------------------------------------------
  // Routing
  // ----------------------------------------------------------

  describe("Routing", () => {
    it("GET / returns health check", async () => {
      const req = new Request("https://bot.test/", { method: "GET" });
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("Bug Reporter Bot is running");
    });

    it("POST /webhook returns 200", async () => {
      const res = await worker.fetch(webhookRequest(textMessage("test")), env, ctx);
      expect(res.status).toBe(200);
    });

    it("POST /linear-webhook returns 200", async () => {
      const payload: LinearWebhookPayload = {
        action: "update", type: "Issue",
        data: { id: "x", identifier: "VAL-1", title: "Test" },
      };
      const res = await worker.fetch(linearWebhookRequest(payload), env, ctx);
      expect(res.status).toBe(200);
    });

    it("unknown paths return 404", async () => {
      const req = new Request("https://bot.test/unknown", { method: "GET" });
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(404);
    });

    it("GET /media/:key serves R2 objects", async () => {
      const buf = new ArrayBuffer(8);
      r2Store.set("photo/test.jpg", { body: buf });
      const res = await worker.fetch(mediaRequest("photo/test.jpg"), env, ctx);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/jpeg");
      expect(res.headers.get("Cache-Control")).toContain("max-age=31536000");
    });

    it("GET /media/:key returns 404 for missing key", async () => {
      const res = await worker.fetch(mediaRequest("missing/key"), env, ctx);
      expect(res.status).toBe(404);
    });
  });

  // ----------------------------------------------------------
  // Chat access control
  // ----------------------------------------------------------

  describe("Access Control", () => {
    it("ignores messages from non-allowed chats", async () => {
      const update = textMessage("баг", 999999);
      await worker.fetch(webhookRequest(update), env, ctx);
      // Should NOT call OpenAI or Composio
      expect(findFetchCalls("openai.com").length).toBe(0);
      expect(findFetchCalls("composio.dev").length).toBe(0);
    });

    it("processes /report from allowed group chat", async () => {
      const update = textMessage("/report Кнопка не работает");
      await worker.fetch(webhookRequest(update), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];
      expect(findFetchCalls("openai.com").length).toBe(1);
    });

    it("ignores bare messages in group chat", async () => {
      const update = textMessage("Кнопка не работает");
      await worker.fetch(webhookRequest(update), env, ctx);
      expect(findFetchCalls("openai.com").length).toBe(0);
    });
  });

  // ----------------------------------------------------------
  // Single text report
  // ----------------------------------------------------------

  describe("Single Text Report", () => {
    it("sends processing message then creates Linear issue", async () => {
      await worker.fetch(webhookRequest(textMessage("/report Кнопка не работает")), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      // Should send "Обрабатываю" message
      const sendCalls = findFetchCalls("/sendMessage");
      expect(sendCalls.length).toBeGreaterThanOrEqual(2);
      const firstBody = parseFetchBody(sendCalls[0]);
      expect(firstBody.text).toContain("Обрабатываю");

      // Should call OpenAI
      expect(findFetchCalls("openai.com").length).toBe(1);

      // Should search for duplicates
      expect(findFetchCalls("LINEAR_SEARCH_ISSUES").length).toBe(1);

      // Should create Linear issue
      expect(findFetchCalls("LINEAR_CREATE_LINEAR_ISSUE").length).toBe(1);

      // Should send confirmation with issue link
      const lastSend = sendCalls[sendCalls.length - 1];
      const lastBody = parseFetchBody(lastSend);
      expect(lastBody.text).toContain("Баг-репорт создан");
      expect(lastBody.text).toContain("VAL-10");
    });

    it("sends bug report text to OpenAI", async () => {
      await worker.fetch(webhookRequest(textMessage("/report Кнопка логина не работает после обновления")), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      const aiCall = findFetchCalls("openai.com")[0];
      const body = parseFetchBody(aiCall);
      const messages = body.messages as { role: string; content: unknown }[];
      const userContent = messages[1].content as { type: string; text?: string }[];
      const textPart = userContent.find((c) => c.type === "text");
      expect(textPart?.text).toContain("Кнопка логина не работает");
    });

    it("stores issue mapping in KV", async () => {
      await worker.fetch(webhookRequest(textMessage("/report Баг")), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      expect(kvStore.has("issue:linear-issue-id-123")).toBe(true);
      const mapping = JSON.parse(kvStore.get("issue:linear-issue-id-123")!.value);
      expect(mapping.issueId).toBe("VAL-10");
      expect(mapping.reporterName).toBe("Тестер Иванов");
      expect(mapping.issueUrl).toContain("linear.app");
    });

    it("handles OpenAI errors gracefully", async () => {
      setupFetchMock({
        "openai.com": () => ({ ok: false, status: 500, text: async () => "Server Error" }),
      });

      await worker.fetch(webhookRequest(textMessage("/report Баг")), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      const sendCalls = findFetchCalls("/sendMessage");
      const lastBody = parseFetchBody(sendCalls[sendCalls.length - 1]);
      expect(lastBody.text).toContain("Не удалось создать");
    });

    it("handles Composio errors gracefully", async () => {
      setupFetchMock({
        "LINEAR_CREATE_LINEAR_ISSUE": () => ({ ok: false, status: 500, text: async () => "Composio Error" }),
      });

      await worker.fetch(webhookRequest(textMessage("/report Баг")), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      const sendCalls = findFetchCalls("/sendMessage");
      const lastBody = parseFetchBody(sendCalls[sendCalls.length - 1]);
      expect(lastBody.text).toContain("Не удалось создать");
    });
  });

  // ----------------------------------------------------------
  // Photo report
  // ----------------------------------------------------------

  describe("Photo Report", () => {
    it("downloads photo and sends to OpenAI as image", async () => {
      await worker.fetch(webhookRequest(photoMessage()), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      // Should call getFile for the largest photo
      const getFileCalls = findFetchCalls("/getFile");
      expect(getFileCalls.length).toBeGreaterThanOrEqual(1);
      const getFileBody = parseFetchBody(getFileCalls[0]);
      expect(getFileBody.file_id).toBe("large"); // picks largest

      // Should download the file
      expect(findFetchCalls("api.telegram.org/file/").length).toBeGreaterThanOrEqual(1);

      // Should upload to R2
      expect(r2Store.size).toBeGreaterThanOrEqual(1);

      // OpenAI should receive image
      const aiCall = findFetchCalls("openai.com")[0];
      const body = parseFetchBody(aiCall);
      const messages = body.messages as { role: string; content: unknown }[];
      const userContent = messages[1].content as { type: string; image_url?: unknown }[];
      const imageParts = userContent.filter((c) => c.type === "image_url");
      expect(imageParts.length).toBe(1);
    });

    it("includes caption as text in report", async () => {
      await worker.fetch(webhookRequest(photoMessage("/report Ошибка при логине")), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      const aiCall = findFetchCalls("openai.com")[0];
      const body = parseFetchBody(aiCall);
      const messages = body.messages as { role: string; content: unknown }[];
      const userContent = messages[1].content as { type: string; text?: string }[];
      const textPart = userContent.find((c) => c.type === "text");
      expect(textPart?.text).toContain("Ошибка при логине");
    });

    it("includes media URL in Linear issue description", async () => {
      await worker.fetch(webhookRequest(photoMessage()), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      const createCall = findFetchCalls("LINEAR_CREATE_LINEAR_ISSUE")[0];
      const body = parseFetchBody(createCall);
      const args = (body as { arguments: Record<string, unknown> }).arguments;
      expect((args.description as string)).toContain("Вложения");
      expect((args.description as string)).toContain("/media/");
    });
  });

  // ----------------------------------------------------------
  // Video report (#10)
  // ----------------------------------------------------------

  describe("Video Report", () => {
    it("downloads thumbnail and video, uploads to R2", async () => {
      await worker.fetch(webhookRequest(videoMessage()), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      // Should call getFile for thumbnail + video
      const getFileCalls = findFetchCalls("/getFile");
      expect(getFileCalls.length).toBeGreaterThanOrEqual(2);

      // File IDs should include thumbnail and video
      const fileIds = getFileCalls.map((c) => parseFetchBody(c).file_id);
      expect(fileIds).toContain("thumb1");
      expect(fileIds).toContain("vid1");

      // R2 should have at least a video
      const videoKeys = [...r2Store.keys()].filter((k) => k.startsWith("video/"));
      expect(videoKeys.length).toBeGreaterThanOrEqual(1);
    });

    it("sends video to Gemini instead of OpenAI", async () => {
      await worker.fetch(webhookRequest(videoMessage()), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      // Should upload to Gemini File API
      expect(findFetchCalls("generativelanguage.googleapis.com/upload/").length).toBe(1);

      // Should call Gemini generateContent (not OpenAI)
      const geminiCalls = findFetchCalls("generativelanguage.googleapis.com").filter(
        (c) => !c.url.includes("/upload/") && !c.url.includes("/v1beta/files/"),
      );
      expect(geminiCalls.length).toBe(1);
      expect(findFetchCalls("openai.com").length).toBe(0);

      // Gemini should receive file_data reference
      const body = parseFetchBody(geminiCalls[0]);
      const contents = body.contents as { parts: { file_data?: { file_uri: string } }[] }[];
      const fileParts = contents[0].parts.filter((p) => p.file_data);
      expect(fileParts.length).toBeGreaterThanOrEqual(1);
    });

    it("falls back to OpenAI when no GEMINI_API_KEY", async () => {
      env.GEMINI_API_KEY = "";
      await worker.fetch(webhookRequest(videoMessage()), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      // Should call OpenAI with thumbnail, not Gemini
      expect(findFetchCalls("openai.com").length).toBe(1);
      expect(findFetchCalls("generativelanguage.googleapis.com").length).toBe(0);
    });
  });

  // ----------------------------------------------------------
  // Media groups (#1)
  // ----------------------------------------------------------

  describe("Media Group Batching", () => {
    it("stores first message in KV buffer", async () => {
      const update = mediaGroupMessage("mg-1", 201, "photo1", "/report Баг с группой фото");
      await worker.fetch(webhookRequest(update), env, ctx);
      // waitUntil triggers the async handler — it will sleep then process
      // We check that KV was written before processing
      const putCalls = (env.BUG_REPORTS.put as Mock).mock.calls;
      const mgPut = putCalls.find((c: unknown[]) => (c[0] as string).startsWith("mediagroup:"));
      expect(mgPut).toBeDefined();
    });

    it("second message in group updates existing buffer", async () => {
      // Pre-store a buffer
      const existingBuffer = {
        chatId: -5036236504,
        text: "Описание",
        reporterName: "Тестер Иванов",
        firstMessageId: 201,
        photos: ["photo1"],
        videoFileIds: [],
        videoThumbIds: [],
        timestamp: Date.now(),
      };
      kvStore.set("mediagroup:mg-2", { value: JSON.stringify(existingBuffer) });

      const update = mediaGroupMessage("mg-2", 202, "photo2");
      await worker.fetch(webhookRequest(update), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      // Should have updated KV with 2 photos
      const putCalls = (env.BUG_REPORTS.put as Mock).mock.calls;
      const mgPut = putCalls.find((c: unknown[]) => (c[0] as string) === "mediagroup:mg-2");
      expect(mgPut).toBeDefined();
      const saved = JSON.parse(mgPut![1] as string);
      expect(saved.photos).toContain("photo2");
    });

    it("does not send duplicate 'processing' message for second photo", async () => {
      // Pre-store buffer (simulates first msg already arrived)
      const existingBuffer = {
        chatId: -5036236504,
        text: "Баг",
        reporterName: "Тестер",
        firstMessageId: 201,
        photos: ["photo1"],
        videoFileIds: [],
        videoThumbIds: [],
        timestamp: Date.now(),
      };
      kvStore.set("mediagroup:mg-3", { value: JSON.stringify(existingBuffer) });

      const update = mediaGroupMessage("mg-3", 202, "photo2");
      await worker.fetch(webhookRequest(update), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      // Should NOT send "Обрабатываю" for second message
      const sendCalls = findFetchCalls("/sendMessage");
      const processingMsgs = sendCalls.filter((c) => {
        const body = parseFetchBody(c);
        return typeof body.text === "string" && body.text.includes("Обрабатываю");
      });
      expect(processingMsgs.length).toBe(0);
    });
  });

  // ----------------------------------------------------------
  // Commands (#6)
  // ----------------------------------------------------------

  describe("Commands", () => {
    describe("/start", () => {
      it("sends welcome message with command list", async () => {
        await worker.fetch(webhookRequest(textMessage("/start")), env, ctx);
        await (ctx.waitUntil as Mock).mock.calls[0][0];

        const sendCalls = findFetchCalls("/sendMessage");
        expect(sendCalls.length).toBe(1);
        const body = parseFetchBody(sendCalls[0]);
        expect(body.text).toContain("Привет");
        expect(body.text).toContain("/status");
        expect(body.text).toContain("/list");
        expect(body.text).toContain("/urgent");
      });
    });

    describe("/status", () => {
      it("returns issue status from Linear", async () => {
        await worker.fetch(webhookRequest(textMessage("/status VAL-5")), env, ctx);
        await (ctx.waitUntil as Mock).mock.calls[0][0];

        // Should call LINEAR_GET_LINEAR_ISSUE
        expect(findFetchCalls("LINEAR_GET_LINEAR_ISSUE").length).toBe(1);

        const sendCalls = findFetchCalls("/sendMessage");
        const lastBody = parseFetchBody(sendCalls[sendCalls.length - 1]);
        expect(lastBody.text).toContain("VAL-5");
        expect(lastBody.text).toContain("В работе");
      });

      it("shows usage when no issue ID provided", async () => {
        await worker.fetch(webhookRequest(textMessage("/status")), env, ctx);
        await (ctx.waitUntil as Mock).mock.calls[0][0];

        const sendCalls = findFetchCalls("/sendMessage");
        const body = parseFetchBody(sendCalls[0]);
        expect(body.text).toContain("Использование");
      });

      it("handles issue not found", async () => {
        setupFetchMock({
          "LINEAR_GET_LINEAR_ISSUE": () => ({ ok: false, status: 404, text: async () => "Not found" }),
        });

        await worker.fetch(webhookRequest(textMessage("/status VAL-999")), env, ctx);
        await (ctx.waitUntil as Mock).mock.calls[0][0];

        const sendCalls = findFetchCalls("/sendMessage");
        const lastBody = parseFetchBody(sendCalls[sendCalls.length - 1]);
        expect(lastBody.text).toContain("не найдена");
      });
    });

    describe("/list", () => {
      it("shows open issues", async () => {
        setupFetchMock({
          "LINEAR_LIST_ISSUES_BY_TEAM_ID": () => composioOKResponse({
            issues: [
              { identifier: "VAL-1", title: "Bug one", state: { name: "В работе" }, priority: 2, createdAt: new Date().toISOString() },
              { identifier: "VAL-2", title: "Bug two", state: { name: "Новые" }, priority: 3, createdAt: new Date().toISOString() },
              { identifier: "VAL-3", title: "Done one", state: { name: "Готово" }, priority: 4, createdAt: new Date().toISOString() },
            ],
          }),
        });

        await worker.fetch(webhookRequest(textMessage("/list")), env, ctx);
        await (ctx.waitUntil as Mock).mock.calls[0][0];

        const sendCalls = findFetchCalls("/sendMessage");
        const body = parseFetchBody(sendCalls[sendCalls.length - 1]);
        expect(body.text).toContain("Открытые задачи (2)");
        expect(body.text).toContain("VAL-1");
        expect(body.text).toContain("VAL-2");
        expect(body.text).not.toContain("VAL-3"); // Done — filtered out
      });

      it("shows empty state when no open issues", async () => {
        setupFetchMock({
          "LINEAR_LIST_ISSUES_BY_TEAM_ID": () => composioOKResponse({ issues: [] }),
        });

        await worker.fetch(webhookRequest(textMessage("/list")), env, ctx);
        await (ctx.waitUntil as Mock).mock.calls[0][0];

        const sendCalls = findFetchCalls("/sendMessage");
        const body = parseFetchBody(sendCalls[sendCalls.length - 1]);
        expect(body.text).toContain("Нет открытых задач");
      });
    });

    describe("/urgent", () => {
      it("creates issue with priority 1", async () => {
        await worker.fetch(webhookRequest(textMessage("/urgent Приложение крашится при запуске")), env, ctx);
        await (ctx.waitUntil as Mock).mock.calls[0][0];

        // Should call OpenAI
        expect(findFetchCalls("openai.com").length).toBe(1);

        // Should create issue
        const createCall = findFetchCalls("LINEAR_CREATE_LINEAR_ISSUE")[0];
        const body = parseFetchBody(createCall);
        const args = (body as { arguments: Record<string, unknown> }).arguments;
        expect(args.priority).toBe(1); // Forced urgent

        // Confirmation should say СРОЧНО
        const sendCalls = findFetchCalls("/sendMessage");
        const lastBody = parseFetchBody(sendCalls[sendCalls.length - 1]);
        expect(lastBody.text).toContain("СРОЧНО");
      });

      it("shows usage when no text provided", async () => {
        await worker.fetch(webhookRequest(textMessage("/urgent")), env, ctx);
        await (ctx.waitUntil as Mock).mock.calls[0][0];

        const sendCalls = findFetchCalls("/sendMessage");
        const body = parseFetchBody(sendCalls[0]);
        expect(body.text).toContain("Использование");
      });
    });
  });

  // ----------------------------------------------------------
  // /team command
  // ----------------------------------------------------------

  describe("/team Command", () => {
    function privateTextMessage(text: string): TelegramUpdate {
      return {
        update_id: 70,
        message: {
          message_id: 300,
          from: baseUser,
          chat: { id: 7908321073, type: "private" },
          date: Math.floor(Date.now() / 1000),
          text,
        },
      };
    }

    it("shows empty team panel with buttons", async () => {
      await worker.fetch(webhookRequest(privateTextMessage("/team")), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      const sendCalls = findFetchCalls("/sendMessage");
      const body = parseFetchBody(sendCalls[sendCalls.length - 1]);
      expect(body.text).toContain("Управление командой");
      expect(body.text).toContain("Нет ролей");
      expect(body.reply_markup).toBeDefined();
      const keyboard = (body.reply_markup as { inline_keyboard: unknown[][] }).inline_keyboard;
      expect(keyboard.length).toBe(1); // only "+ Добавить роль" button
    });

    it("shows configured team with member name", async () => {
      kvStore.set("settings:team", { value: JSON.stringify({
        frontend: { name: "Frontend", member: { userId: "u1", name: "Иван", email: "ivan@test.com" } },
      }) });

      await worker.fetch(webhookRequest(privateTextMessage("/team")), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      const sendCalls = findFetchCalls("/sendMessage");
      const body = parseFetchBody(sendCalls[sendCalls.length - 1]);
      expect(body.text).toContain("Иван");
    });

    it("adds team member by email", async () => {
      setupFetchMock({
        "LINEAR_RUN_QUERY_OR_MUTATION": () => composioOKResponse({
          data: { users: { nodes: [{ id: "lin-user-1", name: "Иван Иванов", email: "ivan@test.com" }] } },
        }),
      });

      await worker.fetch(webhookRequest(privateTextMessage("/team Frontend ivan@test.com")), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      // Should store in KV
      expect(kvStore.has("settings:team")).toBe(true);
      const team = JSON.parse(kvStore.get("settings:team")!.value);
      expect(team.frontend.member.userId).toBe("lin-user-1");
      expect(team.frontend.member.email).toBe("ivan@test.com");

      // Should send confirmation
      const sendCalls = findFetchCalls("/sendMessage");
      const lastBody = parseFetchBody(sendCalls[sendCalls.length - 1]);
      expect(lastBody.text).toContain("Frontend");
      expect(lastBody.text).toContain("Иван Иванов");
    });

    it("handles user not found in Linear", async () => {
      setupFetchMock({
        "LINEAR_RUN_QUERY_OR_MUTATION": () => composioOKResponse({
          data: { users: { nodes: [] } },
        }),
      });

      await worker.fetch(webhookRequest(privateTextMessage("/team backend unknown@test.com")), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      const sendCalls = findFetchCalls("/sendMessage");
      const lastBody = parseFetchBody(sendCalls[sendCalls.length - 1]);
      expect(lastBody.text).toContain("не найден");
    });

    it("shows confirmation before deleting role", async () => {
      kvStore.set("settings:team", { value: JSON.stringify({
        frontend: { name: "Frontend", member: { userId: "u1", name: "Иван", email: "ivan@test.com" } },
        backend: { name: "Backend", member: { userId: "u2", name: "Пётр", email: "petr@test.com" } },
      }) });

      // Step 1: Click delete — shows confirmation
      const delUpdate: TelegramUpdate = {
        update_id: 80,
        callback_query: {
          id: "cq-team-1",
          from: baseUser,
          message: {
            message_id: 400,
            chat: { id: 7908321073, type: "private" },
            date: Math.floor(Date.now() / 1000),
          },
          data: "team:del:frontend",
        },
      };
      await worker.fetch(webhookRequest(delUpdate), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      // Role not yet deleted
      const teamBefore = JSON.parse(kvStore.get("settings:team")!.value);
      expect(teamBefore.frontend).toBeDefined();

      // Confirmation message shown
      const editCalls1 = findFetchCalls("/editMessageText");
      const editBody1 = parseFetchBody(editCalls1[editCalls1.length - 1]);
      expect(editBody1.text).toContain("Удалить роль");

      // Step 2: Confirm deletion
      vi.mocked(fetch).mockClear();
      (ctx.waitUntil as Mock).mockClear();

      const confirmUpdate: TelegramUpdate = {
        update_id: 81,
        callback_query: {
          id: "cq-team-2",
          from: baseUser,
          message: {
            message_id: 400,
            chat: { id: 7908321073, type: "private" },
            date: Math.floor(Date.now() / 1000),
          },
          data: "team:delok:frontend",
        },
      };
      await worker.fetch(webhookRequest(confirmUpdate), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      const teamAfter = JSON.parse(kvStore.get("settings:team")!.value);
      expect(teamAfter.frontend).toBeUndefined();
      expect(teamAfter.backend).toBeDefined();

      const editCalls2 = findFetchCalls("/editMessageText");
      const editBody2 = parseFetchBody(editCalls2[editCalls2.length - 1]);
      expect(editBody2.text).toContain("Управление командой");
    });

    it("rejects direct command without email", async () => {
      await worker.fetch(webhookRequest(privateTextMessage("/team manager")), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      const sendCalls = findFetchCalls("/sendMessage");
      const body = parseFetchBody(sendCalls[sendCalls.length - 1]);
      expect(body.text).toContain("Использование");
    });

    it("navigates to role detail via callback", async () => {
      kvStore.set("settings:team", { value: JSON.stringify({
        frontend: { name: "Frontend", member: { userId: "u1", name: "Иван", email: "ivan@test.com" } },
      }) });

      const update: TelegramUpdate = {
        update_id: 81,
        callback_query: {
          id: "cq-team-2",
          from: baseUser,
          message: {
            message_id: 400,
            chat: { id: 7908321073, type: "private" },
            date: Math.floor(Date.now() / 1000),
          },
          data: "team:view:frontend",
        },
      };
      await worker.fetch(webhookRequest(update), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      const editCalls = findFetchCalls("/editMessageText");
      expect(editCalls.length).toBe(1);
      const body = parseFetchBody(editCalls[0]);
      expect(body.text).toContain("Frontend");
      expect(body.text).toContain("Иван");
      expect(body.text).toContain("ivan@test.com");
      // Should have action buttons + back
      const keyboard = (body.reply_markup as { inline_keyboard: unknown[][] }).inline_keyboard;
      expect(keyboard.length).toBe(2); // actions row + back row
    });

    it("set flow: stores pending and asks for email", async () => {
      // Role must exist in KV for setm to work
      kvStore.set("settings:team", { value: JSON.stringify({
        backend: { name: "Backend" },
      }) });

      const update: TelegramUpdate = {
        update_id: 82,
        callback_query: {
          id: "cq-team-3",
          from: baseUser,
          message: {
            message_id: 400,
            chat: { id: 7908321073, type: "private" },
            date: Math.floor(Date.now() / 1000),
          },
          data: "team:setm:backend",
        },
      };
      await worker.fetch(webhookRequest(update), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      // Should store pending team set
      expect(kvStore.has("pending_team_set:7908321073:123")).toBe(true);
      const pending = JSON.parse(kvStore.get("pending_team_set:7908321073:123")!.value);
      expect(pending.role).toBe("backend");
      expect(pending.panelMessageId).toBe(400);

      // Should edit message to ask for email
      const editCalls = findFetchCalls("/editMessageText");
      const body = parseFetchBody(editCalls[0]);
      expect(body.text).toContain("email");
    });

    it("processes email after set flow", async () => {
      // Pre-set pending state and existing role
      kvStore.set("pending_team_set:7908321073:123", { value: JSON.stringify({
        role: "backend",
        panelChatId: 7908321073,
        panelMessageId: 400,
      }) });
      kvStore.set("settings:team", { value: JSON.stringify({
        backend: { name: "Backend" },
      }) });

      setupFetchMock({
        "LINEAR_RUN_QUERY_OR_MUTATION": () => composioOKResponse({
          data: { users: { nodes: [{ id: "lin-back-1", name: "Пётр Петров", email: "petr@test.com" }] } },
        }),
      });

      // User sends email as plain text
      const update: TelegramUpdate = {
        update_id: 83,
        message: {
          message_id: 301,
          from: baseUser,
          chat: { id: 7908321073, type: "private" },
          date: Math.floor(Date.now() / 1000),
          text: "petr@test.com",
        },
      };
      await worker.fetch(webhookRequest(update), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      // Should store team member
      expect(kvStore.has("settings:team")).toBe(true);
      const team = JSON.parse(kvStore.get("settings:team")!.value);
      expect(team.backend.member.userId).toBe("lin-back-1");

      // Should send confirmation
      const sendCalls = findFetchCalls("/sendMessage");
      const confirmBody = parseFetchBody(sendCalls[sendCalls.length - 1]);
      expect(confirmBody.text).toContain("Backend");
      expect(confirmBody.text).toContain("Пётр Петров");

      // Pending state should be cleared
      expect(kvStore.has("pending_team_set:7908321073:123")).toBe(false);
    });

    it("rejects /team in group chat", async () => {
      const groupMsg = textMessage("/team"); // uses group chat ID
      await worker.fetch(webhookRequest(groupMsg), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      const sendCalls = findFetchCalls("/sendMessage");
      const body = parseFetchBody(sendCalls[0]);
      expect(body.text).toContain("только в личном чате");
    });

    it("rejects /team from non-admin user in allowed chat", async () => {
      const nonAdminMsg: TelegramUpdate = {
        update_id: 90,
        message: {
          message_id: 300,
          from: { id: 999, first_name: "Хакер" },
          chat: { id: 7908321073, type: "private" },
          date: Math.floor(Date.now() / 1000),
          text: "/team",
        },
      };
      await worker.fetch(webhookRequest(nonAdminMsg), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      const sendCalls = findFetchCalls("/sendMessage");
      const body = parseFetchBody(sendCalls[sendCalls.length - 1]);
      expect(body.text).toContain("нет доступа");
    });

    it("rejects team callback from non-admin user", async () => {
      kvStore.set("settings:team", { value: JSON.stringify({
        frontend: { name: "Frontend", member: { userId: "u1", name: "Иван", email: "ivan@test.com" } },
      }) });

      const update: TelegramUpdate = {
        update_id: 91,
        callback_query: {
          id: "cq-hacker",
          from: { id: 999, first_name: "Хакер" },
          message: {
            message_id: 400,
            chat: { id: 999, type: "private" },
            date: Math.floor(Date.now() / 1000),
          },
          data: "team:del:frontend",
        },
      };
      await worker.fetch(webhookRequest(update), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      // Role should NOT be deleted
      const team = JSON.parse(kvStore.get("settings:team")!.value);
      expect(team.frontend).toBeDefined();
    });
  });

  // ----------------------------------------------------------
  // Duplicate detection (#4)
  // ----------------------------------------------------------

  describe("Duplicate Detection", () => {
    it("warns about potential duplicates", async () => {
      setupFetchMock({
        "LINEAR_SEARCH_ISSUES": () => composioOKResponse({
          issues: [
            { id: "dup-1", identifier: "VAL-3", title: "Похожий баг", url: "https://linear.app/test/VAL-3", state: { name: "В работе" } },
          ],
        }),
      });

      await worker.fetch(webhookRequest(textMessage("/report Баг")), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      const sendCalls = findFetchCalls("/sendMessage");
      const lastBody = parseFetchBody(sendCalls[sendCalls.length - 1]);
      expect(lastBody.text).toContain("Возможные дубликаты");
      expect(lastBody.text).toContain("VAL-3");
    });

    it("does not warn for completed similar issues", async () => {
      setupFetchMock({
        "LINEAR_SEARCH_ISSUES": () => composioOKResponse({
          issues: [
            { id: "dup-1", identifier: "VAL-3", title: "Похожий баг", url: "https://linear.app/test/VAL-3", state: { name: "Готово" } },
          ],
        }),
      });

      await worker.fetch(webhookRequest(textMessage("/report Баг")), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      const sendCalls = findFetchCalls("/sendMessage");
      const lastBody = parseFetchBody(sendCalls[sendCalls.length - 1]);
      expect(lastBody.text).not.toContain("Возможные дубликаты");
    });

    it("still creates issue even when duplicates found", async () => {
      setupFetchMock({
        "LINEAR_SEARCH_ISSUES": () => composioOKResponse({
          issues: [
            { id: "dup-1", identifier: "VAL-3", title: "Похожий баг", url: "https://linear.app/test/VAL-3", state: { name: "В работе" } },
          ],
        }),
      });

      await worker.fetch(webhookRequest(textMessage("/report Баг")), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      expect(findFetchCalls("LINEAR_CREATE_LINEAR_ISSUE").length).toBe(1);
    });

    it("ignores search failures silently", async () => {
      setupFetchMock({
        "LINEAR_SEARCH_ISSUES": () => ({ ok: false, status: 500, text: async () => "Error" }),
      });

      await worker.fetch(webhookRequest(textMessage("/report Баг")), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      // Should still create issue
      expect(findFetchCalls("LINEAR_CREATE_LINEAR_ISSUE").length).toBe(1);
      // No duplicate warning
      const sendCalls = findFetchCalls("/sendMessage");
      const lastBody = parseFetchBody(sendCalls[sendCalls.length - 1]);
      expect(lastBody.text).not.toContain("Возможные дубликаты");
    });
  });

  // ----------------------------------------------------------
  // Auto-assignment (#7)
  // ----------------------------------------------------------

  describe("Auto-Assignment", () => {
    const teamConfig = {
      frontend: { name: "Frontend", member: { userId: "user-front", name: "Фронтендер", email: "front@test.com" } },
      backend: { name: "Backend", member: { userId: "user-back", name: "Бэкендер", email: "back@test.com" } },
      design: { name: "Design", member: { userId: "user-design", name: "Дизайнер", email: "design@test.com" } },
    };

    it("assigns frontend when AI picks frontend and shows name", async () => {
      kvStore.set("settings:team", { value: JSON.stringify(teamConfig) });
      setupFetchMock({
        "openai.com": () => openAIResponse({
          title: "Баг интерфейса",
          description: "Тест",
          priority: 3,
          labels: ["Баг", "Фронтенд"],
          assignee: "frontend",
        }),
      });

      await worker.fetch(webhookRequest(textMessage("/report UI баг")), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      const createCall = findFetchCalls("LINEAR_CREATE_LINEAR_ISSUE")[0];
      const body = parseFetchBody(createCall);
      const args = (body as { arguments: Record<string, unknown> }).arguments;
      expect(args.assignee_id).toBe("user-front");

      // Report message should show assignee name and role
      const sendCalls = findFetchCalls("/sendMessage");
      const reportBody = parseFetchBody(sendCalls[sendCalls.length - 1]);
      expect(reportBody.text).toContain("Фронтендер");
      expect(reportBody.text).toContain("Frontend");
    });

    it("assigns backend when AI picks backend", async () => {
      kvStore.set("settings:team", { value: JSON.stringify(teamConfig) });
      setupFetchMock({
        "openai.com": () => openAIResponse({
          title: "Ошибка API",
          description: "Тест",
          priority: 2,
          labels: ["Баг", "API"],
          assignee: "backend",
        }),
      });

      await worker.fetch(webhookRequest(textMessage("/report API баг")), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      const createCall = findFetchCalls("LINEAR_CREATE_LINEAR_ISSUE")[0];
      const body = parseFetchBody(createCall);
      const args = (body as { arguments: Record<string, unknown> }).arguments;
      expect(args.assignee_id).toBe("user-back");
    });

    it("assigns design when AI picks design", async () => {
      kvStore.set("settings:team", { value: JSON.stringify(teamConfig) });
      setupFetchMock({
        "openai.com": () => openAIResponse({
          title: "Новая фича",
          description: "Тест",
          priority: 4,
          labels: ["Доработка", "2D графика"],
          assignee: "design",
        }),
      });

      await worker.fetch(webhookRequest(textMessage("/report Нужна новая иконка")), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      const createCall = findFetchCalls("LINEAR_CREATE_LINEAR_ISSUE")[0];
      const body = parseFetchBody(createCall);
      const args = (body as { arguments: Record<string, unknown> }).arguments;
      expect(args.assignee_id).toBe("user-design");
    });

    it("falls back to manager when AI returns null assignee", async () => {
      const teamWithManager = {
        ...teamConfig,
        pm: { name: "Проект-менеджер", member: { userId: "user-pm", name: "PM", email: "pm@test.com" } },
      };
      kvStore.set("settings:team", { value: JSON.stringify(teamWithManager) });
      setupFetchMock({
        "openai.com": () => openAIResponse({
          title: "Странный баг",
          description: "Тест",
          priority: 4,
          labels: ["Производительность"],
          assignee: null,
        }),
      });

      await worker.fetch(webhookRequest(textMessage("/report Странный баг")), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      const createCall = findFetchCalls("LINEAR_CREATE_LINEAR_ISSUE")[0];
      const body = parseFetchBody(createCall);
      const args = (body as { arguments: Record<string, unknown> }).arguments;
      expect(args.assignee_id).toBe("user-pm");
    });

    it("no assignment when AI returns null and no manager role exists", async () => {
      kvStore.set("settings:team", { value: JSON.stringify(teamConfig) });
      setupFetchMock({
        "openai.com": () => openAIResponse({
          title: "Странный баг",
          description: "Тест",
          priority: 4,
          labels: ["Производительность"],
          assignee: null,
        }),
      });

      await worker.fetch(webhookRequest(textMessage("/report Странный баг")), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      const createCall = findFetchCalls("LINEAR_CREATE_LINEAR_ISSUE")[0];
      const body = parseFetchBody(createCall);
      const args = (body as { arguments: Record<string, unknown> }).arguments;
      expect(args.assignee_id).toBeUndefined();
    });

    it("no assignment when team is empty", async () => {
      // No settings:team in KV
      await worker.fetch(webhookRequest(textMessage("/report Баг")), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      const createCall = findFetchCalls("LINEAR_CREATE_LINEAR_ISSUE")[0];
      const body = parseFetchBody(createCall);
      const args = (body as { arguments: Record<string, unknown> }).arguments;
      expect(args.assignee_id).toBeUndefined();
    });
  });

  // ----------------------------------------------------------
  // Accept/Reject callback buttons
  // ----------------------------------------------------------

  describe("Review Callbacks", () => {
    const linearIssueId = "issue-abc-123";

    beforeEach(() => {
      kvStore.set(`issue:${linearIssueId}`, {
        value: JSON.stringify({
          chatId: -5036236504,
          messageId: 100,
          reporterName: "Тестер Иванов",
          issueId: "VAL-10",
          issueUrl: "https://linear.app/test/issue/VAL-10/test",
          title: "Test Bug",
        } satisfies import("./types").IssueMapping),
      });
    });

    it("accept: moves to Done and edits message", async () => {
      await worker.fetch(webhookRequest(callbackQuery("accept", linearIssueId)), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      // Should update issue state to Done
      const updateCalls = findFetchCalls("LINEAR_UPDATE_ISSUE");
      expect(updateCalls.length).toBe(1);
      const body = parseFetchBody(updateCalls[0]);
      const args = (body as { arguments: Record<string, unknown> }).arguments;
      expect(args.state_id).toBe("a36c8892-9daa-4127-8e36-7553e2afff8a"); // STATE_DONE

      // Should edit the message
      const editCalls = findFetchCalls("/editMessageText");
      expect(editCalls.length).toBe(1);
      const editBody = parseFetchBody(editCalls[0]);
      expect(editBody.text).toContain("принята");

      // Should answer callback
      expect(findFetchCalls("/answerCallbackQuery").length).toBe(1);
    });

    it("reject: stores pending rejection and asks for reason", async () => {
      await worker.fetch(webhookRequest(callbackQuery("reject", linearIssueId)), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      // Should store pending reject in KV
      expect(kvStore.has(`pending_reject:-5036236504:123`)).toBe(true);
      const pending = JSON.parse(kvStore.get(`pending_reject:-5036236504:123`)!.value);
      expect(pending.linearIssueId).toBe(linearIssueId);

      // Should edit message to ask for reason
      const editCalls = findFetchCalls("/editMessageText");
      expect(editCalls.length).toBe(1);
      const editBody = parseFetchBody(editCalls[0]);
      expect(editBody.text).toContain("причину отклонения");
    });

    it("handles missing issue mapping", async () => {
      await worker.fetch(webhookRequest(callbackQuery("accept", "nonexistent")), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      const cbCalls = findFetchCalls("/answerCallbackQuery");
      expect(cbCalls.length).toBe(1);
      const body = parseFetchBody(cbCalls[0]);
      expect(body.text).toContain("не найдена");
    });
  });

  // ----------------------------------------------------------
  // Rejection comment flow (#3)
  // ----------------------------------------------------------

  describe("Rejection Comment Flow", () => {
    const linearIssueId = "issue-reject-123";
    const pendingKey = `pending_reject:-5036236504:123`;

    beforeEach(() => {
      kvStore.set(pendingKey, {
        value: JSON.stringify({
          linearIssueId,
          issueId: "VAL-10",
          botMessageChatId: -5036236504,
          botMessageId: 200,
        } satisfies import("./types").PendingReject),
      });
    });

    it("adds comment to Linear and moves back to In Progress", async () => {
      const update = textMessage("Баг не исправлен, всё ещё крашится");
      await worker.fetch(webhookRequest(update), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      // Should add comment
      const commentCalls = findFetchCalls("LINEAR_CREATE_LINEAR_COMMENT");
      expect(commentCalls.length).toBe(1);
      const commentBody = parseFetchBody(commentCalls[0]);
      const args = (commentBody as { arguments: Record<string, unknown> }).arguments;
      expect(args.body).toContain("Отклонено клиентом");
      expect(args.body).toContain("всё ещё крашится");

      // Should move to In Progress
      const updateCalls = findFetchCalls("LINEAR_UPDATE_ISSUE");
      expect(updateCalls.length).toBe(1);
      const updateBody = parseFetchBody(updateCalls[0]);
      const updateArgs = (updateBody as { arguments: Record<string, unknown> }).arguments;
      expect(updateArgs.state_id).toBe("5c2e2165-d492-4963-b3f2-1eda3a2e7135"); // STATE_IN_PROGRESS

      // Should edit the bot message
      const editCalls = findFetchCalls("/editMessageText");
      expect(editCalls.length).toBe(1);
      const editBody = parseFetchBody(editCalls[0]);
      expect(editBody.text).toContain("отклонена");
      expect(editBody.text).toContain("Возвращена в работу");

      // Should delete pending key
      expect(kvStore.has(pendingKey)).toBe(false);
    });

    it("does not process rejection for commands", async () => {
      const update = textMessage("/list");
      await worker.fetch(webhookRequest(update), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      // Pending reject should still be in KV (command should bypass it)
      expect(kvStore.has(pendingKey)).toBe(true);

      // Should NOT have created a comment
      expect(findFetchCalls("LINEAR_CREATE_LINEAR_COMMENT").length).toBe(0);
    });
  });

  // ----------------------------------------------------------
  // Linear webhook
  // ----------------------------------------------------------

  describe("Linear Webhook", () => {
    const issueId = "linear-wh-123";

    beforeEach(() => {
      kvStore.set(`issue:${issueId}`, {
        value: JSON.stringify({
          chatId: -5036236504,
          messageId: 100,
          reporterName: "Тестер",
          issueId: "VAL-7",
          issueUrl: "https://linear.app/test/VAL-7",
          title: "Bug test",
        } satisfies import("./types").IssueMapping),
      });
    });

    it("sends review buttons when issue moves to На проверке", async () => {
      const payload: LinearWebhookPayload = {
        action: "update",
        type: "Issue",
        data: {
          id: issueId,
          identifier: "VAL-7",
          title: "Bug test",
          state: { id: "3532014a-1092-408c-9aeb-94dc38871d7d", name: "На проверке", type: "started" },
        },
      };

      await worker.fetch(linearWebhookRequest(payload), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      const sendCalls = findFetchCalls("/sendMessage");
      expect(sendCalls.length).toBe(1);
      const body = parseFetchBody(sendCalls[0]);
      expect(body.text).toContain("на проверке");
      expect(body.reply_markup).toBeDefined();
      const keyboard = (body.reply_markup as { inline_keyboard: unknown[][] }).inline_keyboard;
      expect(keyboard[0].length).toBe(2); // Accept + Reject buttons
    });

    it("sends completion notification when issue is done", async () => {
      const payload: LinearWebhookPayload = {
        action: "update",
        type: "Issue",
        data: {
          id: issueId,
          identifier: "VAL-7",
          title: "Bug test",
          state: { id: "done-id", name: "Готово", type: "completed" },
        },
      };

      await worker.fetch(linearWebhookRequest(payload), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      const sendCalls = findFetchCalls("/sendMessage");
      expect(sendCalls.length).toBe(1);
      const body = parseFetchBody(sendCalls[0]);
      expect(body.text).toContain("выполнена");
    });

    it("sends cancellation notification when issue is canceled", async () => {
      const payload: LinearWebhookPayload = {
        action: "update",
        type: "Issue",
        data: {
          id: issueId,
          identifier: "VAL-7",
          title: "Bug test",
          state: { id: "cancel-id", name: "Отменено", type: "canceled" },
        },
      };

      await worker.fetch(linearWebhookRequest(payload), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      const sendCalls = findFetchCalls("/sendMessage");
      expect(sendCalls.length).toBe(1);
      const body = parseFetchBody(sendCalls[0]);
      expect(body.text).toContain("отменена");
    });

    it("ignores non-Issue events", async () => {
      const payload: LinearWebhookPayload = {
        action: "update",
        type: "Comment",
        data: { id: issueId, identifier: "VAL-7", title: "Bug test" },
      };

      await worker.fetch(linearWebhookRequest(payload), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      expect(findFetchCalls("/sendMessage").length).toBe(0);
    });

    it("ignores events for unknown issues", async () => {
      const payload: LinearWebhookPayload = {
        action: "update",
        type: "Issue",
        data: {
          id: "unknown-id",
          identifier: "VAL-999",
          title: "Unknown",
          state: { id: "done-id", name: "Готово", type: "completed" },
        },
      };

      await worker.fetch(linearWebhookRequest(payload), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      expect(findFetchCalls("/sendMessage").length).toBe(0);
    });
  });

  // ----------------------------------------------------------
  // SLA tracking (#9)
  // ----------------------------------------------------------

  describe("SLA Check (Cron)", () => {
    it("pings about issues in Новые >24h", async () => {
      const oldDate = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(); // 30h ago
      setupFetchMock({
        "LINEAR_LIST_ISSUES_BY_TEAM_ID": () => composioOKResponse({
          issues: [
            { identifier: "VAL-1", title: "Stale bug", state: { name: "Новые" }, priority: 2, createdAt: oldDate },
            { identifier: "VAL-2", title: "Fresh bug", state: { name: "Новые" }, priority: 3, createdAt: new Date().toISOString() },
            { identifier: "VAL-3", title: "In progress", state: { name: "В работе" }, priority: 2, createdAt: oldDate },
          ],
        }),
      });

      const controller = { scheduledTime: Date.now(), cron: "0 * * * *" } as ScheduledController;
      await worker.scheduled(controller, env, ctx);
      await Promise.all((ctx.waitUntil as Mock).mock.calls.map((c: unknown[]) => c[0]));

      const sendCalls = findFetchCalls("/sendMessage");
      expect(sendCalls.length).toBeGreaterThanOrEqual(1);
      const body = parseFetchBody(sendCalls[0]);
      expect(body.text).toContain("SLA");
      expect(body.text).toContain("VAL-1");
      expect(body.text).not.toContain("VAL-2"); // Fresh — skip
      expect(body.text).not.toContain("VAL-3"); // In progress — skip
    });

    it("does not send message when no stale issues", async () => {
      setupFetchMock({
        "LINEAR_LIST_ISSUES_BY_TEAM_ID": () => composioOKResponse({ issues: [] }),
      });

      const controller = { scheduledTime: Date.now(), cron: "0 * * * *" } as ScheduledController;
      await worker.scheduled(controller, env, ctx);
      await Promise.all((ctx.waitUntil as Mock).mock.calls.map((c: unknown[]) => c[0]));

      expect(findFetchCalls("/sendMessage").length).toBe(0);
    });

    it("sends to all allowed chats", async () => {
      const oldDate = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
      setupFetchMock({
        "LINEAR_LIST_ISSUES_BY_TEAM_ID": () => composioOKResponse({
          issues: [
            { identifier: "VAL-1", title: "Stale", state: { name: "Новые" }, priority: 2, createdAt: oldDate },
          ],
        }),
      });

      const controller = { scheduledTime: Date.now(), cron: "0 * * * *" } as ScheduledController;
      await worker.scheduled(controller, env, ctx);
      await Promise.all((ctx.waitUntil as Mock).mock.calls.map((c: unknown[]) => c[0]));

      const sendCalls = findFetchCalls("/sendMessage");
      const chatIds = sendCalls.map((c) => parseFetchBody(c).chat_id);
      expect(chatIds).toContain(-5036236504);
      expect(chatIds).toContain(7908321073);
    });
  });

  // ----------------------------------------------------------
  // Weekly digest (#8)
  // ----------------------------------------------------------

  describe("Weekly Digest (Cron)", () => {
    it("sends digest on Monday 9am UTC", async () => {
      // Monday 9am UTC
      const monday9am = new Date("2026-03-09T09:00:00Z").getTime();
      setupFetchMock({
        "LINEAR_LIST_ISSUES_BY_TEAM_ID": () => composioOKResponse({
          issues: [
            { identifier: "VAL-1", title: "Bug 1", state: { name: "Готово" }, priority: 2, createdAt: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString() },
            { identifier: "VAL-2", title: "Bug 2", state: { name: "В работе" }, priority: 3, createdAt: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString() },
            { identifier: "VAL-3", title: "Bug 3", state: { name: "Новые" }, priority: 1, createdAt: new Date(Date.now() - 1 * 24 * 3600 * 1000).toISOString() },
          ],
        }),
      });

      const controller = { scheduledTime: monday9am, cron: "0 9 * * 1" } as ScheduledController;
      await worker.scheduled(controller, env, ctx);
      await Promise.all((ctx.waitUntil as Mock).mock.calls.map((c: unknown[]) => c[0]));

      const sendCalls = findFetchCalls("/sendMessage");
      // Should send digest + SLA check (both fire)
      const digestCalls = sendCalls.filter((c) => {
        const body = parseFetchBody(c);
        return typeof body.text === "string" && body.text.includes("сводка");
      });
      expect(digestCalls.length).toBeGreaterThanOrEqual(1);

      const body = parseFetchBody(digestCalls[0]);
      expect(body.text).toContain("Еженедельная сводка");
      expect(body.text).toContain("Открытых");
      expect(body.text).toContain("Выполнено");
    });

    it("does not send digest on non-Monday", async () => {
      // Tuesday 9am UTC
      const tuesday9am = new Date("2026-03-10T09:00:00Z").getTime();
      setupFetchMock({
        "LINEAR_LIST_ISSUES_BY_TEAM_ID": () => composioOKResponse({ issues: [] }),
      });

      const controller = { scheduledTime: tuesday9am, cron: "0 * * * *" } as ScheduledController;
      await worker.scheduled(controller, env, ctx);
      await Promise.all((ctx.waitUntil as Mock).mock.calls.map((c: unknown[]) => c[0]));

      const digestCalls = findFetchCalls("/sendMessage").filter((c) => {
        const body = parseFetchBody(c);
        return typeof body.text === "string" && body.text.includes("сводка");
      });
      expect(digestCalls.length).toBe(0);
    });
  });

  // ----------------------------------------------------------
  // Edge cases
  // ----------------------------------------------------------

  describe("Edge Cases", () => {
    it("ignores empty updates", async () => {
      const update: TelegramUpdate = { update_id: 999 };
      await worker.fetch(webhookRequest(update), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];
      expect(findFetchCalls("/sendMessage").length).toBe(0);
    });

    it("ignores messages without content", async () => {
      const update: TelegramUpdate = {
        update_id: 999,
        message: {
          message_id: 999,
          from: baseUser,
          chat: { id: -5036236504, type: "group" },
          date: Math.floor(Date.now() / 1000),
        },
      };
      await worker.fetch(webhookRequest(update), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];
      expect(findFetchCalls("openai.com").length).toBe(0);
    });

    it("handles document image as photo", async () => {
      const update: TelegramUpdate = {
        update_id: 4,
        message: {
          message_id: 103,
          from: baseUser,
          chat: { id: -5036236504, type: "group" },
          date: Math.floor(Date.now() / 1000),
          caption: "/report Скриншот как файл",
          document: {
            file_id: "doc-img-1",
            file_unique_id: "doc-img-u1",
            file_name: "screenshot.png",
            mime_type: "image/png",
            file_size: 500_000,
          },
        },
      };

      await worker.fetch(webhookRequest(update), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      // Should send image to OpenAI
      const aiCall = findFetchCalls("openai.com")[0];
      const body = parseFetchBody(aiCall);
      const messages = body.messages as { role: string; content: unknown }[];
      const userContent = messages[1].content as { type: string }[];
      const imageParts = userContent.filter((c) => c.type === "image_url");
      expect(imageParts.length).toBe(1);

      // Should upload to R2
      const photoKeys = [...r2Store.keys()].filter((k) => k.startsWith("photo/"));
      expect(photoKeys.length).toBe(1);
    });

    it("handles document video with thumbnail", async () => {
      const update: TelegramUpdate = {
        update_id: 5,
        message: {
          message_id: 104,
          from: baseUser,
          chat: { id: -5036236504, type: "group" },
          date: Math.floor(Date.now() / 1000),
          caption: "/report Видео как файл",
          document: {
            file_id: "doc-vid-1",
            file_unique_id: "doc-vid-u1",
            file_name: "recording.mp4",
            mime_type: "video/mp4",
            file_size: 10 * 1024 * 1024,
            thumbnail: { file_id: "doc-thumb-1", file_unique_id: "doc-thumb-u1", width: 320, height: 180 },
          },
        },
      };

      await worker.fetch(webhookRequest(update), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      // Video sent to Gemini for analysis
      const geminiCall = findFetchCalls("generativelanguage.googleapis.com")[0];
      expect(geminiCall).toBeDefined();

      // Video uploaded to R2
      const videoKeys = [...r2Store.keys()].filter((k) => k.startsWith("video/"));
      expect(videoKeys.length).toBe(1);
    });

    it("skips oversized video upload (>20MB)", async () => {
      const update: TelegramUpdate = {
        update_id: 6,
        message: {
          message_id: 105,
          from: baseUser,
          chat: { id: -5036236504, type: "group" },
          date: Math.floor(Date.now() / 1000),
          caption: "/report Огромное видео",
          video: {
            file_id: "big-vid",
            file_unique_id: "bv1",
            width: 1920,
            height: 1080,
            duration: 120,
            file_size: 50 * 1024 * 1024, // 50MB
          },
        },
      };

      await worker.fetch(webhookRequest(update), env, ctx);
      await (ctx.waitUntil as Mock).mock.calls[0][0];

      // No getFile for the video itself
      const getFileCalls = findFetchCalls("/getFile");
      const fileIds = getFileCalls.map((c) => parseFetchBody(c).file_id);
      expect(fileIds).not.toContain("big-vid");

      // No video in R2
      const videoKeys = [...r2Store.keys()].filter((k) => k.startsWith("video/"));
      expect(videoKeys.length).toBe(0);
    });
  });
});
