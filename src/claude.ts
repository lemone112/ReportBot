import type { Env, BugReport, TeamConfig, ProjectLabel } from "./types";

const VALID_LABELS = new Set([
  "Баг", "Фича", "Доработка",
  "Фронтенд", "Бэкенд", "API", "База данных", "Мобильное", "Десктоп", "Инфра",
  "UI/UX", "2D графика", "3D графика", "Анимация", "Брендинг", "Звук", "Видео",
  "Продукт", "Контент", "Маркетинг", "Аналитика", "SEO",
  "Авторизация", "Безопасность", "Производительность", "Краш", "Тестирование",
  "Платежи", "Уведомления", "Поддержка", "Модерация",
]);

const EN_MAP: Record<string, string> = {
  bug: "Баг", feature: "Фича", improvement: "Доработка",
  frontend: "Фронтенд", backend: "Бэкенд", mobile: "Мобильное",
  desktop: "Десктоп", database: "База данных", security: "Безопасность",
  performance: "Производительность", crash: "Краш", auth: "Авторизация",
  infra: "Инфра", testing: "Тестирование", payments: "Платежи",
  notifications: "Уведомления", animation: "Анимация", branding: "Брендинг",
  video: "Видео", sound: "Звук", content: "Контент", marketing: "Маркетинг",
  analytics: "Аналитика", product: "Продукт", support: "Поддержка",
  moderation: "Модерация",
};

function normalizeReport(raw: Record<string, unknown>, validLabels?: Set<string>): BugReport {
  const labelSet = validLabels ?? VALID_LABELS;
  return {
    title: typeof raw.title === "string" && raw.title.length > 0
      ? raw.title.slice(0, 80)
      : "Без заголовка",
    description: typeof raw.description === "string" && raw.description.length > 0
      ? raw.description
      : "Описание не сгенерировано",
    priority: [1, 2, 3, 4].includes(Number(raw.priority)) ? Number(raw.priority) : 3,
    labels: Array.isArray(raw.labels)
      ? (raw.labels as string[]).map((l) => {
          if (labelSet.has(l)) return l;
          for (const vl of labelSet) {
            if (vl.toLowerCase() === l.toLowerCase()) return vl;
          }
          // EN_MAP fallback only for hardcoded default labels
          if (!validLabels) {
            const mapped = EN_MAP[l.toLowerCase()];
            if (mapped) return mapped;
          }
          return null;
        }).filter(Boolean) as string[]
      : validLabels ? [] : ["Баг"],
    assignee: typeof raw.assignee === "string" && raw.assignee.length > 0
      && raw.assignee !== "null" && raw.assignee !== "none"
      ? raw.assignee
      : null,
  };
}

