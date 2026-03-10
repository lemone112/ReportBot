import type {
  Env, TelegramUpdate, TelegramMessage, TelegramUser,
  IssueMapping, MediaGroupBuffer, PendingReject, PendingTeamSet,
  PendingTeamName, PendingReport, LinearWebhookPayload, TeamConfig,
  LinearWorkspaceUser,
} from "./types";
import {
  sendMessage, sendMessageWithButtons, editMessageText,
  editMessageWithButtons, answerCallbackQuery, downloadFile,
  arrayBufferToBase64, getBotUsername, updateBotAvatar,
} from "./telegram";
import { analyzeBugReport, analyzeVideoReport } from "./claude";
import {
  createLinearIssue, updateLinearIssueState, addLinearComment,
  searchLinearIssues, getLinearIssue, listLinearIssuesByTeam,
  findLinearUserByEmail, listLinearWorkspaceUsers, linearGQL,
  storeIssueVector, findSimilarIssues, deleteIssueVector,
} from "./composio";

// Linear state IDs
const STATE_DONE = "a36c8892-9daa-4127-8e36-7553e2afff8a";
const STATE_IN_PROGRESS = "5c2e2165-d492-4963-b3f2-1eda3a2e7135";
const STATE_REVIEW = "3532014a-1092-408c-9aeb-94dc38871d7d";

const MEDIA_GROUP_DELAY_MS = 3500;

