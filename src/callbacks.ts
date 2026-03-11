import type {
  Env, TelegramUser, TelegramMessage, IssueMapping,
  PendingReject, PendingTeamSet, PendingTeamName, PendingReport,
  PendingPick, PendingChatBind, PendingPmAdd,
  LinearWorkspaceUser, ProjectConfig, ChatBinding,
} from "./types";
import {
  sendMessage, sendMessageWithButtons, editMessageText,
  editMessageWithButtons, answerCallbackQuery,
} from "./telegram";
import {
  updateLinearIssueState, addLinearComment,
  listLinearIssuesByTeam, listLinearWorkspaceUsers,
  listLinearTeams, listTeamProjects, fetchTeamStates, fetchTeamLabels,
} from "./composio";
import {
  CE, esc, isAdmin, userName, getTeamConfig, saveTeamConfig,
  getProjectConfig, getProjectList, saveProjectConfig,
  isProjectManager, clientStatus, getMetrics, projectSlug,
  type Btn,
} from "./utils";
import {
  buildMainPanel, buildProjectListPanel, buildProjectDetailPanel,
  buildProjectConnectTeamPanel, buildProjectConnectProjectPanel,
  buildProjectConnectedPanel, buildChatBindingPanel, buildManagersPanel,
  buildProjectDeleteConfirm, buildProjectSelectPanel,
  buildTeamMainPanel, buildTeamRolePanel, buildUserPickPanel,
  buildAddRolePanel, buildDigestPanel, roleSlug,
} from "./panels";
import { sendWeeklyDigest } from "./digest";
import { createReportFlowSilent } from "./reports";

// ============================================================
// Main callback router
// ============================================================

