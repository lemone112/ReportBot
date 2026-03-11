import type { Env, TeamConfig, ProjectConfig, LinearWorkspaceUser } from "./types";
import { CE, esc, type Btn, type Panel } from "./utils";

export function roleSlug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9а-яё-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

// ============================================================
// Main panel
// ============================================================

export function buildMainPanel(showAdmin: boolean): Panel {
  const lines = [
    "\uD83E\uDD16 <b>Bug Reporter Bot</b>",
    "",
    "Управление проектами и задачами",
  ];
  const buttons: Btn[][] = [];
  if (showAdmin) {
    buttons.push([{ text: "\uD83D\uDCC1 Проекты", callback_data: "pj:list" }]);
    buttons.push([{ text: "\uD83D\uDCC8 Статистика", callback_data: "mn:stats" }]);
  }
  return { text: lines.join("\n"), buttons };
}

// ============================================================
// Project management panels
// ============================================================

export function buildProjectListPanel(projects: ProjectConfig[]): Panel {
  const lines = ["\uD83D\uDCC1 <b>Проекты</b>", ""];

  if (projects.length === 0) {
    lines.push("<i>Нет подключённых проектов</i>");
  } else {
    for (const p of projects) {
      lines.push(`\u2705 <b>${esc(p.projectName)}</b> (${esc(p.teamKey)})`);
    }
  }

  const buttons: Btn[][] = [];
  const projBtns = projects.map((p) => ({
    text: `${p.projectName}`,
    callback_data: `pj:v:${p.slug}`,
  }));
  for (let i = 0; i < projBtns.length; i += 2) {
    buttons.push(projBtns.slice(i, i + 2));
  }
  buttons.push([{ text: "\u2795 Подключить проект", callback_data: "pj:conn" }]);
  buttons.push([{ text: "\u2B05\uFE0F Главная", callback_data: "mn:home" }]);
  return { text: lines.join("\n"), buttons };
}

export function buildProjectDetailPanel(project: ProjectConfig, chatCount: number, roleCount: number, assignedCount: number): Panel {
  const digestKey = `settings:digest:${project.slug}`;
  const lines = [
    `\uD83D\uDCC1 <b>${esc(project.projectName)}</b> (${esc(project.teamKey)})`,
    "",
    `\uD83D\uDD17 Чаты: <b>${chatCount}</b>`,
    `\uD83D\uDC65 Роли: <b>${roleCount}</b> (назначено: ${assignedCount})`,
    `\uD83D\uDCCA Метки: <b>${project.labels.length}</b>`,
  ];
  const buttons: Btn[][] = [
    [
      { text: "\uD83D\uDD17 Чаты", callback_data: `pj:c:${project.slug}` },
      { text: "\uD83D\uDC65 Команда", callback_data: `tm:m:${project.slug}` },
    ],
    [
      { text: "\uD83D\uDCCA Дайджест", callback_data: `dg:p:${project.slug}` },
      { text: "\uD83D\uDCCB Задачи", callback_data: `pj:tk:${project.slug}` },
    ],
    [
      { text: "\uD83D\uDC64 Менеджеры", callback_data: `pj:mg:${project.slug}` },
      { text: "\uD83D\uDD04 Обновить метки", callback_data: `pj:r:${project.slug}` },
    ],
    [{ text: "\uD83D\uDDD1 Отключить проект", callback_data: `pj:d:${project.slug}` }],
    [{ text: "\u2B05\uFE0F К проектам", callback_data: "pj:list" }],
  ];
  return { text: lines.join("\n"), buttons };
}

export function buildProjectConnectTeamPanel(teams: { id: string; name: string; key: string }[]): Panel {
  const lines = [
    "\uD83D\uDCC1 <b>Подключение проекта</b>",
    "",
    "Шаг 1/3: Выберите команду Linear:",
  ];
  const buttons: Btn[][] = [];
  for (const t of teams) {
    buttons.push([{ text: `${t.name} (${t.key})`, callback_data: `pc:t:${t.id}` }]);
  }
  buttons.push([{ text: "\u2B05\uFE0F Назад", callback_data: "pj:list" }]);
  return { text: lines.join("\n"), buttons };
}

export function buildProjectConnectProjectPanel(
  teamName: string,
  projects: { id: string; name: string }[],
  teamIdx: number,
): Panel {
  const lines = [
    "\uD83D\uDCC1 <b>Подключение проекта</b>",
    "",
    `Шаг 2/3: Проекты в <b>${esc(teamName)}</b>:`,
  ];
  const buttons: Btn[][] = [];
  if (projects.length === 0) {
    lines.push("", "<i>Нет проектов в этой команде</i>");
  } else {
    for (let i = 0; i < projects.length; i++) {
      buttons.push([{ text: projects[i].name, callback_data: `pc:p:${teamIdx}:${i}` }]);
    }
  }
  buttons.push([{ text: "\u2B05\uFE0F Назад", callback_data: "pj:conn" }]);
  return { text: lines.join("\n"), buttons };
}

