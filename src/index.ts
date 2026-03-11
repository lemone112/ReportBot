import type {
  Env, TelegramUpdate, TelegramMessage,
  PendingReject, PendingTeamName, PendingReport,
  PendingChatBind, PendingPmAdd,
  LinearWebhookPayload, IssueMapping, ProjectConfig,
} from "./types";
import {
  sendMessage, sendMessageWithButtons, editMessageText,
  editMessageWithButtons, downloadFile, arrayBufferToBase64,
} from "./telegram";
import { getLinearIssue, listLinearIssuesByTeam, deleteIssueVector } from "./composio";
import { updateBotAvatar } from "./avatar";
import { sendWeeklyDigest } from "./digest";
import {
  CE, esc, isChatAllowed, isAdmin, userName, priorityLabel,
  resolveProjectForChat, getProjectConfig, getProjectList, isAnyProjectManager,
} from "./utils";
import { buildMainPanel } from "./panels";
import {
  handleCallbackQuery, handleTeamNameInput,
  handleRejectionComment, handleChatBindInput, handlePmAddInput,
} from "./callbacks";
import {
  createReportFlow, createReportFlowSilent,
  handleMediaGroup, processSingleReport,
} from "./reports";
import { migrateToMultiProject } from "./migrate";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" && request.method === "GET") {
      return new Response("Bug Reporter Bot is running");
    }

    if (url.pathname.startsWith("/media/") && request.method === "GET") {
      return handleMediaRequest(url.pathname, env);
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      // Run migration on first request if needed
      ctx.waitUntil(migrateToMultiProject(env).catch((e) => console.error("Migration error:", e)));

      if (env.WEBHOOK_SECRET) {
        const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
        if (secretHeader !== env.WEBHOOK_SECRET) return new Response("Unauthorized", { status: 401 });
      }

      let update: TelegramUpdate;
      try {
        update = (await request.json()) as TelegramUpdate;
      } catch {
        return new Response("Bad request", { status: 400 });
      }

      ctx.waitUntil(
        handleTelegramUpdate(update, env, url.origin).catch((err) => {
          console.error("FATAL in handleTelegramUpdate:", err);
          const chatId = update?.message?.chat?.id || update?.callback_query?.message?.chat?.id;
          const msgId = update?.message?.message_id;
          if (chatId) {
            return sendMessage(env, chatId, `${CE.ERROR} Что-то пошло не так. Попробуйте ещё раз через минуту.`, msgId).catch(() => {});
          }
        }),
      );
      return new Response("OK", { status: 200 });
    }

    if (url.pathname === "/linear-webhook" && request.method === "POST") {
      let payload: LinearWebhookPayload;

      if (env.LINEAR_WEBHOOK_SECRET) {
        const rawBody = await request.text();
        const signature = request.headers.get("Linear-Signature");
        if (!signature) return new Response("Unauthorized", { status: 401 });
        try {
          const encoder = new TextEncoder();
          const key = await crypto.subtle.importKey(
            "raw",
            encoder.encode(env.LINEAR_WEBHOOK_SECRET),
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"],
          );
          const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
          const computed = Array.from(new Uint8Array(sig))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
          if (computed !== signature) return new Response("Unauthorized", { status: 401 });
        } catch (hmacErr) {
          console.error("HMAC verification failed:", hmacErr);
          return new Response("Unauthorized", { status: 401 });
        }
        payload = JSON.parse(rawBody) as LinearWebhookPayload;
      } else {
        try {
          payload = (await request.json()) as LinearWebhookPayload;
        } catch {
          return new Response("Bad request", { status: 400 });
        }
      }

      ctx.waitUntil(
        handleLinearWebhook(payload, env).catch((err) => {
          console.error("FATAL in handleLinearWebhook:", err);
        }),
      );
      return new Response("OK", { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(updateBotAvatar(env));

    const schedDate = new Date(controller.scheduledTime);

    // Weekly digest: Friday 15:00 UTC (18:00 MSK) — per-project
    if (schedDate.getUTCDay() === 5 && schedDate.getUTCHours() === 15 && schedDate.getUTCMinutes() === 0) {
      ctx.waitUntil((async () => {
        const slugs = await getProjectList(env);
        for (const slug of slugs) {
          const enabled = await env.BUG_REPORTS.get(`settings:digest:${slug}`);
          if (enabled === "false") continue;
          try {
            await sendWeeklyDigest(env, slug);
          } catch (e) {
            console.error(`Digest failed for ${slug}:`, e);
          }
        }
      })());
    }
  },
} satisfies ExportedHandler<Env>;

// ============================================================
// Media serving
// ============================================================

async function handleMediaRequest(pathname: string, env: Env): Promise<Response> {
  const key = pathname.replace("/media/", "");
  if (!key || key.includes("..") || key.startsWith("/") || key.includes("\\") || !/^(photo|video)\/[\w.-]+$/.test(key)) {
    return new Response("Bad request", { status: 400 });
  }
  const object = await env.MEDIA_BUCKET.get(key);
  if (!object) return new Response("Not found", { status: 404 });
  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType || "application/octet-stream",
      "Cache-Control": "public, max-age=31536000",
    },
  });
}

