import type {
  Env, TelegramUser, TelegramMessage, IssueMapping,
  PendingReject, PendingTeamSet, PendingTeamName, PendingReport,
  LinearWorkspaceUser,
} from "./types";
import {
  sendMessage, sendMessageWithButtons, editMessageText,
  editMessageWithButtons, answerCallbackQuery,
} from "./telegram";
import {
  updateLinearIssueState, addLinearComment,
  listLinearIssuesByTeam, findLinearUserByEmail,
  listLinearWorkspaceUsers,
} from "./composio";
import { CE, esc, isAdmin, userName, getTeamConfig, clientStatus, getMetrics, type Btn } from "./utils";
import {
  buildMainPanel, buildDigestPanel, buildTeamMainPanel,
  buildTeamRolePanel, buildTeamSetPanel, buildUserPickPanel,
  buildAddRolePanel, roleSlug,
} from "./panels";
import { sendWeeklyDigest } from "./digest";
import { createReportFlowSilent } from "./reports";

// Linear state IDs
const STATE_IN_PROGRESS = "5c2e2165-d492-4963-b3f2-1eda3a2e7135";

export async function handleCallbackQuery(
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
    const STATE_DONE = "a36c8892-9daa-4127-8e36-7553e2afff8a";
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

export async function handleTeamSetEmail(
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

export async function handleTeamNameInput(
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

export async function assignTeamMember(
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

// --- Rejection comment handler ---

export async function handleRejectionComment(
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
