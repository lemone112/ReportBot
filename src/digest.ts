import type { Env } from "./types";
import { sendMessage } from "./telegram";
import { listLinearIssuesByTeam } from "./composio";
import { CE, esc } from "./utils";

export async function sendWeeklyDigest(env: Env): Promise<void> {
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
      if (inProgress.length > 10) lines.push(`<i>...и ещё ${inProgress.length - 10}</i>`);
      lines.push("");
    }

    if (planned.length > 0) {
      lines.push(`${CE.INBOX} <b>Запланировано:</b>`);
      planned.slice(0, 8).forEach((i) => lines.push(`\u2022 ${esc(i.title)}`));
      if (planned.length > 8) lines.push(`<i>...и ещё ${planned.length - 8}</i>`);
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
    throw e;
  }
}