// ============================================================
// Telegram update routing
// ============================================================

async function handleTelegramUpdate(update: TelegramUpdate, env: Env, origin: string): Promise<void> {
  if (!update || typeof update !== "object") return;
  if (!update.message && !update.callback_query && !update.edited_message && !update.my_chat_member) return;

  // Deduplication
  if (update.update_id) {
    const idKey = "upd:" + update.update_id;
    const seen = await env.BUG_REPORTS.get(idKey);
    if (seen) return;
    await env.BUG_REPORTS.put(idKey, "1", { expirationTtl: 300 });
  }

  // Bot added to chat
  if (update.my_chat_member) {
    const mcm = update.my_chat_member;
    const newStatus = mcm.new_chat_member?.status;
    const chatId = mcm.chat?.id;
    if (chatId && (newStatus === "member" || newStatus === "administrator")) {
      await sendMessage(
        env,
        chatId,
        `${CE.SUCCESS} <b>Привет!</b>\n\nЯ помогаю отслеживать задачи и баги.\n\n<b>Как создать задачу:</b>\n\u2022 <code>/report описание</code> — текстом\n\u2022 Фото/видео с подписью <code>/report</code>\n\n<i>Все задачи автоматически попадают в трекер и распределяются по команде.</i>`,
      );
    }
    return;
  }

  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query, env);
    return;
  }

  const message = update.message;
  if (!message) return;

  const isPrivate = message.chat.type === "private";
  const userId = message.from?.id;

  // Private chat: admin/PM panel + pending inputs
  if (isPrivate && userId && (isAdmin(userId, env) || await isAnyProjectManager(userId, env))) {
    if (message.text && !message.text.startsWith("/")) {
      // 1. Pending report
      const reportKey = `pending_report:${message.chat.id}:${userId}`;
      const reportPendingJson = await env.BUG_REPORTS.get(reportKey);
      if (reportPendingJson) {
        await env.BUG_REPORTS.delete(reportKey);
        const rp = JSON.parse(reportPendingJson) as PendingReport;
        await editMessageWithButtons(env, rp.panelChatId, rp.panelMessageId, `${CE.LOADING} <b>Репорт принят!</b> Обрабатываю...`, []);
        const project = rp.projectSlug ? await getProjectConfig(env, rp.projectSlug) : null;
        try {
          await createReportFlowSilent(
            message.chat.id, message.message_id, userName(message.from),
            message.text, [], [], [], env, rp.panelChatId, rp.panelMessageId, project,
          );
        } catch (e) {
          await editMessageWithButtons(env, rp.panelChatId, rp.panelMessageId,
            `\u274C Ошибка: ${esc(e instanceof Error ? e.message : "unknown")}`,
            [[{ text: "\u2B05\uFE0F Назад", callback_data: "mn:home" }]]);
        }
        return;
      }

      // 2. Pending team name
      const teamNameKey = `pending_team_name:${message.chat.id}:${userId}`;
      const teamNameJson = await env.BUG_REPORTS.get(teamNameKey);
      if (teamNameJson) {
        await handleTeamNameInput(message, JSON.parse(teamNameJson) as PendingTeamName, teamNameKey, env);
        return;
      }

      // 3. Pending chat bind
      const chatBindKey = `pending_chat_bind:${message.chat.id}:${userId}`;
      const chatBindJson = await env.BUG_REPORTS.get(chatBindKey);
      if (chatBindJson) {
        await handleChatBindInput(message, JSON.parse(chatBindJson) as PendingChatBind, chatBindKey, env);
        return;
      }

      // 4. Pending PM add
      const pmAddKey = `pending_pm_add:${message.chat.id}:${userId}`;
      const pmAddJson = await env.BUG_REPORTS.get(pmAddKey);
      if (pmAddJson) {
        await handlePmAddInput(message, JSON.parse(pmAddJson) as PendingPmAdd, pmAddKey, env);
        return;
      }
    }
  }

  // Check if chat is allowed (either via binding or ALLOWED_CHATS)
  const chatAllowed = isChatAllowed(message.chat.id, env) || await resolveProjectForChat(env, message.chat.id) !== null;
  if (!isPrivate && !chatAllowed) return;

  // Pending rejection comment
  if (message.text && !message.text.startsWith("/")) {
    const rejectKey = `pending_reject:${message.chat.id}:${message.from?.id}`;
    const pendingJson = await env.BUG_REPORTS.get(rejectKey);
    if (pendingJson) {
      await handleRejectionComment(message, JSON.parse(pendingJson) as PendingReject, rejectKey, env);
      return;
    }
    if (!isPrivate) return; // Ignore non-command messages in group chats
  }

  // Commands
  if (message.text?.startsWith("/")) {
    await handleCommand(message, env, origin);
    return;
  }

  // Reply to a message with /report
  if (message.reply_to_message && message.text?.startsWith("/report")) {
    const project = await resolveProjectForChat(env, message.chat.id);
    const replyText = message.text.replace(/^\/report(@\S+)?/i, "").trim();
    const origText = message.reply_to_message.text || message.reply_to_message.caption || "";
    const fullReplyText = (replyText || "") + (origText ? "\n\n[Контекст]: " + origText : "");
    const rImages: { data: string; mediaType: string }[] = [];
    const rMediaUrls: string[] = [];

    if (message.reply_to_message.photo && message.reply_to_message.photo.length > 0) {
      const rLargest = message.reply_to_message.photo[message.reply_to_message.photo.length - 1];
      const rFile = await downloadFile(env, rLargest.file_id);
      if (rFile) {
        rImages.push({ data: arrayBufferToBase64(rFile.buffer), mediaType: rFile.mediaType });
        const rKey = `photo/${Date.now()}-${rLargest.file_unique_id}.jpg`;
        await env.MEDIA_BUCKET.put(rKey, rFile.buffer, { httpMetadata: { contentType: rFile.mediaType } });
        rMediaUrls.push(`${origin}/media/${rKey}`);
      }
    }

    if (!fullReplyText.trim() && rImages.length === 0) {
      await sendMessage(env, message.chat.id, `${CE.ERROR} Не удалось прочитать сообщение`, message.message_id);
      return;
    }
    await createReportFlow(message.chat.id, message.message_id, userName(message.from), fullReplyText, rImages, [], rMediaUrls, env, project);
    return;
  }

  // /report as caption on media
  if (message.caption?.startsWith("/report")) {
    const rlKeyM = `ratelimit:report:${message.chat.id}`;
    const rlDataM = await env.BUG_REPORTS.get(rlKeyM);
    const rlCountM = rlDataM ? parseInt(rlDataM, 10) : 0;
    if (rlCountM >= 5) {
      await sendMessage(env, message.chat.id, "\u23F3 Слишком много репортов. Подождите 5 минут.", message.message_id);
      return;
    }
    await env.BUG_REPORTS.put(rlKeyM, String(rlCountM + 1), { expirationTtl: 300 });

    if (message.media_group_id) {
      await handleMediaGroup(message, env, origin);
    } else {
      await processSingleReport(message, env, origin);
    }
    return;
  }

  // Subsequent messages in an active media group
  if (message.media_group_id) {
    const bufferKey = `mediagroup:${message.media_group_id}`;
    const existing = await env.BUG_REPORTS.get(bufferKey);
    if (existing) {
      await handleMediaGroup(message, env, origin);
    }
    return;
  }
}