export function buildProjectConnectedPanel(project: ProjectConfig): Panel {
  const lines = [
    `\u2705 <b>Проект подключён!</b>`,
    "",
    `Проект: <b>${esc(project.projectName)}</b> (${esc(project.teamKey)})`,
    `Состояния: <b>загружены</b>`,
    `Метки: <b>${project.labels.length}</b>`,
    "",
    "Теперь привяжите Telegram-чат к проекту.",
  ];
  const buttons: Btn[][] = [
    [{ text: "\uD83D\uDD17 Привязать чат", callback_data: `pj:c:${project.slug}` }],
    [{ text: "\uD83D\uDC65 Команда", callback_data: `tm:m:${project.slug}` }],
    [{ text: "\u2B05\uFE0F К проектам", callback_data: "pj:list" }],
  ];
  return { text: lines.join("\n"), buttons };
}

export function buildChatBindingPanel(slug: string, projectName: string, chatIds: number[]): Panel {
  const lines = [
    `\uD83D\uDD17 <b>Чаты — ${esc(projectName)}</b>`,
    "",
  ];
  if (chatIds.length === 0) {
    lines.push("<i>Нет привязанных чатов</i>");
  } else {
    lines.push("Привязанные:");
    for (const cid of chatIds) {
      lines.push(`\u2022 <code>${cid}</code>`);
    }
  }
  lines.push("", "Отправьте Chat ID для привязки нового чата.");
  lines.push("<i>(Используйте /chatid в группе для получения ID)</i>");

  const buttons: Btn[][] = [];
  // Unbind buttons for each chat
  for (const cid of chatIds) {
    buttons.push([{ text: `\u274C Отвязать ${cid}`, callback_data: `pj:cu:${slug}:${cid}` }]);
  }
  buttons.push([{ text: "\u2B05\uFE0F Назад", callback_data: `pj:v:${slug}` }]);
  return { text: lines.join("\n"), buttons };
}

export function buildManagersPanel(slug: string, projectName: string, managers: number[]): Panel {
  const lines = [
    `\uD83D\uDC64 <b>Менеджеры — ${esc(projectName)}</b>`,
    "",
  ];
  if (managers.length === 0) {
    lines.push("<i>Нет назначенных PM</i>");
  } else {
    for (const uid of managers) {
      lines.push(`\u2022 <code>${uid}</code>`);
    }
  }
  lines.push("", "Отправьте Telegram User ID нового менеджера:");

  const buttons: Btn[][] = [];
  for (const uid of managers) {
    buttons.push([{ text: `\u274C Убрать ${uid}`, callback_data: `pj:mr:${slug}:${uid}` }]);
  }
  buttons.push([{ text: "\u2B05\uFE0F Назад", callback_data: `pj:v:${slug}` }]);
  return { text: lines.join("\n"), buttons };
}

export function buildProjectDeleteConfirm(slug: string, projectName: string): Panel {
  return {
    text: `\u26A0\uFE0F Отключить проект <b>${esc(projectName)}</b>?\n\nВсе привязки чатов и настройки команды будут удалены. Это действие нельзя отменить.`,
    buttons: [
      [
        { text: "\u2705 Да, отключить", callback_data: `pj:dy:${slug}` },
        { text: "\u274C Отмена", callback_data: `pj:v:${slug}` },
      ],
    ],
  };
}

export function buildProjectSelectPanel(projects: ProjectConfig[], action: string): Panel {
  const labels: Record<string, string> = {
    "mn:rep": "\uD83D\uDCDD Выберите проект для репорта:",
    "mn:tsk": "\uD83D\uDCCB Выберите проект:",
  };
  const lines = [labels[action] || "Выберите проект:"];
  const buttons: Btn[][] = [];
  for (const p of projects) {
    buttons.push([{ text: `${p.projectName} (${p.teamKey})`, callback_data: `${action}:${p.slug}` }]);
  }
  buttons.push([{ text: "\u2B05\uFE0F Назад", callback_data: "mn:home" }]);
  return { text: lines.join("\n"), buttons };
}

// ============================================================
// Team panels (per-project)
// ============================================================

export function buildTeamMainPanel(team: TeamConfig, slug: string): Panel {
  const roles = Object.entries(team);
  const lines = ["\u2699\uFE0F <b>Управление командой</b>", ""];

  if (roles.length === 0) {
    lines.push("<i>Нет ролей. Добавьте первую!</i>");
  } else {
    for (const [, role] of roles) {
      lines.push(role.member
        ? `<b>${esc(role.name)}</b> — \u2705 ${esc(role.member.name)}`
        : `<b>${esc(role.name)}</b> — <i>не назначен</i>`);
    }
  }

  const buttons: Btn[][] = [];
  const roleBtns = roles.map(([id, role]) => ({
    text: role.member ? `\u2705 ${role.name}` : role.name,
    callback_data: `tm:v:${slug}:${id}`,
  }));
  for (let i = 0; i < roleBtns.length; i += 3) {
    buttons.push(roleBtns.slice(i, i + 3));
  }
  buttons.push([{ text: "\u2795 Добавить роль", callback_data: `tm:a:${slug}` }]);
  buttons.push([{ text: "\u2B05\uFE0F Назад", callback_data: `pj:v:${slug}` }]);
  return { text: lines.join("\n"), buttons };
}