export async function handleCallbackQuery(
  cq: { id: string; from: TelegramUser; message?: TelegramMessage; data?: string },
  env: Env,
): Promise<void> {
  if (!cq.message || !cq.data) return;
  const data = cq.data;

  if (data === "noop") {
    await answerCallbackQuery(env, cq.id);
    return;
  }

  // Main menu
  if (data.startsWith("mn:")) {
    await handleMainCallback(cq, env);
    return;
  }

  // Project management (super admin only for list/conn/connect)
  if (data.startsWith("pj:") || data.startsWith("pc:")) {
    const needsSuperAdmin = data === "pj:list" || data === "pj:conn" || data.startsWith("pc:");
    if (needsSuperAdmin) {
      if (!isAdmin(cq.from.id, env)) {
        await answerCallbackQuery(env, cq.id, "Нет доступа");
        return;
      }
    } else {
      // Project-scoped: admin or PM
      const slug = data.split(":")[2];
      if (slug && !isAdmin(cq.from.id, env) && !await isProjectManager(cq.from.id, slug, env)) {
        await answerCallbackQuery(env, cq.id, "Нет доступа");
        return;
      }
    }
    await handleProjectCallback(cq, env);
    return;
  }

  // Team management (admin or PM)
  if (data.startsWith("tm:")) {
    const slug = data.split(":")[2];
    if (slug && !isAdmin(cq.from.id, env) && !await isProjectManager(cq.from.id, slug, env)) {
      await answerCallbackQuery(env, cq.id, "Нет доступа");
      return;
    }
    await handleTeamCallback(cq, env);
    return;
  }

  // User pick / pagination (context from KV)
  if (data.startsWith("tp:") || data.startsWith("tg:")) {
    await handleUserPickCallback(cq, env);
    return;
  }

  // Digest
  if (data.startsWith("dg:")) {
    const slug = data.split(":")[2];
    if (slug && !isAdmin(cq.from.id, env) && !await isProjectManager(cq.from.id, slug, env)) {
      await answerCallbackQuery(env, cq.id, "Нет доступа");
      return;
    }
    await handleDigestCallback(cq, env);
    return;
  }

  // Issue accept/reject
  const [action, linearIssueId] = data.split(":");
  if (!linearIssueId) return;

  const mappingJson = await env.BUG_REPORTS.get(`issue:${linearIssueId}`);
  if (!mappingJson) {
    await answerCallbackQuery(env, cq.id, "Задача не найдена");
    return;
  }

  const mapping = JSON.parse(mappingJson) as IssueMapping;
  const name = userName(cq.from);

  if (action === "accept") {
    const pSlug = mapping.projectSlug || "valwin";
    const project = await getProjectConfig(env, pSlug);
    const doneState = project?.states.done;
    if (!doneState) {
      await answerCallbackQuery(env, cq.id, `Проект "${pSlug}" не найден или не настроен`);
      return;
    }
    await updateLinearIssueState(env, linearIssueId, doneState);
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

// ============================================================
// Main panel callbacks
// ============================================================

async function handleMainCallback(
  cq: { id: string; from: TelegramUser; message?: TelegramMessage; data?: string },
  env: Env,
): Promise<void> {
  if (!cq.message || !cq.data) return;
  const chatId = cq.message.chat.id;
  const msgId = cq.message.message_id;
  const parts = cq.data.split(":");
  const action = parts[1];

  if (action === "home") {
    const panel = buildMainPanel(isAdmin(cq.from.id, env));
    await editMessageWithButtons(env, chatId, msgId, panel.text, panel.buttons);
    await answerCallbackQuery(env, cq.id);
    return;
  }

  // Report: select project first if multiple
  if (action === "rep") {
    const slug = parts[2]; // mn:rep:{slug} if project already selected
    if (slug) {
      const project = await getProjectConfig(env, slug);
      if (!project) {
        await answerCallbackQuery(env, cq.id, "Проект не найден");
        return;
      }
      await editMessageWithButtons(env, chatId, msgId,
        `\uD83D\uDCDD <b>Новый репорт — ${esc(project.projectName)}</b>\n\nОпишите проблему или запрос текстом:`,
        [[{ text: "\u2B05\uFE0F Назад", callback_data: "mn:home" }]]);
      await env.BUG_REPORTS.put(
        `pending_report:${chatId}:${cq.from.id}`,
        JSON.stringify({ projectSlug: slug, panelChatId: chatId, panelMessageId: msgId } satisfies PendingReport),
        { expirationTtl: 300 },
      );
      await answerCallbackQuery(env, cq.id);
      return;
    }
    // No slug — check how many projects
    const slugs = await getProjectList(env);
    if (slugs.length === 0) {
      await answerCallbackQuery(env, cq.id, "Нет подключённых проектов");
      return;
    }
    if (slugs.length === 1) {
      // Auto-select single project
      const project = await getProjectConfig(env, slugs[0]);
      if (!project) { await answerCallbackQuery(env, cq.id); return; }
      await editMessageWithButtons(env, chatId, msgId,
        `\uD83D\uDCDD <b>Новый репорт — ${esc(project.projectName)}</b>\n\nОпишите проблему или запрос текстом:`,
        [[{ text: "\u2B05\uFE0F Назад", callback_data: "mn:home" }]]);
      await env.BUG_REPORTS.put(
        `pending_report:${chatId}:${cq.from.id}`,
        JSON.stringify({ projectSlug: slugs[0], panelChatId: chatId, panelMessageId: msgId } satisfies PendingReport),
        { expirationTtl: 300 },
      );
      await answerCallbackQuery(env, cq.id);
      return;
    }
    // Multiple projects — show picker
    const projects: ProjectConfig[] = [];
    for (const s of slugs) {
      const p = await getProjectConfig(env, s);
      if (p) projects.push(p);
    }
    const panel = buildProjectSelectPanel(projects, "mn:rep");
    await editMessageWithButtons(env, chatId, msgId, panel.text, panel.buttons);
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

// ============================================================
// Project callbacks (pj:*, pc:*)
// ============================================================

async function handleProjectCallback(
  cq: { id: string; from: TelegramUser; message?: TelegramMessage; data?: string },
  env: Env,
): Promise<void> {
  if (!cq.message || !cq.data) return;
  const chatId = cq.message.chat.id;
  const msgId = cq.message.message_id;
  const parts = cq.data.split(":");

  // --- pj:list ---
  if (cq.data === "pj:list") {
    const slugs = await getProjectList(env);
    const projects: ProjectConfig[] = [];
    for (const s of slugs) {
      const p = await getProjectConfig(env, s);
      if (p) projects.push(p);
    }
    const panel = buildProjectListPanel(projects);
    await editMessageWithButtons(env, chatId, msgId, panel.text, panel.buttons);
    await answerCallbackQuery(env, cq.id);
    return;
  }

  // --- pj:conn (step 1: select team) ---
  if (cq.data === "pj:conn") {
    await editMessageWithButtons(env, chatId, msgId, `${CE.LOADING} Загрузка команд...`, []);
    try {
      const teams = await listLinearTeams(env);
      // Cache teams for step 2
      await env.BUG_REPORTS.put(`connect_teams:${chatId}`, JSON.stringify(teams), { expirationTtl: 300 });
      const panel = buildProjectConnectTeamPanel(teams);
      await editMessageWithButtons(env, chatId, msgId, panel.text, panel.buttons);
    } catch (e) {
      await editMessageWithButtons(env, chatId, msgId,
        `\u274C Ошибка: ${esc(e instanceof Error ? e.message : "unknown")}`,
        [[{ text: "\u2B05\uFE0F Назад", callback_data: "pj:list" }]]);
    }
    await answerCallbackQuery(env, cq.id);
    return;
  }

  // --- pc:t:{teamId} (step 2: select project in team) ---
  if (parts[0] === "pc" && parts[1] === "t") {
    const teamId = parts[2];
    await editMessageWithButtons(env, chatId, msgId, `${CE.LOADING} Загрузка проектов...`, []);
    try {
      const teamsJson = await env.BUG_REPORTS.get(`connect_teams:${chatId}`);
      const teams: { id: string; name: string; key: string }[] = teamsJson ? JSON.parse(teamsJson) : [];
      const teamIdx = teams.findIndex((t) => t.id === teamId);
      const teamName = teams[teamIdx]?.name || "?";

      const projects = await listTeamProjects(env, teamId);
      // Cache team+projects for step 3
      await env.BUG_REPORTS.put(`connect_projects:${chatId}`, JSON.stringify({ teamId, teamName, teamKey: teams[teamIdx]?.key || "", projects }), { expirationTtl: 300 });

      const panel = buildProjectConnectProjectPanel(teamName, projects, teamIdx);
      await editMessageWithButtons(env, chatId, msgId, panel.text, panel.buttons);
    } catch (e) {
      await editMessageWithButtons(env, chatId, msgId,
        `\u274C Ошибка: ${esc(e instanceof Error ? e.message : "unknown")}`,
        [[{ text: "\u2B05\uFE0F Назад", callback_data: "pj:conn" }]]);
    }
    await answerCallbackQuery(env, cq.id);
    return;
  }

  // --- pc:p:{teamIdx}:{projIdx} (step 3: connect project) ---
  if (parts[0] === "pc" && parts[1] === "p") {
    const projIdx = parseInt(parts[3], 10);
    await editMessageWithButtons(env, chatId, msgId, `${CE.LOADING} Подключение проекта...`, []);
    try {
      const cacheJson = await env.BUG_REPORTS.get(`connect_projects:${chatId}`);
      if (!cacheJson) throw new Error("Сессия истекла. Начните заново.");
      const cache = JSON.parse(cacheJson) as { teamId: string; teamName: string; teamKey: string; projects: { id: string; name: string }[] };
      const proj = cache.projects[projIdx];
      if (!proj) throw new Error("Проект не найден");

      // Fetch states + labels
      const [states, labels] = await Promise.all([
        fetchTeamStates(env, cache.teamId),
        fetchTeamLabels(env, cache.teamId),
      ]);

      // Generate slug, ensure unique
      let slug = projectSlug(proj.name);
      const existingSlugs = await getProjectList(env);
      if (existingSlugs.includes(slug)) {
        let suffix = 2;
        while (existingSlugs.includes(`${slug.slice(0, 8)}-${suffix}`) && suffix < 100) suffix++;
        if (suffix >= 100) throw new Error("Не удалось сгенерировать уникальный slug");
        slug = `${slug.slice(0, 8)}-${suffix}`;
      }

      const project: ProjectConfig = {
        slug,
        projectId: proj.id,
        projectName: proj.name,
        teamId: cache.teamId,
        teamKey: cache.teamKey,
        states,
        labels,
        managers: [],
        createdAt: new Date().toISOString(),
      };

      // Save project
      await saveProjectConfig(env, project);
      existingSlugs.push(slug);
      await env.BUG_REPORTS.put("project_list", JSON.stringify(existingSlugs));

      // Cleanup temp caches
      await env.BUG_REPORTS.delete(`connect_teams:${chatId}`);
      await env.BUG_REPORTS.delete(`connect_projects:${chatId}`);

      const panel = buildProjectConnectedPanel(project);
      await editMessageWithButtons(env, chatId, msgId, panel.text, panel.buttons);
    } catch (e) {
      await editMessageWithButtons(env, chatId, msgId,
        `\u274C Ошибка: ${esc(e instanceof Error ? e.message : "unknown")}`,
        [[{ text: "\u2B05\uFE0F Назад", callback_data: "pj:conn" }]]);
    }
    await answerCallbackQuery(env, cq.id);
    return;
  }

  // --- pj:v:{slug} (project detail) ---
  if (parts[1] === "v" && parts[2]) {
    const slug = parts[2];
    const project = await getProjectConfig(env, slug);
    if (!project) {
      await answerCallbackQuery(env, cq.id, "Проект не найден");
      return;
    }
    const team = await getTeamConfig(env, slug);
    const roleCount = Object.keys(team).length;
    const assignedCount = Object.values(team).filter((r) => r.member).length;
    const bindListJson = await env.BUG_REPORTS.get(`project_chats:${slug}`);
    const boundChatIds: number[] = bindListJson ? JSON.parse(bindListJson) : [];
    const chatCount = boundChatIds.length;

    const panel = buildProjectDetailPanel(project, chatCount, roleCount, assignedCount);
    await editMessageWithButtons(env, chatId, msgId, panel.text, panel.buttons);
    await answerCallbackQuery(env, cq.id);
    return;
  }

  // --- pj:c:{slug} (chat bindings) ---
  if (parts[1] === "c" && parts[2]) {
    const slug = parts[2];
    const project = await getProjectConfig(env, slug);
    if (!project) { await answerCallbackQuery(env, cq.id, "Проект не найден"); return; }
    const bindListJson = await env.BUG_REPORTS.get(`project_chats:${slug}`);
    const chatIds: number[] = bindListJson ? JSON.parse(bindListJson) : [];
    const panel = buildChatBindingPanel(slug, project.projectName, chatIds);
    await editMessageWithButtons(env, chatId, msgId, panel.text, panel.buttons);
    // Set pending for text input
    await env.BUG_REPORTS.put(
      `pending_chat_bind:${chatId}:${cq.from.id}`,
      JSON.stringify({ projectSlug: slug, panelChatId: chatId, panelMessageId: msgId } satisfies PendingChatBind),
      { expirationTtl: 300 },
    );
    await answerCallbackQuery(env, cq.id);
    return;
  }

  // --- pj:cb:{slug} (explicit bind button — same as entering chat panel) ---
  if (parts[1] === "cb" && parts[2]) {
    // Redirect to pj:c
    cq.data = `pj:c:${parts[2]}`;
    await handleProjectCallback(cq, env);
    return;
  }

  // --- pj:cu:{slug}:{chatId} (unbind chat) ---
  if (parts[1] === "cu" && parts[2] && parts[3]) {
    const slug = parts[2];
    const unbindChatId = Number(parts[3]);
    await env.BUG_REPORTS.delete(`chat_binding:${unbindChatId}`);
    // Update project_chats list
    const bindListJson = await env.BUG_REPORTS.get(`project_chats:${slug}`);
    let chatIds: number[] = bindListJson ? JSON.parse(bindListJson) : [];
    chatIds = chatIds.filter((c) => c !== unbindChatId);
    await env.BUG_REPORTS.put(`project_chats:${slug}`, JSON.stringify(chatIds));
    // Refresh panel
    const project = await getProjectConfig(env, slug);
    const panel = buildChatBindingPanel(slug, project?.projectName || slug, chatIds);
    await editMessageWithButtons(env, chatId, msgId, panel.text, panel.buttons);
    await answerCallbackQuery(env, cq.id, `Чат ${unbindChatId} отвязан`);
    return;
  }

  // --- pj:tk:{slug} (tasks for project) ---
  if (parts[1] === "tk" && parts[2]) {
    const slug = parts[2];
    const project = await getProjectConfig(env, slug);
    if (!project) { await answerCallbackQuery(env, cq.id, "Проект не найден"); return; }
    await editMessageWithButtons(env, chatId, msgId, `${CE.LOADING} Загрузка...`, []);
    try {
      const issues = await listLinearIssuesByTeam(env, project.teamId);
      const active = issues.filter((i) => !["completed", "canceled"].includes(i.stateType));
      if (active.length === 0) {
        await editMessageWithButtons(env, chatId, msgId,
          `\u2705 <b>${esc(project.projectName)}</b> — нет открытых задач`,
          [[{ text: "\u2B05\uFE0F Назад", callback_data: `pj:v:${slug}` }]]);
      } else {
        const lines = [`\uD83D\uDCCB <b>${esc(project.projectName)} — Открытые (${active.length}):</b>`, ""];
        active.slice(0, 15).forEach((i) => {
          const st = clientStatus(i.stateType, i.stateName);
          lines.push(`${st} <b>${esc(i.identifier)}</b> ${esc(i.title)}`);
        });
        if (active.length > 15) lines.push(`<i>...и ещё ${active.length - 15}</i>`);
        await editMessageWithButtons(env, chatId, msgId, lines.join("\n"), [
          [{ text: "\uD83D\uDD04 Обновить", callback_data: `pj:tk:${slug}` }, { text: "\u2B05\uFE0F Назад", callback_data: `pj:v:${slug}` }],
        ]);
      }
    } catch (e) {
      await editMessageWithButtons(env, chatId, msgId,
        `\u274C Ошибка: ${esc(e instanceof Error ? e.message : "unknown")}`,
        [[{ text: "\u2B05\uFE0F Назад", callback_data: `pj:v:${slug}` }]]);
    }
    await answerCallbackQuery(env, cq.id);
    return;
  }

  // --- pj:mg:{slug} (managers) ---
  if (parts[1] === "mg" && parts[2]) {
    const slug = parts[2];
    const project = await getProjectConfig(env, slug);
    if (!project) { await answerCallbackQuery(env, cq.id, "Проект не найден"); return; }
    const panel = buildManagersPanel(slug, project.projectName, project.managers);
    await editMessageWithButtons(env, chatId, msgId, panel.text, panel.buttons);
    await env.BUG_REPORTS.put(
      `pending_pm_add:${chatId}:${cq.from.id}`,
      JSON.stringify({ projectSlug: slug, panelChatId: chatId, panelMessageId: msgId } satisfies PendingPmAdd),
      { expirationTtl: 300 },
    );
    await answerCallbackQuery(env, cq.id);
    return;
  }

  // --- pj:ma:{slug} (add PM — redirect to mg which sets pending) ---
  if (parts[1] === "ma" && parts[2]) {
    cq.data = `pj:mg:${parts[2]}`;
    await handleProjectCallback(cq, env);
    return;
  }

  // --- pj:mr:{slug}:{uid} (remove PM) ---
  if (parts[1] === "mr" && parts[2] && parts[3]) {
    const slug = parts[2];
    const removeUid = Number(parts[3]);
    if (!isAdmin(cq.from.id, env)) {
      await answerCallbackQuery(env, cq.id, "Только администратор");
      return;
    }
    const project = await getProjectConfig(env, slug);
    if (!project) { await answerCallbackQuery(env, cq.id, "Проект не найден"); return; }
    project.managers = project.managers.filter((m) => m !== removeUid);
    await saveProjectConfig(env, project);
    const panel = buildManagersPanel(slug, project.projectName, project.managers);
    await editMessageWithButtons(env, chatId, msgId, panel.text, panel.buttons);
    await answerCallbackQuery(env, cq.id, `PM ${removeUid} удалён`);
    return;
  }

  // --- pj:r:{slug} (refresh states + labels) ---
  if (parts[1] === "r" && parts[2]) {
    const slug = parts[2];
    const project = await getProjectConfig(env, slug);
    if (!project) { await answerCallbackQuery(env, cq.id, "Проект не найден"); return; }
    await editMessageWithButtons(env, chatId, msgId, `${CE.LOADING} Обновление...`, []);
    try {
      const [states, labels] = await Promise.all([
        fetchTeamStates(env, project.teamId),
        fetchTeamLabels(env, project.teamId),
      ]);
      project.states = states;
      project.labels = labels;
      await saveProjectConfig(env, project);
      await answerCallbackQuery(env, cq.id, `\u2705 Обновлено: ${labels.length} меток`);
    } catch (e) {
      await answerCallbackQuery(env, cq.id, `\u274C ${e instanceof Error ? e.message : "Ошибка"}`);
    }
    // Show project detail
    cq.data = `pj:v:${slug}`;
    await handleProjectCallback(cq, env);
    return;
  }

  // --- pj:d:{slug} (delete confirm) ---
  if (parts[1] === "d" && parts[2]) {
    if (!isAdmin(cq.from.id, env)) {
      await answerCallbackQuery(env, cq.id, "Только администратор");
      return;
    }
    const slug = parts[2];
    const project = await getProjectConfig(env, slug);
    if (!project) { await answerCallbackQuery(env, cq.id, "Проект не найден"); return; }
    const panel = buildProjectDeleteConfirm(slug, project.projectName);
    await editMessageWithButtons(env, chatId, msgId, panel.text, panel.buttons);
    await answerCallbackQuery(env, cq.id);
    return;
  }

  // --- pj:dy:{slug} (confirm delete) ---
  if (parts[1] === "dy" && parts[2]) {
    if (!isAdmin(cq.from.id, env)) {
      await answerCallbackQuery(env, cq.id, "Только администратор");
      return;
    }
    const slug = parts[2];
    // Remove chat bindings
    const bindListJson = await env.BUG_REPORTS.get(`project_chats:${slug}`);
    const boundChatIds: number[] = bindListJson ? JSON.parse(bindListJson) : [];
    for (const cid of boundChatIds) {
      await env.BUG_REPORTS.delete(`chat_binding:${cid}`);
    }
    await env.BUG_REPORTS.delete(`project_chats:${slug}`);
    // Remove project config and team config
    await env.BUG_REPORTS.delete(`project:${slug}`);
    await env.BUG_REPORTS.delete(`settings:team:${slug}`);
    await env.BUG_REPORTS.delete(`settings:digest:${slug}`);
    // Remove from project list
    let slugs = await getProjectList(env);
    slugs = slugs.filter((s) => s !== slug);
    await env.BUG_REPORTS.put("project_list", JSON.stringify(slugs));

    await answerCallbackQuery(env, cq.id, "Проект отключён");
    // Show project list
    cq.data = "pj:list";
    await handleProjectCallback(cq, env);
    return;
  }

  await answerCallbackQuery(env, cq.id);
}

// ============================================================
// Team callbacks (tm:*)
// ============================================================

async function handleTeamCallback(
  cq: { id: string; from: TelegramUser; message?: TelegramMessage; data?: string },
  env: Env,
): Promise<void> {
  if (!cq.message || !cq.data) return;
  const chatId = cq.message.chat.id;
  const msgId = cq.message.message_id;
  const parts = cq.data.split(":");
  const action = parts[1];
  const slug = parts[2];

  if (!slug) { await answerCallbackQuery(env, cq.id); return; }

  // --- tm:m:{slug} (team main) ---
  if (action === "m") {
    await env.BUG_REPORTS.delete(`pending_team_set:${chatId}:${cq.from.id}`);
    await env.BUG_REPORTS.delete(`pending_team_name:${chatId}:${cq.from.id}`);
    await env.BUG_REPORTS.delete(`pending_pick:${chatId}:${cq.from.id}`);
    const team = await getTeamConfig(env, slug);
    const panel = buildTeamMainPanel(team, slug);
    await editMessageWithButtons(env, chatId, msgId, panel.text, panel.buttons);
    await answerCallbackQuery(env, cq.id);
    return;
  }

  // --- tm:v:{slug}:{roleId} ---
  if (action === "v" && parts[3]) {
    const roleId = parts[3];
    const team = await getTeamConfig(env, slug);
    const panel = buildTeamRolePanel(team, slug, roleId);
    await editMessageWithButtons(env, chatId, msgId, panel.text, panel.buttons);
    await answerCallbackQuery(env, cq.id);
    return;
  }

  // --- tm:a:{slug} (add role) ---
  if (action === "a") {
    const panel = buildAddRolePanel(slug);
    await editMessageWithButtons(env, chatId, msgId, panel.text, panel.buttons);
    await env.BUG_REPORTS.put(
      `pending_team_name:${chatId}:${cq.from.id}`,
      JSON.stringify({ projectSlug: slug, panelChatId: chatId, panelMessageId: msgId } satisfies PendingTeamName),
      { expirationTtl: 300 },
    );
    await answerCallbackQuery(env, cq.id);
    return;
  }

  // --- tm:s:{slug}:{roleId} (set member — show picker) ---
  if (action === "s" && parts[3]) {
    const roleId = parts[3];
    const team = await getTeamConfig(env, slug);
    const role = team[roleId];
    if (!role) { await answerCallbackQuery(env, cq.id); return; }
    await editMessageWithButtons(env, chatId, msgId,
      `<b>${esc(role.name)}</b>\n\nЗагрузка участников...`, []);
    try {
      const users = await listLinearWorkspaceUsers(env);
      // Cache users and set pending pick context
      await env.BUG_REPORTS.put(`team_users:${chatId}`, JSON.stringify(users), { expirationTtl: 120 });
      await env.BUG_REPORTS.put(
        `pending_pick:${chatId}:${cq.from.id}`,
        JSON.stringify({ projectSlug: slug, roleId, panelChatId: chatId, panelMessageId: msgId } satisfies PendingPick),
        { expirationTtl: 120 },
      );
      const panel = buildUserPickPanel(slug, roleId, role.name, users, 0);
      await editMessageWithButtons(env, chatId, msgId, panel.text, panel.buttons);
    } catch (e) {
      console.error("Failed to load Linear users:", e instanceof Error ? e.message : e);
      await editMessageWithButtons(env, chatId, msgId,
        `\u274C Не удалось загрузить участников\n\n<i>${esc(e instanceof Error ? e.message : "Ошибка")}</i>`,
        [[
          { text: "\uD83D\uDD04 Повторить", callback_data: `tm:s:${slug}:${roleId}` },
          { text: "\u2B05\uFE0F Назад", callback_data: `tm:v:${slug}:${roleId}` },
        ]]);
    }
    await answerCallbackQuery(env, cq.id);
    return;
  }

  // --- tm:d:{slug}:{roleId} (delete role confirm) ---
  if (action === "d" && parts[3]) {
    const roleId = parts[3];
    const team = await getTeamConfig(env, slug);
    const role = team[roleId];
    if (!role) { await answerCallbackQuery(env, cq.id); return; }
    await editMessageWithButtons(env, chatId, msgId,
      `Удалить роль <b>${esc(role.name)}</b>?\n\nЭто действие нельзя отменить.`,
      [[
        { text: "Да, удалить", callback_data: `tm:dy:${slug}:${roleId}` },
        { text: "Отмена", callback_data: `tm:v:${slug}:${roleId}` },
      ]]);
    await answerCallbackQuery(env, cq.id);
    return;
  }

  // --- tm:dy:{slug}:{roleId} (confirm delete role) ---
  if (action === "dy" && parts[3]) {
    const roleId = parts[3];
    const team = await getTeamConfig(env, slug);
    const roleName = team[roleId]?.name || roleId;
    delete team[roleId];
    await saveTeamConfig(env, team, slug);
    const panel = buildTeamMainPanel(team, slug);
    await editMessageWithButtons(env, chatId, msgId, panel.text, panel.buttons);
    await answerCallbackQuery(env, cq.id, `${roleName} удалена`);
    return;
  }

  // --- tm:u:{slug}:{roleId} (unassign member) ---
  if (action === "u" && parts[3]) {
    const roleId = parts[3];
    const team = await getTeamConfig(env, slug);
    if (team[roleId] && team[roleId].member) {
      const memberName = team[roleId].member!.name;
      delete team[roleId].member;
      await saveTeamConfig(env, team, slug);
      const panel = buildTeamRolePanel(team, slug, roleId);
      await editMessageWithButtons(env, chatId, msgId, panel.text, panel.buttons);
      await answerCallbackQuery(env, cq.id, `\u274C ${memberName} снят`);
    } else {
      await answerCallbackQuery(env, cq.id);
    }
    return;
  }

  await answerCallbackQuery(env, cq.id);
}

// ============================================================
// User pick callbacks (tp:{index}, tg:{page})
// ============================================================

async function handleUserPickCallback(
  cq: { id: string; from: TelegramUser; message?: TelegramMessage; data?: string },
  env: Env,
): Promise<void> {
  if (!cq.message || !cq.data) return;
  const chatId = cq.message.chat.id;
  const msgId = cq.message.message_id;

  const pickJson = await env.BUG_REPORTS.get(`pending_pick:${chatId}:${cq.from.id}`);
  if (!pickJson) {
    await answerCallbackQuery(env, cq.id, "Сессия истекла. Начните заново.");
    return;
  }
  const pick = JSON.parse(pickJson) as PendingPick;

  const usersJson = await env.BUG_REPORTS.get(`team_users:${chatId}`);
  const users: LinearWorkspaceUser[] = usersJson ? JSON.parse(usersJson) : [];

  // tp:{userId} — select user by ID
  if (cq.data.startsWith("tp:")) {
    const userId = cq.data.split(":")[1];
    const user = users.find((u) => u.id === userId);
    if (!user) {
      await answerCallbackQuery(env, cq.id, "Пользователь не найден");
      return;
    }
    const team = await getTeamConfig(env, pick.projectSlug);
    if (!team[pick.roleId]) {
      await answerCallbackQuery(env, cq.id, "Роль не найдена");
      return;
    }
    team[pick.roleId].member = { userId: user.id, name: user.name, email: user.email || "" };
    await saveTeamConfig(env, team, pick.projectSlug);
    await env.BUG_REPORTS.delete(`pending_pick:${chatId}:${cq.from.id}`);
    const panel = buildTeamMainPanel(team, pick.projectSlug);
    await editMessageWithButtons(env, chatId, msgId, panel.text, panel.buttons);
    await answerCallbackQuery(env, cq.id, `\u2705 ${user.name}`);
    return;
  }

  // tg:{page} — pagination
  if (cq.data.startsWith("tg:")) {
    const page = parseInt(cq.data.split(":")[1], 10) || 0;
    const team = await getTeamConfig(env, pick.projectSlug);
    const role = team[pick.roleId];
    if (!role) { await answerCallbackQuery(env, cq.id); return; }
    const panel = buildUserPickPanel(pick.projectSlug, pick.roleId, role.name, users, page);
    await editMessageWithButtons(env, chatId, msgId, panel.text, panel.buttons);
    await answerCallbackQuery(env, cq.id);
    return;
  }

  await answerCallbackQuery(env, cq.id);
}

// ============================================================
// Digest callbacks (dg:*)
// ============================================================

async function handleDigestCallback(
  cq: { id: string; from: TelegramUser; message?: TelegramMessage; data?: string },
  env: Env,
): Promise<void> {
  if (!cq.message || !cq.data) return;
  const chatId = cq.message.chat.id;
  const msgId = cq.message.message_id;
  const parts = cq.data.split(":");
  const action = parts[1];
  const slug = parts[2];

  if (!slug) { await answerCallbackQuery(env, cq.id); return; }

  const project = await getProjectConfig(env, slug);
  if (!project) { await answerCallbackQuery(env, cq.id, "Проект не найден"); return; }

  if (action === "p") {
    const panel = await buildDigestPanel(env, slug, project.projectName);
    await editMessageWithButtons(env, chatId, msgId, panel.text, panel.buttons);
    await answerCallbackQuery(env, cq.id);
    return;
  }

  if (action === "n") {
    await env.BUG_REPORTS.put(`settings:digest:${slug}`, "true");
    const panel = await buildDigestPanel(env, slug, project.projectName);
    await editMessageWithButtons(env, chatId, msgId, panel.text, panel.buttons);
    await answerCallbackQuery(env, cq.id, "\u2705 Дайджест включён");
    return;
  }

  if (action === "o") {
    await env.BUG_REPORTS.put(`settings:digest:${slug}`, "false");
    const panel = await buildDigestPanel(env, slug, project.projectName);
    await editMessageWithButtons(env, chatId, msgId, panel.text, panel.buttons);
    await answerCallbackQuery(env, cq.id, "\u23F8\uFE0F Дайджест приостановлен");
    return;
  }

  if (action === "t") {
    await answerCallbackQuery(env, cq.id, "\uD83D\uDCE8 Генерирую...");
    await editMessageWithButtons(env, chatId, msgId, `${CE.LOADING} <b>Генерирую отчёт...</b>`, []);
    try {
      await sendWeeklyDigest(env, slug);
      const panel = await buildDigestPanel(env, slug, project.projectName);
      await editMessageWithButtons(env, chatId, msgId, panel.text, panel.buttons);
    } catch (e) {
      const panel = await buildDigestPanel(env, slug, project.projectName);
      await editMessageWithButtons(env, chatId, msgId,
        `${panel.text}\n\n\u274C <i>Ошибка: ${esc(e instanceof Error ? e.message : "unknown")}</i>`,
        panel.buttons);
    }
    return;
  }

  await answerCallbackQuery(env, cq.id);
}

// ============================================================
// Text input handlers (called from index.ts)
// ============================================================

export async function handleTeamNameInput(
  message: TelegramMessage, pending: PendingTeamName, kvKey: string, env: Env,
): Promise<void> {
  await env.BUG_REPORTS.delete(kvKey);
  const name = (message.text || "").trim();

  if (!name) {
    const team = await getTeamConfig(env, pending.projectSlug);
    const panel = buildTeamMainPanel(team, pending.projectSlug);
    await editMessageWithButtons(env, pending.panelChatId, pending.panelMessageId, panel.text, panel.buttons);
    return;
  }

  const id = roleSlug(name);
  const team = await getTeamConfig(env, pending.projectSlug);
  if (team[id]) {
    const panel = buildTeamMainPanel(team, pending.projectSlug);
    await editMessageWithButtons(env, pending.panelChatId, pending.panelMessageId, panel.text, panel.buttons);
    await sendMessage(env, message.chat.id, `Роль "${esc(name)}" уже существует`);
    return;
  }

  team[id] = { name };
  await saveTeamConfig(env, team, pending.projectSlug);
  const panel = buildTeamRolePanel(team, pending.projectSlug, id);
  await editMessageWithButtons(env, pending.panelChatId, pending.panelMessageId, panel.text, panel.buttons);
}

export async function handleChatBindInput(
  message: TelegramMessage, pending: PendingChatBind, kvKey: string, env: Env,
): Promise<void> {
  await env.BUG_REPORTS.delete(kvKey);
  const input = (message.text || "").trim();
  const targetChatId = Number(input);

  if (!input || isNaN(targetChatId)) {
    await sendMessage(env, message.chat.id, "Некорректный Chat ID. Отправьте числовой ID чата.");
    return;
  }

  // Validate chat exists and bot has access
  try {
    const checkRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getChat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: targetChatId }),
    });
    if (!checkRes.ok) {
      await sendMessage(env, message.chat.id, `\u274C Чат ${targetChatId} не найден или бот не добавлен в этот чат.`);
      return;
    }
  } catch {
    await sendMessage(env, message.chat.id, `\u274C Не удалось проверить чат ${targetChatId}. Попробуйте позже.`);
    return;
  }

  // Create chat binding
  const binding: ChatBinding = { projectSlug: pending.projectSlug, projectName: "" };
  const project = await getProjectConfig(env, pending.projectSlug);
  if (project) binding.projectName = project.projectName;
  await env.BUG_REPORTS.put(`chat_binding:${targetChatId}`, JSON.stringify(binding));

  // Update project_chats list
  const bindListJson = await env.BUG_REPORTS.get(`project_chats:${pending.projectSlug}`);
  const chatIds: number[] = bindListJson ? JSON.parse(bindListJson) : [];
  if (!chatIds.includes(targetChatId)) {
    chatIds.push(targetChatId);
    await env.BUG_REPORTS.put(`project_chats:${pending.projectSlug}`, JSON.stringify(chatIds));
  }

  // Refresh panel
  const panel = buildChatBindingPanel(pending.projectSlug, project?.projectName || pending.projectSlug, chatIds);
  await editMessageWithButtons(env, pending.panelChatId, pending.panelMessageId, panel.text, panel.buttons);
  await sendMessage(env, message.chat.id, `\u2705 Чат ${targetChatId} привязан к ${esc(project?.projectName || pending.projectSlug)}`);
}