// ============================================================
// Commands
// ============================================================

async function handleCommand(message: TelegramMessage, env: Env, origin: string): Promise<void> {
  const text = message.text || "";
  const chatId = message.chat.id;
  const isPrivate = message.chat.type === "private";

  if (text.startsWith("/start") || text.startsWith("/help")) {
    if (isPrivate) {
      if (isAdmin(message.from?.id, env) || await isAnyProjectManager(message.from?.id || 0, env)) {
        const mainPanel = buildMainPanel(isAdmin(message.from?.id, env));
        await sendMessageWithButtons(env, chatId, mainPanel.text, mainPanel.buttons);
      } else {
        await sendMessage(env, chatId, "\uD83E\uDD16 Этот бот работает в рабочем чате проекта.\n\nИспользуйте <code>/report</code> в группе для создания задач.");
      }
    } else {
      await sendMessage(env, chatId, "\uD83E\uDD16 <b>Команды:</b>\n\n<code>/report описание</code> — текстовый репорт\nФото/видео + подпись <code>/report</code> — скриншот\nРеплай на сообщение + <code>/report</code>");
    }
    return;
  }

  if (text.startsWith("/admin") || text.startsWith("/team") || text.startsWith("/settings") || text.startsWith("/digest")) {
    if (message.chat.type !== "private") {
      await sendMessage(env, chatId, "Используйте эту команду в личных сообщениях с ботом");
      return;
    }
    if (!isAdmin(message.from?.id, env) && !await isAnyProjectManager(message.from?.id || 0, env)) {
      await sendMessage(env, chatId, "Нет доступа");
      return;
    }
    const mp = buildMainPanel(isAdmin(message.from?.id, env));
    await sendMessageWithButtons(env, chatId, mp.text, mp.buttons);
    return;
  }

  if (text.startsWith("/chatid")) {
    await sendMessage(env, chatId, `Chat ID: <code>${chatId}</code>`);
    return;
  }

  if (text.startsWith("/status")) {
    const issueKey = text.replace("/status", "").trim();
    if (!issueKey) {
      await sendMessage(env, chatId, "Использование: /status VAL-5");
      return;
    }
    try {
      const data = await getLinearIssue(env, issueKey);
      const title = (data.title || "") as string;
      const state = ((data.state as Record<string, string>)?.name || "") as string;
      const priority = (data.priority || 0) as number;
      const url = (data.url || "") as string;
      await sendMessage(env, chatId,
        `<b>${esc(issueKey)}</b>: ${esc(title)}\nСтатус: ${esc(state)}\nПриоритет: ${priorityLabel(priority)}` +
        (url ? `\n<a href="${url}">Открыть в Linear</a>` : ""));
    } catch {
      await sendMessage(env, chatId, `Задача ${esc(issueKey)} не найдена`);
    }
    return;
  }

  if (text.startsWith("/list")) {
    const project = await resolveProjectForChat(env, chatId);
    const teamId = project?.teamId;
    try {
      const issues = await listLinearIssuesByTeam(env, teamId);
      const active = issues.filter((i) => !["completed", "canceled"].includes(i.stateType));
      if (active.length === 0) {
        await sendMessage(env, chatId, "Нет открытых задач");
        return;
      }
      const header = project ? `<b>${esc(project.projectName)} — Открытые (${active.length}):</b>` : `<b>Открытые задачи (${active.length}):</b>`;
      const lines = active.slice(0, 20).map((i) =>
        `\u2022 <b>${esc(i.identifier)}</b> ${esc(i.title)} — <i>${esc(i.stateName)}</i>`);
      await sendMessage(env, chatId, `${header}\n\n${lines.join("\n")}`);
    } catch (e) {
      await sendMessage(env, chatId, `Ошибка: ${e instanceof Error ? e.message : "неизвестная"}`);
    }
    return;
  }

  if (text.startsWith("/report")) {
    const rlKey = `ratelimit:report:${chatId}`;
    const rlData = await env.BUG_REPORTS.get(rlKey);
    const rlCount = rlData ? parseInt(rlData, 10) : 0;
    if (rlCount >= 5) {
      await sendMessage(env, chatId, "\u23F3 Слишком много репортов. Подождите 5 минут.", message.message_id);
      return;
    }
    await env.BUG_REPORTS.put(rlKey, String(rlCount + 1), { expirationTtl: 300 });

    const reportText = text.replace(/^\/report(@\S+)?/, "").trim();
    if (!reportText) {
      await sendMessage(env, chatId, "Использование: /report описание бага\n\nИли отправьте фото/видео с подписью /report");
      return;
    }
    const project = await resolveProjectForChat(env, chatId);
    await createReportFlow(chatId, message.message_id, userName(message.from), reportText, [], [], [], env, project);
    return;
  }
}

