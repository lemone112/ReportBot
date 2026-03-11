import type { Env, TeamConfig, LinearWorkspaceUser } from "./types";
import { CE, esc, isAdmin, getTeamConfig, type Btn, type Panel } from "./utils";
import { getBotUsername } from "./telegram";

export function roleSlug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9а-яё-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

export async function buildMainPanel(env: Env, showAdmin: boolean): Promise<Panel> {
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

export async function buildDigestPanel(env: Env): Promise<Panel> {
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

export function buildTeamMainPanel(team: TeamConfig): Panel {
  const roles = Object.entries(team);
  const lines = ["\u2699\uFE0F <b>Управление командой</b>", ""];

  if (roles.length === 0) {
    lines.push("<i>Нет ролей. Добавьте первую!</i>");
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

export function buildTeamRolePanel(team: TeamConfig, roleId: string): Panel {
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

export function buildTeamSetPanel(roleId: string, roleName: string): Panel {
  return {
    text: `<b>${esc(roleName)}</b>\n\nОтправьте email участника Linear:`,
    buttons: [[{ text: "\u2B05\uFE0F Отмена", callback_data: `team:view:${roleId}` }]],
  };
}

export function buildUserPickPanel(roleId: string, roleName: string, users: LinearWorkspaceUser[], page: number): Panel {
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

export function buildAddRolePanel(): Panel {
  return {
    text: "\u2795 <b>Новая роль</b>\n\nОтправьте название роли:",
    buttons: [[{ text: "\u2B05\uFE0F Отмена", callback_data: "team:main" }]],
  };
}