export async function handlePmAddInput(
  message: TelegramMessage, pending: PendingPmAdd, kvKey: string, env: Env,
): Promise<void> {
  await env.BUG_REPORTS.delete(kvKey);
  const input = (message.text || "").trim();
  const uid = Number(input);

  if (!input || isNaN(uid)) {
    await sendMessage(env, message.chat.id, "Некорректный User ID. Отправьте числовой Telegram ID.");
    return;
  }

  const project = await getProjectConfig(env, pending.projectSlug);
  if (!project) {
    await sendMessage(env, message.chat.id, "Проект не найден");
    return;
  }

  if (!project.managers.includes(uid)) {
    project.managers.push(uid);
    await saveProjectConfig(env, project);
  }

  const panel = buildManagersPanel(pending.projectSlug, project.projectName, project.managers);
  await editMessageWithButtons(env, pending.panelChatId, pending.panelMessageId, panel.text, panel.buttons);
  await sendMessage(env, message.chat.id, `\u2705 PM ${uid} добавлен`);
}

export async function handleRejectionComment(
  message: TelegramMessage,
  pending: PendingReject,
  kvKey: string,
  env: Env,
): Promise<void> {
  await env.BUG_REPORTS.delete(kvKey);
  const reason = message.text || "Без комментария";

  // Load dynamic state
  const mappingJson = await env.BUG_REPORTS.get(`issue:${pending.linearIssueId}`);
  let inProgressState: string | undefined;
  if (mappingJson) {
    const mapping = JSON.parse(mappingJson) as IssueMapping;
    const pSlug = mapping.projectSlug || "valwin";
    const project = await getProjectConfig(env, pSlug);
    inProgressState = project?.states.inProgress;
  }

  if (!inProgressState) {
    // Fallback — log error but don't block
    console.error("Could not resolve inProgress state for rejection");
    await sendMessage(env, message.chat.id, "\u274C Не удалось вернуть задачу в работу (состояние не найдено)");
    return;
  }

  await addLinearComment(env, pending.linearIssueId,
    `\u274C Отклонено клиентом: ${reason}`);
  await updateLinearIssueState(env, pending.linearIssueId, inProgressState);

  await editMessageText(env, pending.botMessageChatId, pending.botMessageId,
    `\u274C <b>Задача ${esc(pending.issueId)} отклонена</b>\nПричина: ${esc(reason)}\nВозвращена в работу.`);
}