// ============================================================
// Linear webhook handling (dynamic states)
// ============================================================

async function handleLinearWebhook(payload: LinearWebhookPayload, env: Env): Promise<void> {
  if (!payload || typeof payload !== "object") return;
  if (!payload.type || !payload.action || !payload.data) return;
  if (typeof payload.data.id !== "string") return;
  if (payload.type !== "Issue" || payload.action !== "update") return;

  const stateId = payload.data.state?.id;
  const stateType = payload.data.state?.type;

  const mappingJson = await env.BUG_REPORTS.get(`issue:${payload.data.id}`);
  if (!mappingJson) return;
  const mapping = JSON.parse(mappingJson) as IssueMapping;

  // Load project config for dynamic state comparison
  const pSlug = mapping.projectSlug || "valwin";
  const project = await getProjectConfig(env, pSlug);

  // "Review" state -> review buttons
  if (project?.states.review && stateId === project.states.review) {
    await sendMessageWithButtons(env, mapping.chatId,
      [
        `\uD83D\uDD0D <b>Задача на проверке</b>`,
        ``,
        `<b>${esc(payload.data.identifier)}: ${esc(payload.data.title)}</b>`,
        `Репортер: ${esc(mapping.reporterName)}`,
        ``,
        `Проверьте и подтвердите результат:`,
      ].join("\n"),
      [[
        { text: "\u2705 Принять", callback_data: `accept:${payload.data.id}` },
        { text: "\u274C Отклонить", callback_data: `reject:${payload.data.id}` },
      ]]);
    return;
  }

  // Completed/canceled
  if (stateType === "completed" || stateType === "canceled") {
    if (env.VECTORIZE) {
      await deleteIssueVector(env, payload.data.id);
    }
    if (stateType === "completed") {
      await sendMessage(env, mapping.chatId,
        `${CE.DONE} <b>Задача выполнена!</b>\n\n${esc(payload.data.title)}\n\n<i>Готово к проверке.</i>`);
    }
  }

  // Started (in progress) — but not the review state
  if (stateType === "started" && stateId !== project?.states.review) {
    await sendMessage(env, mapping.chatId,
      `${CE.PROGRESS} <b>Взяли в работу</b>\n\n${esc(payload.data.title)}`);
  }
}