// Custom emoji constants for Telegram
const CE = {
  LOADING: '<tg-emoji emoji-id="5350438526691326210">\u23F3</tg-emoji>',
  SUCCESS: '<tg-emoji emoji-id="5348079125061975628">\u2705</tg-emoji>',
  INBOX: '<tg-emoji emoji-id="5348235470461483629">\uD83D\uDCCB</tg-emoji>',
  PROGRESS: '<tg-emoji emoji-id="5361734213370396027">\uD83D\uDD27</tg-emoji>',
  DONE: '<tg-emoji emoji-id="5348445120700102867">\u2705</tg-emoji>',
  ERROR: '<tg-emoji emoji-id="5361800897032634764">\u274C</tg-emoji>',
  REPORT: '<tg-emoji emoji-id="5361740436778009413">\uD83D\uDCCB</tg-emoji>',
  SIMILAR: '<tg-emoji emoji-id="5350654889963828012">\u26A0\uFE0F</tg-emoji>',
};

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
      // Verify webhook secret if configured
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

  // Cron triggers
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(updateBotAvatar(env));

    const schedDate = new Date(controller.scheduledTime);

    // Weekly digest: Friday 15:00 UTC (18:00 MSK)
    if (schedDate.getUTCDay() === 5 && schedDate.getUTCHours() === 15 && schedDate.getUTCMinutes() === 0) {
      ctx.waitUntil((async () => {
        const enabled = await env.BUG_REPORTS.get("settings:digest_enabled");
        if (enabled === "false") return;
        await sendWeeklyDigest(env);
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

function isChatAllowed(chatId: number, env: Env): boolean {
  return env.ALLOWED_CHATS.split(",").map((id) => id.trim()).includes(String(chatId));
}

function isAdmin(userId: number | undefined, env: Env): boolean {
  if (!userId) return false;
  return env.ADMIN_USERS.split(",").map((id) => id.trim()).includes(String(userId));
}

function userName(user?: TelegramUser): string {
  if (!user) return "Неизвестный";
  return [user.first_name, user.last_name].filter(Boolean).join(" ");
}

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

  // Private chat: admin panel + pending inputs
  if (isPrivate && isAdmin(message.from?.id, env)) {
    if (message.text && !message.text.startsWith("/")) {
      // Pending report from admin panel
      const reportKey = `pending_report:${message.chat.id}:${message.from?.id}`;
      const reportPendingJson = await env.BUG_REPORTS.get(reportKey);
      if (reportPendingJson) {
        await env.BUG_REPORTS.delete(reportKey);
        const rp = JSON.parse(reportPendingJson) as PendingReport;
        await editMessageWithButtons(env, rp.panelChatId, rp.panelMessageId, `${CE.LOADING} <b>Репорт принят!</b> Обрабатываю...`, []);
        try {
          await createReportFlowSilent(
            message.chat.id, message.message_id, userName(message.from),
            message.text, [], [], [], env, rp.panelChatId, rp.panelMessageId,
          );
        } catch (e) {
          await editMessageWithButtons(env, rp.panelChatId, rp.panelMessageId,
            `\u274C Ошибка: ${esc(e instanceof Error ? e.message : "unknown")}`,
            [[{ text: "\u2B05\uFE0F Назад", callback_data: "mn:home" }]]);
        }
        return;
      }

      // Pending team email input
      const teamSetKey = `pending_team_set:${message.chat.id}:${message.from?.id}`;
      const teamPendingJson = await env.BUG_REPORTS.get(teamSetKey);
      if (teamPendingJson) {
        await handleTeamSetEmail(message, JSON.parse(teamPendingJson) as PendingTeamSet, teamSetKey, env);
        return;
      }

      // Pending team role name input
      const teamNameKey = `pending_team_name:${message.chat.id}:${message.from?.id}`;
      const teamNameJson = await env.BUG_REPORTS.get(teamNameKey);
      if (teamNameJson) {
        await handleTeamNameInput(message, JSON.parse(teamNameJson) as PendingTeamName, teamNameKey, env);
        return;
      }
    }
  }

  // Group chat: only react in allowed chats
  if (!isChatAllowed(message.chat.id, env)) return;

  // Pending rejection comment
  if (message.text && !message.text.startsWith("/")) {
    const rejectKey = `pending_reject:${message.chat.id}:${message.from?.id}`;
    const pendingJson = await env.BUG_REPORTS.get(rejectKey);
    if (pendingJson) {
      await handleRejectionComment(message, JSON.parse(pendingJson) as PendingReject, rejectKey, env);
      return;
    }
    return; // Ignore non-command messages in group chats
  }

  // Commands
  if (message.text?.startsWith("/")) {
    await handleCommand(message, env, origin);
    return;
  }

  // Reply to a message with /report
  if (message.reply_to_message && message.text?.startsWith("/report") && isChatAllowed(message.chat.id, env)) {
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
    await createReportFlow(message.chat.id, message.message_id, userName(message.from), fullReplyText, rImages, [], rMediaUrls, env);
    return;
  }

  // /report as caption on media (single photo/video or first in media group)
  if (message.caption?.startsWith("/report")) {
    // Rate limit check
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

  // Subsequent messages in an active media group (no caption, but buffer exists)
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
// Commands: /start, /status, /list, /report
// ============================================================

async function handleCommand(message: TelegramMessage, env: Env, origin: string): Promise<void> {
  const text = message.text || "";
  const chatId = message.chat.id;
  const isPrivate = message.chat.type === "private";

  if (text.startsWith("/start") || text.startsWith("/help")) {
    if (isPrivate) {
      if (isAdmin(message.from?.id, env)) {
        const mainPanel = await buildMainPanel(env, true);
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
    if (message.chat.type !== "private" || !isAdmin(message.from?.id, env)) {
      await sendMessage(env, chatId, "Нет доступа");
      return;
    }
    const mp = await buildMainPanel(env, true);
    await sendMessageWithButtons(env, chatId, mp.text, mp.buttons);
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
    try {
      const issues = await listLinearIssuesByTeam(env);
      const active = issues.filter((i) => !["completed", "canceled"].includes(i.stateType));
      if (active.length === 0) {
        await sendMessage(env, chatId, "Нет открытых задач");
        return;
      }
      const lines = active.slice(0, 20).map((i) =>
        `\u2022 <b>${esc(i.identifier)}</b> ${esc(i.title)} — <i>${esc(i.stateName)}</i>`);
      await sendMessage(env, chatId, `<b>Открытые задачи (${active.length}):</b>\n\n${lines.join("\n")}`);
    } catch (e) {
      await sendMessage(env, chatId, `Ошибка: ${e instanceof Error ? e.message : "неизвестная"}`);
    }
    return;
  }

  if (text.startsWith("/report")) {
    // Rate limit: 5 reports per 5 minutes per chat
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
    await createReportFlow(chatId, message.message_id, userName(message.from), reportText, [], [], [], env);
    return;
  }
}

// ============================================================
// Admin main panel
// ============================================================

type Btn = { text: string; callback_data: string };
type Panel = { text: string; buttons: Btn[][] };

async function buildMainPanel(env: Env, showAdmin: boolean): Promise<Panel> {
  const lines = [
    "\uD83E\uDD16 <b>Valwin Reports</b>",
    "",
    "Управление ботом и командой",
  ];
  const buttons: Btn[][] = [
    [{ text: "\uD83D\uDCDD Создать репорт", callback_data: "mn:report" }],
    [{ text: "\uD83D\uDCCB Открытые задачи", callback_data: "mn:tasks" }],
  ];
  if (showAdmin) {
    buttons.push([
      { text: "\uD83D\uDC65 Команда", callback_data: "team:main" },
      { text: "\uD83D\uDCCA Отчёты", callback_data: "dg:panel" },
    ]);
    buttons.push([
      { text: "\uD83D\uDCC8 Статистика", callback_data: "mn:stats" },
    ]);
  }
  return { text: lines.join("\n"), buttons };
}

async function buildDigestPanel(env: Env): Promise<Panel> {
  const enabled = await env.BUG_REPORTS.get("settings:digest_enabled");
  const isOn = enabled !== "false";
  const statusEmoji = isOn ? "\u2705" : "\u23F8\uFE0F";
  const statusText = isOn ? "включён" : "приостановлен";
  const lines = [
    `${CE.REPORT} <b>Еженедельный отчёт</b>`,
    "",
    `${statusEmoji} Статус: <b>${statusText}</b>`,
    "\uD83D\uDCC5 Отправка: пятница, 18:00 МСК",
  ];
  const toggleBtn: Btn = isOn
    ? { text: "\u23F8\uFE0F Приостановить", callback_data: "dg:off" }
    : { text: "\u25B6\uFE0F Включить", callback_data: "dg:on" };
  const buttons: Btn[][] = [
    [toggleBtn],
    [{ text: "\uD83D\uDCE8 Отправить сейчас", callback_data: "dg:test" }],
    [{ text: "\u2B05\uFE0F Главная", callback_data: "mn:home" }],
  ];
  return { text: lines.join("\n"), buttons };
}

// ============================================================
// Team management — inline keyboard UI
// ============================================================

function roleSlug(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}

function buildTeamMainPanel(team: TeamConfig): Panel {
  const roles = Object.entries(team);
  const lines = ["\u2699\uFE0F <b>Управление командой</b>", ""];

  if (roles.length === 0) {
    lines.push("<i>Нет ролей. Добавьте первую!_");
  } else {
    for (const [, role] of roles) {
      lines.push(role.member
        ? `<b>${esc(role.name)}</b> — \u2705 ${esc(role.member.name)}`
        : `<b>${esc(role.name)}</b> — _не назначен_`);
    }
  }

  const buttons: Btn[][] = [];
  const roleBtns = roles.map(([id, role]) => ({
    text: role.member ? `\u2705 ${role.name}` : role.name,
    callback_data: `team:view:${id}`,
  }));
  for (let i = 0; i < roleBtns.length; i += 3) {
    buttons.push(roleBtns.slice(i, i + 3));
  }
  buttons.push([{ text: "\u2795 Добавить роль", callback_data: "team:add" }]);
  buttons.push([{ text: "\u2B05\uFE0F Главная", callback_data: "mn:home" }]);
  return { text: lines.join("\n"), buttons };
}

function buildTeamRolePanel(team: TeamConfig, roleId: string): Panel {
  const role = team[roleId];
  if (!role) return buildTeamMainPanel(team);

  const lines = [`<b>${esc(role.name)}</b>`, ""];
  if (role.member) {
    lines.push(`\u2705 ${esc(role.member.name)}`);
    lines.push(`\uD83D\uDCE7 ${esc(role.member.email)}`);
  } else {
    lines.push("<i>Участник не назначен</i>");
  }

  const actions: Btn[] = [
    { text: role.member ? "\u270F\uFE0F Сменить" : "\uD83D\uDC64 Назначить", callback_data: `team:setm:${roleId}` },
  ];
  if (role.member) {
    actions.push({ text: "\u274C Снять", callback_data: `tu:${roleId}` });
  }
  const row2: Btn[] = [
    { text: "\uD83D\uDDD1 Удалить роль", callback_data: `team:del:${roleId}` },
  ];
  return {
    text: lines.join("\n"),
    buttons: [actions, row2, [{ text: "\u2B05\uFE0F Назад", callback_data: "team:main" }]],
  };
}

function buildTeamSetPanel(roleId: string, roleName: string): Panel {
  return {
    text: `<b>${esc(roleName)}</b>\n\nОтправьте email участника Linear:`,
    buttons: [[{ text: "\u2B05\uFE0F Отмена", callback_data: `team:view:${roleId}` }]],
  };
}

function buildUserPickPanel(roleId: string, roleName: string, users: LinearWorkspaceUser[], page: number): Panel {
  const PAGE_SIZE = 6;
  const start = page * PAGE_SIZE;
  const pageUsers = users.slice(start, start + PAGE_SIZE);
  const totalPages = Math.ceil(users.length / PAGE_SIZE);

  const lines = [`<b>${esc(roleName)}</b>`, "", "Выберите участника:"];
  const buttons: Btn[][] = [];

  for (const u of pageUsers) {
    buttons.push([{ text: u.name + (u.email ? ` (${u.email.split("@")[0]})` : ""), callback_data: `tp:${roleId}:${u.id}` }]);
  }

  if (totalPages > 1) {
    const navRow: Btn[] = [];
    if (page > 0) navRow.push({ text: "\u25C0\uFE0F", callback_data: `tpg:${roleId}:${page - 1}` });
    navRow.push({ text: `${page + 1}/${totalPages}`, callback_data: "noop" });
    if (page < totalPages - 1) navRow.push({ text: "\u25B6\uFE0F", callback_data: `tpg:${roleId}:${page + 1}` });
    buttons.push(navRow);
  }
  buttons.push([{ text: "\u2B05\uFE0F Назад", callback_data: `team:view:${roleId}` }]);
  return { text: lines.join("\n"), buttons };
}

function buildAddRolePanel(): Panel {
  return {
    text: "\u2795 <b>Новая роль</b>\n\nОтправьте название роли:",
    buttons: [[{ text: "\u2B05\uFE0F Отмена", callback_data: "team:main" }]],
  };
}

// --- /team command entry point ---

async function handleTeamCommand(message: TelegramMessage, env: Env): Promise<void> {
  const chatId = message.chat.id;

  if (message.chat.type !== "private") {
    await sendMessage(env, chatId, "Управление командой доступно только в личном чате с ботом");
    return;
  }

  if (!isAdmin(message.from?.id, env)) {
    await sendMessage(env, chatId, "У вас нет доступа к управлению командой");
    return;
  }

  const text = (message.text || "").replace("/team", "").trim();

  // Direct command: /team <name> <email>
  if (text) {
    const spaceIdx = text.indexOf(" ");
    if (spaceIdx === -1 || !text.slice(spaceIdx + 1).includes("@")) {
      await sendMessage(env, chatId, "Использование: /team НазваниеРоли email@example.com");
      return;
    }
    const roleName = text.slice(0, spaceIdx).trim();
    const email = text.slice(spaceIdx + 1).trim();
    const id = roleSlug(roleName);
    const team = await getTeamConfig(env);
    if (!team[id]) {
      team[id] = { name: roleName };
      await env.BUG_REPORTS.put("settings:team", JSON.stringify(team));
    }
    await assignTeamMember(id, email, chatId, env);
    return;
  }

  // Show panel with buttons
  const team = await getTeamConfig(env);
  const panel = buildTeamMainPanel(team);
  await sendMessageWithButtons(env, chatId, panel.text, panel.buttons);
}

// ============================================================
// Callback query router
// ============================================================

async function handleCallbackQuery(
  cq: { id: string; from: TelegramUser; message?: TelegramMessage; data?: string },
  env: Env,
): Promise<void> {
  if (!cq.message || !cq.data) return;

  // Main menu callbacks
  if (cq.data.startsWith("mn:")) {
    await handleMainCallback(cq, env);
    return;
  }

  // Digest callbacks
  if (cq.data.startsWith("dg:")) {
    if (!isAdmin(cq.from.id, env)) {
      await answerCallbackQuery(env, cq.id, "Нет доступа");
      return;
    }
    await handleDigestCallback(cq, env);
    return;
  }

  // Team callbacks
  if (cq.data.startsWith("team:") || cq.data.startsWith("tp:") || cq.data.startsWith("tpg:") || cq.data.startsWith("tu:") || cq.data === "noop") {
    if (cq.data === "noop") {
      await answerCallbackQuery(env, cq.id);
      return;
    }
    if (!isAdmin(cq.from.id, env)) {
      await answerCallbackQuery(env, cq.id, "Нет доступа");
      return;
    }
    await handleTeamCallback(cq, env);
    return;
  }

  // accept/reject callbacks for issue review
  const [action, linearIssueId] = cq.data.split(":");
  if (!linearIssueId) return;

  const mappingJson = await env.BUG_REPORTS.get(`issue:${linearIssueId}`);
  if (!mappingJson) {
    await answerCallbackQuery(env, cq.id, "Задача не найдена");
    return;
  }

  const mapping = JSON.parse(mappingJson) as IssueMapping;
  const name = userName(cq.from);

  if (action === "accept") {
    await updateLinearIssueState(env, linearIssueId, STATE_DONE);
    await editMessageText(env, cq.message.chat.id, cq.message.message_id,
      `\u2705 <b>Задача ${esc(mapping.issueId)} принята</b>\nПодтвердил: ${esc(name)}`);
    await answerCallbackQuery(env, cq.id, "Задача принята!");
  } else if (action === "reject") {
    const pending: PendingReject = {
      linearIssueId,
      issueId: mapping.issueId,
      botMessageChatId: cq.message.chat.id,
      botMessageId: cq.message.message_id,
    };
    await env.BUG_REPORTS.put(
      `pending_reject:${cq.message.chat.id}:${cq.from.id}`,
      JSON.stringify(pending),
      { expirationTtl: 300 },
    );
    await editMessageText(env, cq.message.chat.id, cq.message.message_id,
      `\u274C <b>Отклонение ${esc(mapping.issueId)}</b>\n\nНапишите причину отклонения:`);
    await answerCallbackQuery(env, cq.id, "Напишите причину отклонения");
  }
}

// --- Main panel callbacks ---

async function handleMainCallback(
  cq: { id: string; from: TelegramUser; message?: TelegramMessage; data?: string },
  env: Env,
): Promise<void> {
  if (!cq.message || !cq.data) return;
  const chatId = cq.message.chat.id;
  const msgId = cq.message.message_id;
  const action = cq.data.split(":")[1];

  if (action === "home") {
    const panel = await buildMainPanel(env, isAdmin(cq.from.id, env));
    await editMessageWithButtons(env, chatId, msgId, panel.text, panel.buttons);
    await answerCallbackQuery(env, cq.id);
    return;
  }

  if (action === "report") {
    await editMessageWithButtons(env, chatId, msgId,
      "\uD83D\uDCDD <b>Новый репорт</b>\n\nОпишите проблему или запрос текстом:",
      [[{ text: "\u2B05\uFE0F Назад", callback_data: "mn:home" }]]);
    await env.BUG_REPORTS.put(
      `pending_report:${chatId}:${cq.from.id}`,
      JSON.stringify({ panelChatId: chatId, panelMessageId: msgId } satisfies PendingReport),
      { expirationTtl: 300 },
    );
    await answerCallbackQuery(env, cq.id);
    return;
  }

  if (action === "tasks") {
    await editMessageWithButtons(env, chatId, msgId, `${CE.LOADING} Загрузка...`, []);
    try {
      const issues = await listLinearIssuesByTeam(env);
      const active = issues.filter((i) => !["completed", "canceled"].includes(i.stateType));
      if (active.length === 0) {
        await editMessageWithButtons(env, chatId, msgId, "\u2705 Нет открытых задач",
          [[{ text: "\u2B05\uFE0F Назад", callback_data: "mn:home" }]]);
      } else {
        const lines = [
          `\uD83D\uDCCB <b>Открытые задачи (${active.length}):</b>`,
          "",
        ];
        active.slice(0, 15).forEach((i) => {
          const st = clientStatus(i.stateType, i.stateName);
          lines.push(`${st} <b>${esc(i.identifier)}</b> ${esc(i.title)}`);
        });
        if (active.length > 15) lines.push(`_...и ещё ${active.length - 15}_`);
        const btns: Btn[][] = [[
          { text: "\uD83D\uDD04 Обновить", callback_data: "mn:tasks" },
          { text: "\u2B05\uFE0F Назад", callback_data: "mn:home" },
        ]];
        await editMessageWithButtons(env, chatId, msgId, lines.join("\n"), btns);
      }
    } catch (e) {
      await editMessageWithButtons(env, chatId, msgId,
        `\u274C Ошибка: ${esc(e instanceof Error ? e.message : "unknown")}`,
        [[{ text: "\u2B05\uFE0F Назад", callback_data: "mn:home" }]]);
    }
    await answerCallbackQuery(env, cq.id);
    return;
  }

  if (action === "stats") {
    await editMessageWithButtons(env, chatId, msgId, `${CE.LOADING} Загрузка статистики...`, []);
    try {
      const m7 = await getMetrics(env, 7);
      const m30 = await getMetrics(env, 30);
      const statsLines = [
        `${CE.REPORT} <b>Статистика</b>`,
        "",
        "<b>За 7 дней:</b>",
        `Репортов: ${m7.reports_created || 0}`,
        `Голосовых: ${m7.voice_reports || 0}`,
        `Инлайн: ${m7.inline_reports || 0}`,
        `Дубли найдены: ${m7.duplicates_found || 0}`,
        `Ошибок: ${m7.reports_failed || 0}`,
        "",
        "<b>За 30 дней:</b>",
        `Репортов: ${m30.reports_created || 0}`,
        `Ошибок: ${m30.reports_failed || 0}`,
      ];
      await editMessageWithButtons(env, chatId, msgId, statsLines.join("\n"), [
        [{ text: "\uD83D\uDD04 Обновить", callback_data: "mn:stats" }, { text: "\u2B05\uFE0F Назад", callback_data: "mn:home" }],
      ]);
    } catch {
      await editMessageWithButtons(env, chatId, msgId, "\u274C Ошибка загрузки",
        [[{ text: "\u2B05\uFE0F Назад", callback_data: "mn:home" }]]);
    }
    await answerCallbackQuery(env, cq.id);
    return;
  }

  await answerCallbackQuery(env, cq.id);
}

// --- Digest panel callbacks ---

async function handleDigestCallback(
  cq: { id: string; from: TelegramUser; message?: TelegramMessage; data?: string },
  env: Env,
): Promise<void> {
  if (!cq.message || !cq.data) return;
  const chatId = cq.message.chat.id;
  const msgId = cq.message.message_id;
  const action = cq.data.split(":")[1];

  if (action === "panel") {
    const panel = await buildDigestPanel(env);
    await editMessageWithButtons(env, chatId, msgId, panel.text, panel.buttons);
    await answerCallbackQuery(env, cq.id);
    return;
  }

  if (action === "on") {
    await env.BUG_REPORTS.put("settings:digest_enabled", "true");
    const panel = await buildDigestPanel(env);
    await editMessageWithButtons(env, chatId, msgId, panel.text, panel.buttons);
    await answerCallbackQuery(env, cq.id, "\u2705 Отчёт включён");
    return;
  }

  if (action === "off") {
    await env.BUG_REPORTS.put("settings:digest_enabled", "false");
    const panel = await buildDigestPanel(env);
    await editMessageWithButtons(env, chatId, msgId, panel.text, panel.buttons);
    await answerCallbackQuery(env, cq.id, "\u23F8\uFE0F Отчёт приостановлен");
    return;
  }

  if (action === "test") {
    await answerCallbackQuery(env, cq.id, "\uD83D\uDCE8 Генерирую...");
    await editMessageWithButtons(env, chatId, msgId, `${CE.LOADING} <b>Генерирую отчёт...</b>`, []);
    try {
      await sendWeeklyDigest(env);
      const panel = await buildDigestPanel(env);
      await editMessageWithButtons(env, chatId, msgId, panel.text, panel.buttons);
    } catch (e) {
      const panel = await buildDigestPanel(env);
      await editMessageWithButtons(env, chatId, msgId,
        `${panel.text}\n\n\u274C _Ошибка: ${esc(e instanceof Error ? e.message : "unknown")}_`,
        panel.buttons);
    }
    return;
  }

  await answerCallbackQuery(env, cq.id);
}

// --- Team panel callbacks ---

async function handleTeamCallback(
  cq: { id: string; from: TelegramUser; message?: TelegramMessage; data?: string },
  env: Env,
): Promise<void> {
  if (!cq.message || !cq.data) return;
  const chatId = cq.message.chat.id;
  const msgId = cq.message.message_id;

  // User pick from list
  if (cq.data.startsWith("tp:")) {
    const tpParts = cq.data.split(":");
    const tpRole = tpParts[1];
    const tpUserId = tpParts[2];
    const usersJson = await env.BUG_REPORTS.get(`team_users:${chatId}`);
    const users: LinearWorkspaceUser[] = usersJson ? JSON.parse(usersJson) : [];
    const user = users.find((u) => u.id === tpUserId);
    if (!user) {
      await answerCallbackQuery(env, cq.id, "Пользователь не найден");
      return;
    }
    const team = await getTeamConfig(env);
    if (!team[tpRole]) {
      await answerCallbackQuery(env, cq.id, "Роль не найдена");
      return;
    }
    team[tpRole].member = { userId: user.id, name: user.name, email: user.email || "" };
    await env.BUG_REPORTS.put("settings:team", JSON.stringify(team));
    const panel = buildTeamMainPanel(team);
    await editMessageWithButtons(env, chatId, msgId, panel.text, panel.buttons);
    await answerCallbackQuery(env, cq.id, `\u2705 ${user.name}`);
    return;
  }

  // User pick pagination
  if (cq.data.startsWith("tpg:")) {
    const pgParts = cq.data.split(":");
    const pgRole = pgParts[1];
    const pgPage = parseInt(pgParts[2], 10) || 0;
    const team = await getTeamConfig(env);
    const role = team[pgRole];
    if (!role) {
      await answerCallbackQuery(env, cq.id);
      return;
    }
    const usersJson = await env.BUG_REPORTS.get(`team_users:${chatId}`);
    const users: LinearWorkspaceUser[] = usersJson ? JSON.parse(usersJson) : [];
    const panel = buildUserPickPanel(pgRole, role.name, users, pgPage);
    await editMessageWithButtons(env, chatId, msgId, panel.text, panel.buttons);
    await answerCallbackQuery(env, cq.id);
    return;
  }

  // Unassign member from role
  if (cq.data.startsWith("tu:")) {
    const tuRole = cq.data.split(":")[1];
    const team = await getTeamConfig(env);
    if (team[tuRole] && team[tuRole].member) {
      const memberName = team[tuRole].member!.name;
      delete team[tuRole].member;
      await env.BUG_REPORTS.put("settings:team", JSON.stringify(team));
      const panel = buildTeamRolePanel(team, tuRole);
      await editMessageWithButtons(env, chatId, msgId, panel.text, panel.buttons);
      await answerCallbackQuery(env, cq.id, `\u274C ${memberName} снят`);
    } else {
      await answerCallbackQuery(env, cq.id);
    }
    return;
  }

  const parts = cq.data.split(":");
  const action = parts[1];
  const roleId = parts[2];

  if (action === "main") {
    await env.BUG_REPORTS.delete(`pending_team_set:${chatId}:${cq.from.id}`);
    await env.BUG_REPORTS.delete(`pending_team_name:${chatId}:${cq.from.id}`);
    const team = await getTeamConfig(env);
    const panel = buildTeamMainPanel(team);
    await editMessageWithButtons(env, chatId, msgId, panel.text, panel.buttons);
    await answerCallbackQuery(env, cq.id);
    return;
  }

  if (action === "add") {
    const panel = buildAddRolePanel();
    await editMessageWithButtons(env, chatId, msgId, panel.text, panel.buttons);
    await env.BUG_REPORTS.put(
      `pending_team_name:${chatId}:${cq.from.id}`,
      JSON.stringify({ panelChatId: chatId, panelMessageId: msgId } satisfies PendingTeamName),
      { expirationTtl: 300 },
    );
    await answerCallbackQuery(env, cq.id);
    return;
  }

  if (!roleId) { await answerCallbackQuery(env, cq.id); return; }

  if (action === "view") {
    const team = await getTeamConfig(env);
    const panel = buildTeamRolePanel(team, roleId);
    await editMessageWithButtons(env, chatId, msgId, panel.text, panel.buttons);
    await answerCallbackQuery(env, cq.id);
    return;
  }

  if (action === "del") {
    const team = await getTeamConfig(env);
    const role = team[roleId];
    if (!role) { await answerCallbackQuery(env, cq.id); return; }
    await editMessageWithButtons(env, chatId, msgId,
      `Удалить роль <b>${esc(role.name)}</b>?\n\nЭто действие нельзя отменить.`,
      [[
        { text: "Да, удалить", callback_data: `team:delok:${roleId}` },
        { text: "Отмена", callback_data: `team:view:${roleId}` },
      ]]);
    await answerCallbackQuery(env, cq.id);
    return;
  }

  if (action === "delok") {
    const team = await getTeamConfig(env);
    const roleName = team[roleId]?.name || roleId;
    delete team[roleId];
    await env.BUG_REPORTS.put("settings:team", JSON.stringify(team));
    const panel = buildTeamMainPanel(team);
    await editMessageWithButtons(env, chatId, msgId, panel.text, panel.buttons);
    await answerCallbackQuery(env, cq.id, `${roleName} удалена`);
    return;
  }

  if (action === "setm") {
    const team = await getTeamConfig(env);
    const role = team[roleId];
    if (!role) { await answerCallbackQuery(env, cq.id); return; }
    await editMessageWithButtons(env, chatId, msgId,
      `<b>${esc(role.name)}</b>\n\nЗагрузка участников...`, []);
    try {
      const users = await listLinearWorkspaceUsers(env);
      await env.BUG_REPORTS.put(`team_users:${chatId}`, JSON.stringify(users), { expirationTtl: 120 });
      const panel = buildUserPickPanel(roleId, role.name, users, 0);
      await editMessageWithButtons(env, chatId, msgId, panel.text, panel.buttons);
    } catch (e: unknown) {
      console.error("Failed to load Linear users:", e instanceof Error ? e.message : e);
      await editMessageWithButtons(env, chatId, msgId,
        `\u274C Не удалось загрузить участников\n\n_${esc(e instanceof Error ? e.message : "Неизвестная ошибка")}_`,
        [[
          { text: "\uD83D\uDD04 Повторить", callback_data: `team:setm:${roleId}` },
          { text: "\u2B05\uFE0F Назад", callback_data: `team:view:${roleId}` },
        ]]);
    }
    await answerCallbackQuery(env, cq.id);
    return;
  }

  await answerCallbackQuery(env, cq.id);
}

// --- Handle email text for team member assignment ---

async function handleTeamSetEmail(
  message: TelegramMessage, pending: PendingTeamSet, kvKey: string, env: Env,
): Promise<void> {
  await env.BUG_REPORTS.delete(kvKey);
  const email = (message.text || "").trim();

  if (!email || !email.includes("@")) {
    const team = await getTeamConfig(env);
    const panel = buildTeamRolePanel(team, pending.role);
    await editMessageWithButtons(env, pending.panelChatId, pending.panelMessageId, panel.text, panel.buttons);
    await sendMessage(env, message.chat.id, "Некорректный email. Попробуйте ещё раз.");
    return;
  }

  await assignTeamMember(pending.role, email, message.chat.id, env, pending.panelChatId, pending.panelMessageId);
}

// --- Handle new role name input ---

async function handleTeamNameInput(
  message: TelegramMessage, pending: PendingTeamName, kvKey: string, env: Env,
): Promise<void> {
  await env.BUG_REPORTS.delete(kvKey);
  const name = (message.text || "").trim();

  if (!name) {
    const team = await getTeamConfig(env);
    const panel = buildTeamMainPanel(team);
    await editMessageWithButtons(env, pending.panelChatId, pending.panelMessageId, panel.text, panel.buttons);
    return;
  }

  const id = roleSlug(name);
  const team = await getTeamConfig(env);
  if (team[id]) {
    const panel = buildTeamMainPanel(team);
    await editMessageWithButtons(env, pending.panelChatId, pending.panelMessageId, panel.text, panel.buttons);
    await sendMessage(env, message.chat.id, `Роль "${esc(name)}" уже существует`);
    return;
  }

  team[id] = { name };
  await env.BUG_REPORTS.put("settings:team", JSON.stringify(team));
  const panel = buildTeamRolePanel(team, id);
  await editMessageWithButtons(env, pending.panelChatId, pending.panelMessageId, panel.text, panel.buttons);
}

// --- Shared assignment logic ---

async function assignTeamMember(
  roleId: string, email: string, chatId: number, env: Env,
  panelChatId?: number, panelMessageId?: number,
): Promise<void> {
  try {
    const user = await findLinearUserByEmail(env, email);
    if (!user) {
      if (panelChatId && panelMessageId) {
        const team = await getTeamConfig(env);
        const panel = buildTeamRolePanel(team, roleId);
        await editMessageWithButtons(env, panelChatId, panelMessageId, panel.text, panel.buttons);
      }
      await sendMessage(env, chatId, `Пользователь ${esc(email)} не найден в Linear`);
      return;
    }

    const team = await getTeamConfig(env);
    if (!team[roleId]) team[roleId] = { name: roleId };
    team[roleId].member = { userId: user.id, name: user.name, email: user.email };
    await env.BUG_REPORTS.put("settings:team", JSON.stringify(team));

    if (panelChatId && panelMessageId) {
      const panel = buildTeamMainPanel(team);
      await editMessageWithButtons(env, panelChatId, panelMessageId, panel.text, panel.buttons);
    }

    if (!panelChatId) {
      await sendMessage(env, chatId,
        `\u2705 <b>${esc(team[roleId].name)}</b> назначен: <b>${esc(user.name)}</b>`);
    }
  } catch (e) {
    await sendMessage(env, chatId,
      `Ошибка: ${e instanceof Error ? esc(e.message) : "неизвестная"}`);
  }
}

// ============================================================
// Media group batching
// ============================================================

async function handleMediaGroup(message: TelegramMessage, env: Env, origin: string): Promise<void> {
  const groupId = message.media_group_id!;
  const key = `mediagroup:${groupId}`;

  const existingJson = await env.BUG_REPORTS.get(key);
  const buffer: MediaGroupBuffer = existingJson ? JSON.parse(existingJson) : {
    chatId: message.chat.id,
    text: "",
    reporterName: userName(message.from),
    firstMessageId: message.message_id,
    photos: [],
    videoFileIds: [],
    videoThumbIds: [],
    timestamp: Date.now(),
  };

  if (message.caption && !buffer.text) {
    buffer.text = message.caption.replace(/^\/report(@\S+)?/i, "").trim();
  }

  if (message.photo && message.photo.length > 0) {
    buffer.photos.push(message.photo[message.photo.length - 1].file_id);
  }

  if (message.video) {
    buffer.videoFileIds.push(message.video.file_id);
    if (message.video.thumbnail) {
      buffer.videoThumbIds.push(message.video.thumbnail.file_id);
    }
  }

  await env.BUG_REPORTS.put(key, JSON.stringify(buffer), { expirationTtl: 30 });

  if (!existingJson) {
    await sleep(MEDIA_GROUP_DELAY_MS);
    await processMediaGroup(key, env, origin);
  }
}

async function processMediaGroup(key: string, env: Env, origin: string): Promise<void> {
  const json = await env.BUG_REPORTS.get(key);
  if (!json) return;
  await env.BUG_REPORTS.delete(key);

  const buffer = JSON.parse(json) as MediaGroupBuffer;
  const imagesForAI: { data: string; mediaType: string }[] = [];
  const videosForAI: { buffer: ArrayBuffer; mediaType: string }[] = [];
  const mediaUrls: string[] = [];

  for (const fileId of buffer.photos) {
    const file = await downloadFile(env, fileId);
    if (file) {
      imagesForAI.push({ data: arrayBufferToBase64(file.buffer), mediaType: file.mediaType });
      const fileKey = `photo/${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
      await env.MEDIA_BUCKET.put(fileKey, file.buffer, { httpMetadata: { contentType: file.mediaType } });
      mediaUrls.push(`${origin}/media/${fileKey}`);
    }
  }

  for (const thumbId of buffer.videoThumbIds) {
    const file = await downloadFile(env, thumbId);
    if (file) imagesForAI.push({ data: arrayBufferToBase64(file.buffer), mediaType: file.mediaType });
  }
  for (const videoId of buffer.videoFileIds) {
    const file = await downloadFile(env, videoId);
    if (file) {
      videosForAI.push({ buffer: file.buffer, mediaType: "video/mp4" });
      const fileKey = `video/${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`;
      await env.MEDIA_BUCKET.put(fileKey, file.buffer, { httpMetadata: { contentType: "video/mp4" } });
      mediaUrls.push(`${origin}/media/${fileKey}`);
    }
  }

  await createReportFlow(buffer.chatId, buffer.firstMessageId, buffer.reporterName, buffer.text, imagesForAI, videosForAI, mediaUrls, env);
}

// ============================================================
// Single message report
// ============================================================

async function processSingleReport(message: TelegramMessage, env: Env, origin: string): Promise<void> {
  const rawText = message.text || message.caption || "";
  const text = rawText.replace(/^\/report(@\S+)?/i, "").trim();
  const coll = await collectAndUploadMedia(message, env, origin);
  const fullText = text + (coll.extraText ? "\n\n" + coll.extraText : "");

  await createReportFlow(
    message.chat.id, message.message_id, userName(message.from),
    fullText, coll.imagesForAI, coll.videosForAI, coll.mediaUrls, env,
  );
}

// ============================================================
// Shared report creation flow with duplicate detection
// ============================================================

async function createReportFlow(
  chatId: number, messageId: number, reporterName: string,
  text: string, imagesForAI: { data: string; mediaType: string }[],
  videosForAI: { buffer: ArrayBuffer; mediaType: string }[],
  mediaUrls: string[], env: Env,
): Promise<void> {
  const loadingMsgId = await sendMessage(env, chatId,
    `${CE.LOADING} <b>Репорт принят!</b> Обрабатываю...`, messageId);

  try {
    const team = await getTeamConfig(env);
    let report;
    try {
      report = videosForAI.length > 0 && env.GEMINI_API_KEY
        ? await analyzeVideoReport(env, text, imagesForAI, videosForAI, team)
        : await analyzeBugReport(env, text, imagesForAI, team);
    } catch (aiErr: unknown) {
      console.error("AI analysis failed, retrying text-only:", aiErr instanceof Error ? aiErr.message : aiErr);
      if (text && text.trim()) {
        report = await analyzeBugReport(env, text, [], team);
      } else {
        throw aiErr;
      }
    }

    const { userId: assigneeId, roleName: assigneeName } = resolveAssignment(team, report.assignee);

    // Duplicate detection: semantic search first, then keyword fallback
    let duplicates: { identifier: string; title: string; url: string; score?: number }[] = [];
    try {
      if (env.VECTORIZE && env.AI) {
        const semMatches = await findSimilarIssues(env, report.title, report.description);
        for (let si = 0; si < semMatches.length && si < 3; si++) {
          try {
            const iData = await linearGQL(env,
              `query($id: String!) { issue(id: $id) { identifier title url state { type } } }`,
              { id: semMatches[si].linearIssueId }, 5_000);
            if (iData.issue?.state?.type !== "completed" && iData.issue?.state?.type !== "canceled") {
              duplicates.push({
                identifier: iData.issue.identifier,
                title: iData.issue.title,
                url: iData.issue.url,
                score: semMatches[si].score,
              });
            }
          } catch { /* ignore individual lookup failures */ }
        }
      }
      if (duplicates.length === 0) {
        const kwRes = await searchLinearIssues(env, report.title);
        duplicates = kwRes
          .filter((r) => !["completed", "canceled"].includes(r.state))
          .slice(0, 3);
      }
    } catch (dupErr) {
      console.error("Duplicate search failed:", dupErr);
    }

    const { issueId, issueUrl, linearIssueId } = await createLinearIssue(env, report, mediaUrls, assigneeId);

    const mapping: IssueMapping = {
      chatId, messageId, reporterName, issueId, issueUrl,
      title: report.title,
    };
    await env.BUG_REPORTS.put(`issue:${linearIssueId}`, JSON.stringify(mapping), {
      expirationTtl: 60 * 60 * 24 * 90,
    });

    // Store vector for future semantic search
    if (env.VECTORIZE && env.AI) {
      await storeIssueVector(env, linearIssueId, report.title, report.description);
    }

    const replyParts = [
      `${CE.SUCCESS} <b>Баг-репорт создан!</b>`,
      ``,
      `<b>${esc(report.title)}</b>`,
      `Приоритет: ${priorityLabel(report.priority)}`,
      report.labels.length > 0 ? `Метки: ${report.labels.join(", ")}` : "",
      assigneeName ? `Назначен: <b>${esc(assigneeName)}</b>` : "",
      ``,
      issueUrl ? `<a href="${issueUrl}">${issueId} — Открыть в Linear</a>` : `Задача: ${issueId}`,
    ].filter(Boolean);

    if (duplicates.length > 0) {
      replyParts.push("", `${CE.SIMILAR} <b>Похожие задачи:</b>`);
      for (const dd of duplicates) {
        const scoreTag = dd.score ? ` (${Math.round(dd.score * 100)}%)` : "";
        replyParts.push(`\u2022 <a href="${dd.url}">${dd.identifier}</a> — ${esc(dd.title)}${scoreTag}`);
      }
    }

    if (loadingMsgId) {
      await editMessageText(env, chatId, loadingMsgId, replyParts.join("\n"));
    } else {
      await sendMessage(env, chatId, replyParts.join("\n"), messageId);
    }

    await trackMetric(env, "reports_created");
    if (duplicates.length > 0) await trackMetric(env, "duplicates_found");
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : "unknown";
    console.error("Failed to process bug report:", errMsg);
    await trackMetric(env, "reports_failed");

    const errorText = `${CE.ERROR} <b>Не удалось обработать репорт</b>\n\nПопробуйте ещё раз через минуту. Если проблема повторяется — напишите нам напрямую.`;
    if (loadingMsgId) {
      await editMessageText(env, chatId, loadingMsgId, errorText);
    } else {
      await sendMessage(env, chatId, errorText, messageId);
    }

    // Notify admins about error
    try {
      const admins = env.ADMIN_USERS.split(",");
      for (const admin of admins) {
        await sendMessage(env, Number(admin.trim()),
          `${CE.ERROR} <b>Ошибка репорта</b>\n\n<code>${esc(errMsg)}</code>\n\nChat: ${chatId}`);
      }
    } catch { /* ignore admin notification failures */ }
  }
}

// --- Silent version for admin panel reports ---

async function createReportFlowSilent(
  chatId: number, messageId: number, reporterName: string,
  text: string, imagesForAI: { data: string; mediaType: string }[],
  videosForAI: { buffer: ArrayBuffer; mediaType: string }[],
  mediaUrls: string[], env: Env,
  editChatId: number, editMsgId: number,
): Promise<void> {
  const team = await getTeamConfig(env);
  let report;
  try {
    report = videosForAI.length > 0 && env.GEMINI_API_KEY
      ? await analyzeVideoReport(env, text, imagesForAI, videosForAI, team)
      : await analyzeBugReport(env, text, imagesForAI, team);
  } catch (aiErr: unknown) {
    console.error("AI analysis failed (silent), retrying text-only:", aiErr instanceof Error ? (aiErr as Error).message : aiErr);
    if (text && text.trim()) {
      report = await analyzeBugReport(env, text, [], team);
    } else {
      throw aiErr;
    }
  }

  const { userId: assigneeId, roleName: assigneeName } = resolveAssignment(team, report.assignee);

  let duplicates: { identifier: string; title: string; url: string; score?: number }[] = [];
  try {
    if (env.VECTORIZE && env.AI) {
      const sem = await findSimilarIssues(env, report.title, report.description);
      for (let si = 0; si < sem.length && si < 3; si++) {
        try {
          const id2 = await linearGQL(env,
            `query($id: String!) { issue(id: $id) { identifier title url state { type } } }`,
            { id: sem[si].linearIssueId }, 5_000);
          if (id2.issue?.state?.type !== "completed" && id2.issue?.state?.type !== "canceled") {
            duplicates.push({ identifier: id2.issue.identifier, title: id2.issue.title, url: id2.issue.url, score: sem[si].score });
          }
        } catch { /* ignore */ }
      }
    }
    if (duplicates.length === 0) {
      const kw = await searchLinearIssues(env, report.title);
      duplicates = kw.filter((r) => !["completed", "canceled"].includes(r.state)).slice(0, 3);
    }
  } catch { /* ignore */ }

  const cr = await createLinearIssue(env, report, mediaUrls, assigneeId);
  await env.BUG_REPORTS.put(
    `issue:${cr.linearIssueId}`,
    JSON.stringify({ chatId, messageId, reporterName, issueId: cr.issueId, issueUrl: cr.issueUrl, title: report.title }),
    { expirationTtl: 7_776_000 },
  );

  if (env.VECTORIZE && env.AI) await storeIssueVector(env, cr.linearIssueId, report.title, report.description);

  const parts = [
    `${CE.SUCCESS} <b>Баг-репорт создан!</b>`,
    "",
    `<b>${esc(report.title)}</b>`,
    `Приоритет: ${priorityLabel(report.priority)}`,
  ];
  if (report.labels.length > 0) parts.push(`Метки: ${report.labels.join(", ")}`);
  if (assigneeName) parts.push(`Назначен: <b>${esc(assigneeName)}</b>`);
  parts.push("", cr.issueUrl ? `<a href="${cr.issueUrl}">${cr.issueId} — Открыть в Linear</a>` : cr.issueId);

  if (duplicates.length > 0) {
    parts.push("", `${CE.SIMILAR} <b>Похожие задачи:</b>`);
    for (const d of duplicates) {
      const sc = d.score ? ` (${Math.round(d.score * 100)}%)` : "";
      parts.push(`\u2022 <a href="${d.url}">${d.identifier}</a> — ${esc(d.title)}${sc}`);
    }
  }

  await editMessageWithButtons(env, editChatId, editMsgId, parts.join("\n"),
    [[{ text: "\u2B05\uFE0F Главная", callback_data: "mn:home" }]]);

  await trackMetric(env, "reports_created");
  if (duplicates.length > 0) await trackMetric(env, "duplicates_found");
}

// ============================================================
// Team management & auto-assignment
// ============================================================

async function getTeamConfig(env: Env): Promise<TeamConfig> {
  const json = await env.BUG_REPORTS.get("settings:team");
  if (!json) return {};
  return JSON.parse(json) as TeamConfig;
}

const MANAGER_PATTERNS = /менеджер|manager|лид|lead|руководитель|директор|director|продюсер|producer|\bpm\b|\bcto\b|\bceo\b/i;

function resolveAssignment(
  team: TeamConfig,
  assigneeSlug: string | null | undefined,
): { userId: string | undefined; roleName: string | undefined } {
  if (assigneeSlug) {
    const role = team[assigneeSlug];
    if (role?.member) {
      return { userId: role.member.userId, roleName: `${role.member.name} (${role.name})` };
    }
    // Fuzzy match by slug or role name
    const slugLower = assigneeSlug.toLowerCase();
    for (const k of Object.keys(team)) {
      if (k.toLowerCase() === slugLower || (team[k].name && team[k].name.toLowerCase() === slugLower)) {
        if (team[k].member) {
          return { userId: team[k].member!.userId, roleName: `${team[k].member!.name} (${team[k].name})` };
        }
      }
    }
  }
  // Fallback to manager-like role
  for (const role of Object.values(team)) {
    if (role.member && MANAGER_PATTERNS.test(role.name)) {
      return { userId: role.member.userId, roleName: `${role.member.name} (${role.name})` };
    }
  }
  return { userId: undefined, roleName: undefined };
}

// ============================================================
// Rejection comment handler
// ============================================================

async function handleRejectionComment(
  message: TelegramMessage,
  pending: PendingReject,
  kvKey: string,
  env: Env,
): Promise<void> {
  await env.BUG_REPORTS.delete(kvKey);
  const reason = message.text || "Без комментария";

  await addLinearComment(env, pending.linearIssueId,
    `\u274C Отклонено клиентом: ${reason}`);
  await updateLinearIssueState(env, pending.linearIssueId, STATE_IN_PROGRESS);

  await editMessageText(env, pending.botMessageChatId, pending.botMessageId,
    `\u274C <b>Задача ${esc(pending.issueId)} отклонена</b>\nПричина: ${esc(reason)}\nВозвращена в работу.`);
}

// ============================================================
// Linear webhook handling
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

  // "На проверке" -> review buttons
  if (stateId === STATE_REVIEW) {
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

  // Started (in progress)
  if (stateType === "started" && stateId !== STATE_REVIEW && mapping) {
    await sendMessage(env, mapping.chatId,
      `${CE.PROGRESS} <b>Взяли в работу</b>\n\n${esc(payload.data.title)}`);
  }
}

// ============================================================
// Weekly digest — Friday 15:00 UTC (18:00 MSK)
// ============================================================

async function sendWeeklyDigest(env: Env): Promise<void> {
  try {
    const issues = await listLinearIssuesByTeam(env);
    const now = Date.now();
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const from = new Date(weekAgo);
    const to = new Date(now);
    const fmt = (d: Date) => d.getDate().toString().padStart(2, "0") + "." + (d.getMonth() + 1).toString().padStart(2, "0");
    const weekRange = fmt(from) + " \u2013 " + fmt(to);

    const completedThisWeek = issues.filter((i) => i.completedAt && new Date(i.completedAt).getTime() > weekAgo);
    const createdThisWeek = issues.filter((i) => new Date(i.createdAt).getTime() > weekAgo);
    const inProgress = issues.filter((i) => i.stateType === "started");
    const planned = issues.filter((i) => i.stateType === "unstarted" || i.stateType === "triage");
    const open = issues.filter((i) => !["completed", "canceled"].includes(i.stateType));

    const lines: string[] = [];
    lines.push(`${CE.REPORT} <b>Отчёт за неделю (${weekRange})</b>`);
    lines.push("");
    lines.push(`Новых задач: <b>${createdThisWeek.length}</b>  \u2022  Выполнено: <b>${completedThisWeek.length}</b>  \u2022  В работе: <b>${inProgress.length}</b>`);
    lines.push("");

    if (completedThisWeek.length > 0) {
      lines.push(`${CE.DONE} <b>Выполнено:</b>`);
      completedThisWeek.forEach((i) => lines.push(`\u2022 ${esc(i.title)}`));
      lines.push("");
    } else {
      lines.push("<i>На этой неделе завершённых задач нет</i>");
      lines.push("");
    }

    if (inProgress.length > 0) {
      lines.push(`${CE.PROGRESS} <b>В работе:</b>`);
      inProgress.slice(0, 10).forEach((i) => lines.push(`\u2022 ${esc(i.title)}`));
      if (inProgress.length > 10) lines.push(`_...и ещё ${inProgress.length - 10}_`);
      lines.push("");
    }

    if (planned.length > 0) {
      lines.push(`${CE.INBOX} <b>Запланировано:</b>`);
      planned.slice(0, 8).forEach((i) => lines.push(`\u2022 ${esc(i.title)}`));
      if (planned.length > 8) lines.push(`_...и ещё ${planned.length - 8}_`);
      lines.push("");
    }

    lines.push(`Всего открытых задач: <b>${open.length}</b>`);

    const text = lines.join("\n");
    const chats = env.ALLOWED_CHATS.split(",").map((id) => id.trim());
    for (const chatIdStr of chats) {
      await sendMessage(env, Number(chatIdStr), text);
    }
  } catch (e) {
    console.error("Weekly digest failed:", e);
    try {
      const admins = env.ADMIN_USERS.split(",").map((id) => id.trim());
      for (const admin of admins) {
        await sendMessage(env, Number(admin),
          `\u274C Ошибка при генерации отчёта: ${e instanceof Error ? e.message : "unknown"}`);
      }
    } catch { /* ignore */ }
  }
}

// ============================================================
// Media collection (single message)
// ============================================================

async function collectAndUploadMedia(
  message: TelegramMessage, env: Env, origin: string,
): Promise<{
  imagesForAI: { data: string; mediaType: string }[];
  videosForAI: { buffer: ArrayBuffer; mediaType: string }[];
  mediaUrls: string[];
  extraText: string;
}> {
  const imagesForAI: { data: string; mediaType: string }[] = [];
  const videosForAI: { buffer: ArrayBuffer; mediaType: string }[] = [];
  const mediaUrls: string[] = [];
  let extraText = "";

  if (message.photo && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1];
    const file = await downloadFile(env, largest.file_id);
    if (file) {
      imagesForAI.push({ data: arrayBufferToBase64(file.buffer), mediaType: file.mediaType });
      const key = `photo/${Date.now()}-${largest.file_unique_id}.jpg`;
      await env.MEDIA_BUCKET.put(key, file.buffer, { httpMetadata: { contentType: file.mediaType } });
      mediaUrls.push(`${origin}/media/${key}`);
    }
  }

  if (message.video) {
    if (message.video.thumbnail) {
      const thumb = await downloadFile(env, message.video.thumbnail.file_id);
      if (thumb) imagesForAI.push({ data: arrayBufferToBase64(thumb.buffer), mediaType: thumb.mediaType });
    }
    if (message.video.file_size && message.video.file_size <= 20 * 1024 * 1024) {
      const file = await downloadFile(env, message.video.file_id);
      if (file) {
        const mimeType = message.video.mime_type || "video/mp4";
        videosForAI.push({ buffer: file.buffer, mediaType: mimeType });
        const ext = mimeType.split("/")[1] || "mp4";
        const key = `video/${Date.now()}-${message.video.file_unique_id}.${ext}`;
        await env.MEDIA_BUCKET.put(key, file.buffer, { httpMetadata: { contentType: mimeType } });
        mediaUrls.push(`${origin}/media/${key}`);
      }
    }
  }

  if (message.document) {
    const isImage = message.document.mime_type?.startsWith("image/");
    const isVideo = message.document.mime_type?.startsWith("video/");

    if (isImage) {
      const file = await downloadFile(env, message.document.file_id);
      if (file) {
        imagesForAI.push({ data: arrayBufferToBase64(file.buffer), mediaType: file.mediaType });
        const ext = message.document.file_name?.split(".").pop() || "jpg";
        const key = `photo/${Date.now()}-${message.document.file_unique_id}.${ext}`;
        await env.MEDIA_BUCKET.put(key, file.buffer, { httpMetadata: { contentType: file.mediaType } });
        mediaUrls.push(`${origin}/media/${key}`);
      }
    }

    if (isVideo && message.document.file_size && message.document.file_size <= 20 * 1024 * 1024) {
      if (message.document.thumbnail) {
        const thumb = await downloadFile(env, message.document.thumbnail.file_id);
        if (thumb) imagesForAI.push({ data: arrayBufferToBase64(thumb.buffer), mediaType: thumb.mediaType });
      }
      const file = await downloadFile(env, message.document.file_id);
      if (file) {
        const mimeType = message.document.mime_type || "video/mp4";
        videosForAI.push({ buffer: file.buffer, mediaType: mimeType });
        const ext = message.document.file_name?.split(".").pop() || "mp4";
        const key = `video/${Date.now()}-${message.document.file_unique_id}.${ext}`;
        await env.MEDIA_BUCKET.put(key, file.buffer, { httpMetadata: { contentType: mimeType } });
        mediaUrls.push(`${origin}/media/${key}`);
      }
    }
  }

  return { imagesForAI, videosForAI, mediaUrls, extraText };
}

// ============================================================
// Helpers
// ============================================================

function clientStatus(stateType: string, stateName: string): string {
  let emoji: string;
  switch (stateType) {
    case "triage":
    case "backlog":
    case "unstarted":
      emoji = CE.INBOX; break;
    case "started":
      emoji = CE.PROGRESS; break;
    case "completed":
      emoji = CE.DONE; break;
    case "canceled":
      emoji = "\u274C"; break;
    default:
      emoji = "";
  }
  return emoji + " " + (stateName || stateType || "\u2014");
}

function priorityLabel(priority: number): string {
  switch (priority) {
    case 1: return "Срочный";
    case 2: return "Высокий";
    case 3: return "Средний";
    case 4: return "Низкий";
    default: return "Нет";
  }
}

function esc(text: string): string {
  if (!text || typeof text !== "string") return "";
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
// Metrics tracking
// ============================================================

async function trackMetric(env: Env, metric: string): Promise<void> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const key = `metrics:${today}:${metric}`;
    const val = await env.BUG_REPORTS.get(key);
    const count = val ? parseInt(val, 10) + 1 : 1;
    await env.BUG_REPORTS.put(key, String(count), { expirationTtl: 60 * 60 * 24 * 90 });
  } catch (e) {
    console.error(e);
  }
}

async function getMetrics(env: Env, days: number): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  const now = new Date();
  for (let d = 0; d < days; d++) {
    const date = new Date(now.getTime() - d * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const metrics = ["reports_created", "reports_failed", "voice_reports", "inline_reports", "duplicates_found"];
    for (const m of metrics) {
      const val = await env.BUG_REPORTS.get(`metrics:${date}:${m}`);
      if (val) {
        if (!result[m]) result[m] = 0;
        result[m] += parseInt(val, 10);
      }
    }
  }
  return result;
}
