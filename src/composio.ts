import type { Env, BugReport, LinearIssueListItem, LinearWorkspaceUser, ProjectConfig, ProjectStates, ProjectLabel } from "./types";

const LINEAR_GQL_API = "https://api.linear.app/graphql";

const LABEL_MAP: Record<string, string> = {
  // Тип
  "Баг": "228cc551-1687-461d-bfae-3f3d33b44e8b",
  "Фича": "b48c7352-db94-449c-81a0-f5838b510f11",
  "Доработка": "3190f1b6-b186-4d7e-8331-180252dcaed9",
  // Разработка
  "Фронтенд": "8ce7b555-e196-41a0-bae4-ae264ce81e5d",
  "Бэкенд": "28969d43-1ff2-4ce3-998d-0b43233ef22a",
  "API": "cc9f5c78-5f93-4250-af7e-fdd34fddbfc2",
  "База данных": "d631411e-64be-4039-9c19-b52623017c09",
  "Мобильное": "e1a0af46-c9ee-4a03-a347-a81baa3fca16",
  "Десктоп": "a4ccc965-3be0-4e40-a83b-fdef8012398f",
  "Инфра": "176d1568-b2e7-42c1-9fcc-d2d92db05a15",
  // Дизайн и креатив
  "UI/UX": "c64a6965-affa-4934-9047-014bdd2fd25a",
  "2D графика": "e69f9505-dd1f-4098-b753-6fa5cb9f19b2",
  "3D графика": "dec42dfb-2825-4361-bcbe-aeb3ccb412fc",
  "Анимация": "1ba35f7e-6a19-4352-b4bb-3cbb844fb324",
  "Брендинг": "377025f7-4f0c-4550-a48f-dd14250f5aaf",
  "Звук": "6cbc27ab-5e12-4387-ae33-9969c820afb9",
  "Видео": "7af11e67-d192-43dd-888f-9d9f908e2681",
  // Продукт и бизнес
  "Продукт": "23f91920-6df2-45af-a400-01ccae142570",
  "Контент": "53fae6f1-ea42-409f-8e6f-4f4479bab732",
  "Маркетинг": "bbcddac8-dcfb-4812-98e1-9f0498f5682e",
  "Аналитика": "ea1450be-37f2-44b5-8827-af8bb4756bc3",
  "SEO": "11f77cc6-6b09-4b7c-9f3e-af31e87283a0",
  // Безопасность и качество
  "Авторизация": "4c89981c-f1d7-42c3-87c3-965542537f73",
  "Безопасность": "9f6b71e9-2b73-4ee0-bb2c-6623d4d0eaf3",
  "Производительность": "d3b2a01a-40a8-41d6-9265-a590cf3ff69c",
  "Краш": "c190d3c2-639f-42e7-8659-1b0ba31d6dab",
  "Тестирование": "43f69e40-0890-4c58-9fab-c961a38236fa",
  // Операции
  "Платежи": "09940e02-5026-444c-97b6-fb7c32e37b4d",
  "Уведомления": "38d12e51-421a-4c81-8159-7781983ca0fd",
  "Поддержка": "ddcda9fb-cf27-471d-99a9-4f74503aad10",
  "Модерация": "ab0b259f-888e-44f8-8d9b-c0a5b3c479bc",
};

const VALWIN_PROJECT_ID = "ce35acff-30e6-4208-9120-787e23b557b6";
const TRIAGE_STATE_ID = "db39f925-3f47-47cd-804a-36649b2f047a";

