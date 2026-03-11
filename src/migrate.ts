import type { Env, ProjectConfig, ChatBinding } from "./types";
import { getProjectList } from "./utils";

// Legacy constants from the original single-project setup
const LEGACY_LABEL_MAP: Record<string, string> = {
  "Баг": "228cc551-1687-461d-bfae-3f3d33b44e8b",
  "Фича": "b48c7352-db94-449c-81a0-f5838b510f11",
  "Доработка": "3190f1b6-b186-4d7e-8331-180252dcaed9",
  "Фронтенд": "8ce7b555-e196-41a0-bae4-ae264ce81e5d",
  "Бэкенд": "28969d43-1ff2-4ce3-998d-0b43233ef22a",
  "API": "cc9f5c78-5f93-4250-af7e-fdd34fddbfc2",
  "База данных": "d631411e-64be-4039-9c19-b52623017c09",
  "Мобильное": "e1a0af46-c9ee-4a03-a347-a81baa3fca16",
  "Десктоп": "a4ccc965-3be0-4e40-a83b-fdef8012398f",
  "Инфра": "176d1568-b2e7-42c1-9fcc-d2d92db05a15",
  "UI/UX": "c64a6965-affa-4934-9047-014bdd2fd25a",
  "2D графика": "e69f9505-dd1f-4098-b753-6fa5cb9f19b2",
  "3D графика": "dec42dfb-2825-4361-bcbe-aeb3ccb412fc",
  "Анимация": "1ba35f7e-6a19-4352-b4bb-3cbb844fb324",
  "Брендинг": "377025f7-4f0c-4550-a48f-dd14250f5aaf",
  "Звук": "6cbc27ab-5e12-4387-ae33-9969c820afb9",
  "Видео": "7af11e67-d192-43dd-888f-9d9f908e2681",
  "Продукт": "23f91920-6df2-45af-a400-01ccae142570",
  "Контент": "53fae6f1-ea42-409f-8e6f-4f4479bab732",
  "Маркетинг": "bbcddac8-dcfb-4812-98e1-9f0498f5682e",
  "Аналитика": "ea1450be-37f2-44b5-8827-af8bb4756bc3",
  "SEO": "11f77cc6-6b09-4b7c-9f3e-af31e87283a0",
  "Авторизация": "4c89981c-f1d7-42c3-87c3-965542537f73",
  "Безопасность": "9f6b71e9-2b73-4ee0-bb2c-6623d4d0eaf3",
  "Производительность": "d3b2a01a-40a8-41d6-9265-a590cf3ff69c",
  "Краш": "c190d3c2-639f-42e7-8659-1b0ba31d6dab",
  "Тестирование": "43f69e40-0890-4c58-9fab-c961a38236fa",
  "Платежи": "09940e02-5026-444c-97b6-fb7c32e37b4d",
  "Уведомления": "38d12e51-421a-4c81-8159-7781983ca0fd",
  "Поддержка": "ddcda9fb-cf27-471d-99a9-4f74503aad10",
  "Модерация": "ab0b259f-888e-44f8-8d9b-c0a5b3c479bc",
};

export async function migrateToMultiProject(env: Env): Promise<void> {
  const existing = await getProjectList(env);
  if (existing.length > 0) return; // Already migrated

  if (!env.LINEAR_TEAM_ID) {
    console.log("No LINEAR_TEAM_ID, skipping migration — fresh install");
    return;
  }

  console.log("Migrating to multi-project architecture...");

  const slug = "valwin";
  const project: ProjectConfig = {
    slug,
    projectId: "ce35acff-30e6-4208-9120-787e23b557b6",
    projectName: "Valwin",
    teamId: env.LINEAR_TEAM_ID,
    teamKey: "VAL",
    states: {
      triage: "db39f925-3f47-47cd-804a-36649b2f047a",
      inProgress: "5c2e2165-d492-4963-b3f2-1eda3a2e7135",
      review: "3532014a-1092-408c-9aeb-94dc38871d7d",
      done: "a36c8892-9daa-4127-8e36-7553e2afff8a",
      canceled: "",
    },
    labels: Object.entries(LEGACY_LABEL_MAP).map(([name, id]) => ({ id, name })),
    managers: env.ADMIN_USERS.split(",").map((id) => Number(id.trim())).filter(Boolean),
    createdAt: new Date().toISOString(),
  };

  // Migrate team config
  const oldTeamJson = await env.BUG_REPORTS.get("settings:team");
  if (oldTeamJson) {
    await env.BUG_REPORTS.put(`settings:team:${slug}`, oldTeamJson);
  }

  // Migrate digest setting
  const oldDigest = await env.BUG_REPORTS.get("settings:digest_enabled");
  if (oldDigest) {
    await env.BUG_REPORTS.put(`settings:digest:${slug}`, oldDigest);
  }

  // Store project
  await env.BUG_REPORTS.put(`project:${slug}`, JSON.stringify(project));
  await env.BUG_REPORTS.put("project_list", JSON.stringify([slug]));

  // Create chat bindings
  const chatIds = env.ALLOWED_CHATS.split(",").map((id) => Number(id.trim())).filter(Boolean);
  const boundChatIds: number[] = [];
  for (const chatId of chatIds) {
    const binding: ChatBinding = { projectSlug: slug, projectName: project.projectName };
    await env.BUG_REPORTS.put(`chat_binding:${chatId}`, JSON.stringify(binding));
    boundChatIds.push(chatId);
  }
  await env.BUG_REPORTS.put(`project_chats:${slug}`, JSON.stringify(boundChatIds));

  console.log("Migration complete: created project 'valwin' with", chatIds.length, "chat bindings");
}