function buildLabelsSection(labels?: ProjectLabel[]): string {
  if (!labels || labels.length === 0) {
    return `ДОПУСТИМЫЕ МЕТКИ (используй ТОЛЬКО эти, точные названия):

Тип (обязательно одна):
- "Баг" — ошибка, что-то сломалось
- "Фича" — новый функционал
- "Доработка" — улучшение существующего

Разработка:
- "Фронтенд" — вёрстка, стили, JS/TS, компоненты, респонсив
- "Бэкенд" — серверная логика, бизнес-логика
- "API" — эндпоинты, интеграции, вебхуки
- "База данных" — БД, миграции, запросы, кеш
- "Мобильное" — мобильное приложение или адаптив
- "Десктоп" — десктопное приложение
- "Инфра" — деплой, CI/CD, серверы, мониторинг

Дизайн и креатив:
- "UI/UX" — интерфейс, юзабилити, макеты, прототипы
- "2D графика" — иконки, иллюстрации, текстуры, спрайты
- "3D графика" — модели, сцены, рендеринг
- "Анимация" — моушн, переходы, эффекты
- "Брендинг" — лого, фирменный стиль, гайдлайны
- "Звук" — аудио, музыка, звуковые эффекты
- "Видео" — видеоконтент, монтаж, стриминг

Продукт и бизнес:
- "Продукт" — продуктовые решения, логика фич
- "Контент" — тексты, локализация, копирайтинг
- "Маркетинг" — промо, лендинги, кампании
- "Аналитика" — метрики, трекинг, отчёты, A/B тесты
- "SEO" — поисковая оптимизация

Безопасность и качество:
- "Авторизация" — логин, регистрация, права доступа
- "Безопасность" — уязвимости, утечки, защита данных
- "Производительность" — скорость, оптимизация, нагрузка
- "Краш" — краш, зависание, потеря данных
- "Тестирование" — тесты, QA, автотесты

Операции:
- "Платежи" — оплата, подписки, биллинг
- "Уведомления" — пуши, email, алерты, нотификации
- "Поддержка" — саппорт, жалобы пользователей
- "Модерация" — модерация контента, жалобы, блокировки

ПРАВИЛА КЛАССИФИКАЦИИ:
- Всегда ставь одну из: "Баг", "Фича" или "Доработка" — это тип задачи
- Добавляй 1-3 уточняющие метки из остальных категорий`;
  }

  // Dynamic labels from project config
  const grouped = new Map<string, string[]>();
  const ungrouped: string[] = [];

  for (const label of labels) {
    if (label.parentName) {
      const group = grouped.get(label.parentName) ?? [];
      group.push(label.name);
      grouped.set(label.parentName, group);
    } else {
      ungrouped.push(label.name);
    }
  }

  let section = `ДОПУСТИМЫЕ МЕТКИ (используй ТОЛЬКО эти, точные названия):\n`;

  if (ungrouped.length > 0) {
    for (const name of ungrouped) {
      section += `- "${name}"\n`;
    }
  }

  for (const [parent, children] of grouped) {
    section += `\n${parent}:\n`;
    for (const name of children) {
      section += `- "${name}"\n`;
    }
  }

  section += `\nПРАВИЛА КЛАССИФИКАЦИИ:
- Выбирай 1-4 наиболее подходящие метки из списка выше
- Ориентируйся на суть задачи и контекст`;

  return section;
}

function buildSystemPrompt(team: TeamConfig, labels?: ProjectLabel[]): string {
  const rolesSection = buildRolesSection(team);
  const labelsSection = buildLabelsSection(labels);

  return `Ты — аналитик баг-репортов. Ты получаешь сырые отчёты об ошибках и запросы на доработку от пользователей (текст, скриншоты, превью видео) и форматируешь их в структурированные, понятные задачи для команды разработки.

Анализируй ВСЮ предоставленную информацию — текстовые описания, скриншоты и видео — чтобы составить полный отчёт.

Отвечай ТОЛЬКО валидным JSON по этой схеме:
{
  "title": "Короткий, описательный заголовок (макс 80 символов, на русском)",
  "description": "Подробное описание в markdown (структура зависит от типа — см. ниже)",
  "priority": <число 1-4: 1=срочно, 2=высокий, 3=средний, 4=низкий>,
  "labels": ["одна или несколько меток из допустимого списка"],
  "assignee": "slug роли из команды или null"
}

${labelsSection}
- Приоритет: краши/потеря данных = 1, сломанный функционал = 2, визуальные/UX = 3, мелкие/косметические = 4

СТРУКТУРА ОПИСАНИЯ:
Для багов:
## Шаги для воспроизведения
1. ...
## Ожидаемое поведение
...
## Фактическое поведение
...

Для фич/доработок:
## Описание
...
## Ожидаемый результат
...
${rolesSection}
ОБЩИЕ ПРАВИЛА:
- Описание на русском языке
- Если приложены скриншоты или видео, опиши что на них видно
- Если текст расплывчатый, составь лучший возможный отчёт
- НЕ оборачивай в markdown code fences, выдавай только чистый JSON`;
}