export async function linearGQL(
  env: Env,
  query: string,
  variables?: Record<string, unknown>,
  timeoutMs?: number,
): Promise<Record<string, any>> {
  const timeout = timeoutMs || 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(LINEAR_GQL_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: env.LINEAR_API_KEY,
      },
      body: JSON.stringify({ query, variables: variables || {} }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Linear API error (${res.status}): ${err}`);
    }

    const result = (await res.json()) as { data?: Record<string, any>; errors?: { message: string }[] };
    if (result.errors && result.errors.length > 0) {
      throw new Error(`Linear GraphQL: ${result.errors[0].message}`);
    }
    return result.data!;
  } catch (e: unknown) {
    clearTimeout(timer);
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(`Linear API timeout (${timeout / 1000}s)`);
    }
    throw e;
  }
}

// --- Create issue ---

export async function createLinearIssue(
  env: Env,
  report: BugReport,
  mediaUrls: string[],
  assigneeId?: string,
  project?: ProjectConfig,
): Promise<{ issueId: string; issueUrl: string; linearIssueId: string }> {
  let description = report.description;
  if (mediaUrls.length > 0) {
    description += "\n\n## Вложения\n";
    mediaUrls.forEach((url, i) => {
      if (url.includes("/video/")) {
        description += `- [Видео ${i + 1}](${url})\n`;
      } else {
        description += `![Скриншот ${i + 1}](${url})\n`;
      }
    });
  }

  let labelIds: string[];
  if (project) {
    labelIds = report.labels
      .map((l) => {
        const found = project.labels.find(
          (pl) => pl.name === l || pl.name.toLowerCase() === l.toLowerCase(),
        );
        return found?.id ?? null;
      })
      .filter(Boolean) as string[];
  } else {
    labelIds = report.labels
      .map((l) => {
        if (LABEL_MAP[l]) return LABEL_MAP[l];
        for (const mk in LABEL_MAP) {
          if (mk.toLowerCase() === l.toLowerCase()) return LABEL_MAP[mk];
        }
        return null;
      })
      .filter(Boolean) as string[];
  }

  const input: Record<string, unknown> = {
    title: report.title,
    description,
    teamId: project?.teamId ?? env.LINEAR_TEAM_ID,
    projectId: project?.projectId ?? VALWIN_PROJECT_ID,
    stateId: project?.states.triage ?? TRIAGE_STATE_ID,
    priority: report.priority,
    labelIds,
  };
  if (assigneeId) input.assigneeId = assigneeId;

  const data = await linearGQL(
    env,
    `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }`,
    { input },
  );

  const issue = data.issueCreate?.issue;
  if (!issue) throw new Error("Failed to create Linear issue");
  return { issueId: issue.identifier, issueUrl: issue.url, linearIssueId: issue.id };
}

// --- Update issue state ---

export async function updateLinearIssueState(
  env: Env,
  issueId: string,
  stateId: string,
): Promise<void> {
  await linearGQL(
    env,
    `mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }`,
    { id: issueId, stateId },
  );
}

// --- Add comment ---

export async function addLinearComment(
  env: Env,
  issueId: string,
  body: string,
): Promise<void> {
  await linearGQL(
    env,
    `mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }`,
    { issueId, body },
  );
}

// --- Search issues ---

export async function searchLinearIssues(
  env: Env,
  query: string,
): Promise<{ id: string; identifier: string; title: string; url: string; state: string }[]> {
  const data = await linearGQL(
    env,
    `query($q: String!) { searchIssues(query: $q, first: 10) { nodes { id identifier title url state { name type } } } }`,
    { q: query },
  );

  const nodes = data.searchIssues?.nodes || [];
  return nodes.map((i: any) => ({
    id: i.id || "",
    identifier: i.identifier || "",
    title: i.title || "",
    url: i.url || "",
    state: i.state?.type || "",
  }));
}

// --- Get issue ---

export async function getLinearIssue(
  env: Env,
  issueKey: string,
): Promise<Record<string, any>> {
  const match = issueKey.match(/^([A-Za-z]+)-(\d+)$/);
  if (match) {
    const data = await linearGQL(
      env,
      `query($teamKey: String!, $number: Float!) { issues(filter: { team: { key: { eq: $teamKey } }, number: { eq: $number } }, first: 1) { nodes { id identifier title url priority state { name } } } }`,
      { teamKey: match[1], number: parseInt(match[2], 10) },
    );
    const nodes = data.issues?.nodes || [];
    if (nodes.length > 0) {
      const i = nodes[0];
      return { id: i.id, identifier: i.identifier, title: i.title, url: i.url, priority: i.priority, state: { name: i.state?.name || "" } };
    }
  }

  const data2 = await linearGQL(
    env,
    `query($id: String!) { issue(id: $id) { id identifier title url priority state { name } } }`,
    { id: issueKey },
  );
  if (data2.issue) return data2.issue;
  throw new Error("Issue not found: " + issueKey);
}

// --- Find user by email ---

export async function findLinearUserByEmail(
  env: Env,
  email: string,
): Promise<{ id: string; name: string; email: string } | null> {
  const data = await linearGQL(
    env,
    `query($email: String!) { users(filter: { email: { eq: $email } }) { nodes { id name email } } }`,
    { email },
  );
  const nodes = data.users?.nodes || [];
  return nodes.length > 0 ? nodes[0] : null;
}

// --- List issues by team ---

export async function listLinearIssuesByTeam(
  env: Env,
  teamId?: string,
): Promise<LinearIssueListItem[]> {
  const tid = teamId ?? env.LINEAR_TEAM_ID;
  if (!tid) throw new Error("No teamId provided and LINEAR_TEAM_ID not set");
  const data = await linearGQL(
    env,
    `query($teamId: String!) { team(id: $teamId) { issues(first: 200, orderBy: createdAt) { nodes { identifier title url state { name type } priority createdAt completedAt assignee { name } } } } }`,
    { teamId: tid },
    25_000,
  );

  const nodes = data.team?.issues?.nodes || [];
  return nodes.map((i: any) => ({
    identifier: i.identifier || "",
    title: i.title || "",
    url: i.url || "",
    stateName: i.state?.name || "",
    stateType: i.state?.type || "",
    priority: i.priority || 0,
    createdAt: i.createdAt || "",
    completedAt: i.completedAt || "",
    assignee: i.assignee?.name || "",
  }));
}

// --- List workspace users ---

export async function listLinearWorkspaceUsers(
  env: Env,
): Promise<LinearWorkspaceUser[]> {
  const data = await linearGQL(
    env,
    `query { users { nodes { id name email active } } }`,
    {},
    20_000,
  );

  const nodes = data.users?.nodes || [];
  return nodes
    .filter((u: any) => u.active !== false)
    .map((u: any) => ({ id: u.id || "", name: u.name || "?", email: u.email || "" }))
    .sort((a: LinearWorkspaceUser, b: LinearWorkspaceUser) => a.name.localeCompare(b.name));
}

// ============================================================
// Multi-project: Linear team/project/state/label fetching
// ============================================================

export async function listLinearTeams(
  env: Env,
): Promise<{ id: string; name: string; key: string }[]> {
  const data = await linearGQL(env,
    `query { teams { nodes { id name key } } }`, {}, 15_000);
  return (data.teams?.nodes || []).map((t: any) => ({
    id: t.id, name: t.name || "?", key: t.key || "",
  }));
}

export async function listTeamProjects(
  env: Env,
  teamId: string,
): Promise<{ id: string; name: string }[]> {
  const data = await linearGQL(env,
    `query($teamId: String!) { team(id: $teamId) { projects { nodes { id name } } } }`,
    { teamId }, 15_000);
  return (data.team?.projects?.nodes || []).map((p: any) => ({
    id: p.id, name: p.name || "?",
  }));
}

export async function fetchTeamStates(
  env: Env,
  teamId: string,
): Promise<ProjectStates> {
  const data = await linearGQL(env,
    `query($teamId: String!) { team(id: $teamId) { states { nodes { id name type position } } } }`,
    { teamId }, 15_000);
  const nodes: { id: string; name: string; type: string; position: number }[] =
    (data.team?.states?.nodes || []).sort((a: any, b: any) => (a.position || 0) - (b.position || 0));

  let triage = "";
  let inProgress = "";
  let review: string | null = null;
  let done = "";
  let canceled = "";

  for (const s of nodes) {
    if (s.type === "triage" && !triage) triage = s.id;
    if (s.type === "started" && !inProgress) inProgress = s.id;
    if (s.type === "started" && /review|ревью|проверк/i.test(s.name)) review = s.id;
    if (s.type === "completed" && !done) done = s.id;
    if (s.type === "canceled" && !canceled) canceled = s.id;
  }

  if (!triage) {
    const unstarted = nodes.find((s) => s.type === "unstarted" || s.type === "backlog");
    if (unstarted) triage = unstarted.id;
  }

  if (!triage || !inProgress || !done) {
    throw new Error("Не удалось определить базовые состояния (triage/inProgress/done) для этой команды");
  }

  return { triage, inProgress, review, done, canceled };
}

export async function fetchTeamLabels(
  env: Env,
  teamId: string,
): Promise<ProjectLabel[]> {
  const data = await linearGQL(env,
    `query($teamId: String!) { team(id: $teamId) { labels { nodes { id name parent { name } } } } }`,
    { teamId }, 15_000);
  return (data.team?.labels?.nodes || []).map((l: any) => ({
    id: l.id,
    name: l.name || "?",
    parentName: l.parent?.name,
  }));
}

// ============================================================
// Vectorize: semantic duplicate detection
// ============================================================

async function generateEmbedding(env: Env, text: string): Promise<number[]> {
  const res = await env.AI!.run("@cf/baai/bge-m3" as any, { text: [text] }) as any;
  if (!res || !res.data || !res.data[0]) throw new Error("Embedding generation failed");
  return res.data[0];
}

export async function storeIssueVector(
  env: Env,
  linearIssueId: string,
  title: string,
  description: string,
  projectId?: string,
): Promise<void> {
  try {
    const textToEmbed = title + ". " + (description || "").slice(0, 500);
    const embedding = await generateEmbedding(env, textToEmbed);
    await env.VECTORIZE!.upsert([{
      id: linearIssueId,
      values: embedding,
      metadata: {
        title: title.slice(0, 200),
        projectId: projectId || "",
        createdAt: new Date().toISOString(),
      },
    }]);
  } catch (e: unknown) {
    console.error("Failed to store vector:", e instanceof Error ? e.message : e);
  }
}

export async function findSimilarIssues(
  env: Env,
  title: string,
  description: string,
  projectId?: string,
): Promise<{ linearIssueId: string; score: number; title: string }[]> {
  try {
    const textToEmbed = title + ". " + (description || "").slice(0, 500);
    const embedding = await generateEmbedding(env, textToEmbed);
    const filter = projectId ? { projectId } : undefined;
    const results = await env.VECTORIZE!.query(embedding, {
      topK: 5,
      returnMetadata: "all",
      filter,
    });

    if (!results || !results.matches) return [];
    return results.matches
      .filter((m: any) => m.score >= 0.92)
      .map((m: any) => ({
        linearIssueId: m.id,
        score: m.score,
        title: m.metadata?.title || "",
      }));
  } catch (e: unknown) {
    console.error("Semantic search failed:", e instanceof Error ? e.message : e);
    return [];
  }
}

export async function deleteIssueVector(
  env: Env,
  linearIssueId: string,
): Promise<void> {
  try {
    await env.VECTORIZE!.deleteByIds([linearIssueId]);
  } catch (e: unknown) {
    console.error("Failed to delete vector:", e instanceof Error ? e.message : e);
  }
}
