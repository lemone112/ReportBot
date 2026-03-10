import type { Env, TelegramUser, TeamConfig, LinearWorkspaceUser } from "./types";

// Custom emoji constants for Telegram
export const CE = {
  LOADING: '<tg-emoji emoji-id="5350438526691326210">\u23F3</tg-emoji>',
  SUCCESS: '<tg-emoji emoji-id="5348079125061975628">\u2705</tg-emoji>',
  INBOX: '<tg-emoji emoji-id="5348235470461483629">\uD83D\uDCCB</tg-emoji>',
  PROGRESS: '<tg-emoji emoji-id="5361734213370396027">\uD83D\uDD27</tg-emoji>',
  DONE: '<tg-emoji emoji-id="5348445120700102867">\u2705</tg-emoji>',
  ERROR: '<tg-emoji emoji-id="5361800897032634764">\u274C</tg-emoji>',
  REPORT: '<tg-emoji emoji-id="5361740436778009413">\uD83D\uDCCB</tg-emoji>',
  SIMILAR: '<tg-emoji emoji-id="5350654889963828012">\u26A0\uFE0F</tg-emoji>',
};

export type Btn = { text: string; callback_data: string };
export type Panel = { text: string; buttons: Btn[][] };

export function esc(text: string): string {
  if (!text || typeof text !== "string") return "";
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function priorityLabel(priority: number): string {
  switch (priority) {
    case 1: return "Срочный";
    case 2: return "Высокий";
    case 3: return "Средний";
    case 4: return "Низкий";
    default: return "Нет";
  }
}

export function clientStatus(stateType: string, stateName: string): string {
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

export function isChatAllowed(chatId: number, env: Env): boolean {
  return env.ALLOWED_CHATS.split(",").map((id) => id.trim()).includes(String(chatId));
}

export function isAdmin(userId: number | undefined, env: Env): boolean {
  if (!userId) return false;
  return env.ADMIN_USERS.split(",").map((id) => id.trim()).includes(String(userId));
}

export function userName(user?: TelegramUser): string {
  if (!user) return "Неизвестный";
  return [user.first_name, user.last_name].filter(Boolean).join(" ");
}

export async function getTeamConfig(env: Env): Promise<TeamConfig> {
  const json = await env.BUG_REPORTS.get("settings:team");
  if (!json) return {};
  return JSON.parse(json) as TeamConfig;
}

const MANAGER_PATTERNS = /менеджер|manager|лид|lead|руководитель|директор|director|продюсер|producer|\bpm\b|\bcto\b|\bceo\b/i;

export function resolveAssignment(
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

export async function trackMetric(env: Env, metric: string): Promise<void> {
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

export async function getMetrics(env: Env, days: number): Promise<Record<string, number>> {
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