function buildRolesSection(team: TeamConfig): string {
  const entries = Object.entries(team).filter(([, r]) => r.member);
  if (entries.length === 0) {
    return `\nНАЗНАЧЕНИЕ:
- В команде нет назначенных участников. Всегда ставь "assignee": null\n`;
  }

  let section = `\nКОМАНДА (назначай задачу наиболее подходящему участнику):
`;
  for (const [slug, role] of entries) {
    section += `- "${slug}" — ${role.name}\n`;
  }

  section += `
ПРАВИЛА НАЗНАЧЕНИЯ:
- Выбери ОДНОГО наиболее подходящего участника из команды выше
- Ориентируйся прежде всего на НАЗВАНИЕ роли и суть задачи, метки — лишь подсказка
- Примеры: визуальный баг на сайте → фронтенд-разработчик (не дизайнер); нужна новая иконка → дизайнер (не фронтенд)
- Верни slug роли в поле "assignee", например "assignee": "frontend"
- Если задача не подходит ни одной роли — верни "assignee": null
`;
  return section;
}

interface OpenAIContent {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

/**
 * Wrapper around fetch with a default 25s timeout.
 */
function fetchT(url: string, opts?: RequestInit, ms = 25_000): Promise<Response> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  const init: RequestInit = { ...(opts || {}), signal: c.signal };
  return fetch(url, init).finally(() => clearTimeout(t));
}

export async function analyzeBugReport(
  env: Env,
  text: string,
  images: { data: string; mediaType: string }[],
  team: TeamConfig,
  labels?: ProjectLabel[],
): Promise<BugReport> {
  const systemPrompt = buildSystemPrompt(team, labels);
  const validLabels = labels && labels.length > 0
    ? new Set(labels.map((l) => l.name))
    : undefined;

  // Text-only: prefer Gemini Flash if available
  if (images.length === 0 && env.GEMINI_API_KEY) {
    try {
      const gRes = await fetchT(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents: [{ parts: [{ text: text || "(Текст не предоставлен)" }] }],
            generationConfig: { responseMimeType: "application/json" },
          }),
        },
      );
      if (gRes.ok) {
        const gData = (await gRes.json()) as {
          candidates?: { content?: { parts?: { text?: string }[] } }[];
        };
        const gText = gData.candidates?.[0]?.content?.parts?.[0]?.text;
        if (gText) {
          const gCleaned = gText.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
          if (gCleaned.charAt(0) !== "{") throw new Error("AI returned non-JSON: " + gCleaned.slice(0, 80));
          return normalizeReport(JSON.parse(gCleaned), validLabels);
        }
      }
      console.error("Gemini Flash failed for text, falling back to OpenAI");
    } catch (gErr: unknown) {
      console.error("Gemini Flash error:", gErr instanceof Error ? gErr.message : gErr);
    }
  }

  // OpenAI path (images or Gemini fallback)
  const content: OpenAIContent[] = [];
  for (const img of images) {
    content.push({
      type: "image_url",
      image_url: { url: `data:${img.mediaType};base64,${img.data}` },
    });
  }
  content.push({
    type: "text",
    text: text || "(Текст не предоставлен — проанализируй скриншоты выше)",
  });

  const res = await fetchT("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o",
      max_tokens: 1024,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI error (${res.status}): ${err}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const rt = data.choices?.[0]?.message?.content;
  if (!rt) throw new Error("Пустой ответ от OpenAI");

  const rtCleaned = rt.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  if (rtCleaned.charAt(0) !== "{") throw new Error("AI returned non-JSON: " + rtCleaned.slice(0, 80));
  return normalizeReport(JSON.parse(rtCleaned), validLabels);
}

// ============================================================
// Gemini-based analysis for video reports (File API)
// ============================================================

interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
  file_data?: { file_uri: string; mime_type: string };
}