export function buildTeamRolePanel(team: TeamConfig, slug: string, roleId: string): Panel {
  const role = team[roleId];
  if (!role) return buildTeamMainPanel(team, slug);

  const lines = [`<b>${esc(role.name)}</b>`, ""];
  if (role.member) {
    lines.push(`\u2705 ${esc(role.member.name)}`);
    lines.push(`\uD83D\uDCE7 ${esc(role.member.email)}`);
  } else {
    lines.push("<i>Участник не назначен</i>");
  }

  const actions: Btn[] = [
    { text: role.member ? "\u270F\uFE0F Сменить" : "\uD83D\uDC64 Назначить", callback_data: `tm:s:${slug}:${roleId}` },
  ];
  if (role.member) {
    actions.push({ text: "\u274C Снять", callback_data: `tm:u:${slug}:${roleId}` });
  }
  const row2: Btn[] = [
    { text: "\uD83D\uDDD1 Удалить роль", callback_data: `tm:d:${slug}:${roleId}` },
  ];
  return {
    text: lines.join("\n"),
    buttons: [actions, row2, [{ text: "\u2B05\uFE0F Назад", callback_data: `tm:m:${slug}` }]],
  };
}

export function buildUserPickPanel(
  slug: string, roleId: string, roleName: string,
  users: LinearWorkspaceUser[], page: number,
): Panel {
  const PAGE_SIZE = 6;
  const start = page * PAGE_SIZE;
  const pageUsers = users.slice(start, start + PAGE_SIZE);
  const totalPages = Math.ceil(users.length / PAGE_SIZE);

  const lines = [`<b>${esc(roleName)}</b>`, "", "Выберите участника:"];
  const buttons: Btn[][] = [];

  for (let i = 0; i < pageUsers.length; i++) {
    const u = pageUsers[i];
    const globalIdx = start + i;
    buttons.push([{
      text: u.name + (u.email ? ` (${u.email.split("@")[0]})` : ""),
      callback_data: `tp:${globalIdx}`,
    }]);
  }

  if (totalPages > 1) {
    const navRow: Btn[] = [];
    if (page > 0) navRow.push({ text: "\u25C0\uFE0F", callback_data: `tg:${page - 1}` });
    navRow.push({ text: `${page + 1}/${totalPages}`, callback_data: "noop" });
    if (page < totalPages - 1) navRow.push({ text: "\u25B6\uFE0F", callback_data: `tg:${page + 1}` });
    buttons.push(navRow);
  }
  buttons.push([{ text: "\u2B05\uFE0F Назад", callback_data: `tm:v:${slug}:${roleId}` }]);
  return { text: lines.join("\n"), buttons };
}

export function buildAddRolePanel(slug: string): Panel {
  return {
    text: "\u2795 <b>Новая роль</b>\n\nОтправьте название роли:",
    buttons: [[{ text: "\u2B05\uFE0F Отмена", callback_data: `tm:m:${slug}` }]],
  };
}

// ============================================================
// Digest panel (per-project)
// ============================================================

export async function buildDigestPanel(env: Env, slug: string, projectName: string): Promise<Panel> {
  const enabled = await env.BUG_REPORTS.get(`settings:digest:${slug}`);
  const isOn = enabled !== "false";
  const statusEmoji = isOn ? "\u2705" : "\u23F8\uFE0F";
  const statusText = isOn ? "включён" : "приостановлен";
  const lines = [
    `${CE.REPORT} <b>Дайджест — ${esc(projectName)}</b>`,
    "",
    `${statusEmoji} Статус: <b>${statusText}</b>`,
    "\uD83D\uDCC5 Отправка: пятница, 18:00 МСК",
  ];
  const toggleBtn: Btn = isOn
    ? { text: "\u23F8\uFE0F Приостановить", callback_data: `dg:o:${slug}` }
    : { text: "\u25B6\uFE0F Включить", callback_data: `dg:n:${slug}` };
  const buttons: Btn[][] = [
    [toggleBtn],
    [{ text: "\uD83D\uDCE8 Отправить сейчас", callback_data: `dg:t:${slug}` }],
    [{ text: "\u2B05\uFE0F Назад", callback_data: `pj:v:${slug}` }],
  ];
  return { text: lines.join("\n"), buttons };
}