async function uploadToGeminiFile(
  env: Env, buffer: ArrayBuffer, mimeType: string,
): Promise<string> {
  const uploadRes = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": mimeType, "X-Goog-Upload-Protocol": "raw" },
      body: buffer,
    },
  );
  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    throw new Error(`Gemini upload error (${uploadRes.status}): ${err}`);
  }

  const result = (await uploadRes.json()) as {
    file: { name: string; uri: string; state: string };
  };

  let { state } = result.file;
  const fileName = result.file.name;
  let attempts = 0;

  while (state === "PROCESSING" && attempts < 20) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const checkRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${env.GEMINI_API_KEY}`,
      );
      if (!checkRes.ok) {
        console.error(`Gemini poll error (attempt ${attempts + 1}): ${checkRes.status}`);
        attempts++;
        continue;
      }
      const checkData = (await checkRes.json()) as { state: string; uri?: string; error?: unknown };
      state = checkData.state;
      if (checkData.uri) result.file.uri = checkData.uri;
      if (state === "FAILED") {
        throw new Error(`Gemini video processing FAILED: ${JSON.stringify(checkData.error || "unknown")}`);
      }
    } catch (pollErr: unknown) {
      if (pollErr instanceof Error && pollErr.message.includes("FAILED")) throw pollErr;
      console.error(`Gemini poll exception (attempt ${attempts + 1}):`, pollErr);
    }
    attempts++;
  }

  if (state === "PROCESSING") throw new Error("Gemini video processing timeout after 60s");
  if (state !== "ACTIVE") throw new Error(`Gemini video processing ended with state: ${state}`);
  if (!result.file.uri) throw new Error("Gemini file URI is missing after processing");
  return result.file.uri;
}

export async function analyzeVideoReport(
  env: Env,
  text: string,
  images: { data: string; mediaType: string }[],
  videos: { buffer: ArrayBuffer; mediaType: string }[],
  team: TeamConfig,
  labels?: ProjectLabel[],
): Promise<BugReport> {
  const systemPrompt = buildSystemPrompt(team, labels);
  const validLabels = labels && labels.length > 0
    ? new Set(labels.map((l) => l.name))
    : undefined;
  const parts: GeminiPart[] = [];
  let videoUploadFailed = false;

  for (const video of videos) {
    try {
      const fileUri = await uploadToGeminiFile(env, video.buffer, video.mediaType);
      parts.push({ file_data: { file_uri: fileUri, mime_type: video.mediaType } });
    } catch (uploadErr) {
      console.error("Video upload to Gemini failed:", uploadErr instanceof Error ? uploadErr.message : String(uploadErr));
      videoUploadFailed = true;
    }
  }

  if (videoUploadFailed && parts.length === 0 && images.length === 0) {
    console.log("All video uploads failed and no images, falling back to OpenAI");
    return analyzeBugReport(env, text, images, team, labels);
  }

  for (const img of images) {
    parts.push({
      inline_data: { mime_type: img.mediaType, data: img.data },
    });
  }

  const contextNote = videoUploadFailed
    ? "\n\n(Примечание: видео не удалось обработать, анализируй по превью-кадрам и тексту)"
    : "";
  parts.push({
    text: (text || "(Текст не предоставлен — проанализируй видео и скриншоты выше)") + contextNote,
  });

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts }],
        generationConfig: {
          responseMimeType: "application/json",
        },
      }),
    },
  );

  if (!res.ok) {
    const err = await res.text();
    console.error(`Gemini API error (${res.status}): ${err}`);
    console.log("Gemini generateContent failed, falling back to OpenAI");
    return analyzeBugReport(env, text, images, team, labels);
  }

  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };

  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) {
    console.error("Empty response from Gemini, falling back to OpenAI");
    return analyzeBugReport(env, text, images, team, labels);
  }

  const cleaned = rawText.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  try {
    if (cleaned.charAt(0) !== "{") throw new Error("non-JSON");
    return normalizeReport(JSON.parse(cleaned), validLabels);
  } catch (parseErr) {
    console.error("Failed to parse Gemini JSON response:", cleaned.slice(0, 200));
    return analyzeBugReport(env, text, images, team, labels);
  }
}
