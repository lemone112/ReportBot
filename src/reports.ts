import type {
  Env, TelegramMessage, IssueMapping, MediaGroupBuffer, ProjectConfig,
} from "./types";
import {
  sendMessage, editMessageText, editMessageWithButtons,
  downloadFile, arrayBufferToBase64,
} from "./telegram";
import { analyzeBugReport, analyzeVideoReport } from "./claude";
import {
  createLinearIssue, searchLinearIssues, linearGQL,
  storeIssueVector, findSimilarIssues,
} from "./composio";
import {
  CE, esc, sleep, priorityLabel, userName, getTeamConfig, resolveAssignment, trackMetric,
  resolveProjectForChat,
} from "./utils";

const MEDIA_GROUP_DELAY_MS = 3500;

export async function createReportFlow(
  chatId: number, messageId: number, reporterName: string,
  text: string, imagesForAI: { data: string; mediaType: string }[],
  videosForAI: { buffer: ArrayBuffer; mediaType: string }[],
  mediaUrls: string[], env: Env, project?: ProjectConfig | null,
): Promise<void> {
  const loadingMsgId = await sendMessage(env, chatId,
    `${CE.LOADING} <b>Репорт принят!</b> Обрабатываю...`, messageId);

  try {
    const team = await getTeamConfig(env, project?.slug);
    const labels = project?.labels;
    let report;
    try {
      report = videosForAI.length > 0 && env.GEMINI_API_KEY
        ? await analyzeVideoReport(env, text, imagesForAI, videosForAI, team, labels)
        : await analyzeBugReport(env, text, imagesForAI, team, labels);
    } catch (aiErr: unknown) {
      console.error("AI analysis failed, retrying text-only:", aiErr instanceof Error ? aiErr.message : aiErr);
      if (text && text.trim()) {
        report = await analyzeBugReport(env, text, [], team, labels);
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

    const { issueId, issueUrl, linearIssueId } = await createLinearIssue(env, report, mediaUrls, assigneeId, project ?? undefined);

    const mapping: IssueMapping = {
      chatId, messageId, reporterName, issueId, issueUrl,
      title: report.title,
      projectSlug: project?.slug,
    };
    await env.BUG_REPORTS.put(`issue:${linearIssueId}`, JSON.stringify(mapping), {
      expirationTtl: 60 * 60 * 24 * 90,
    });

    // Store vector for future semantic search
    if (env.VECTORIZE && env.AI) {
      await storeIssueVector(env, linearIssueId, report.title, report.description, project?.projectId);
    }

    const replyParts = [
      `${CE.SUCCESS} <b>Баг-репорт создан!</b>`,
      ``,
      `<b>${esc(report.title)}</b>`,
      `Приоритет: ${priorityLabel(report.priority)}`,
      report.labels.length > 0 ? `Метки: ${report.labels.map(esc).join(", ")}` : "",
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

export async function createReportFlowSilent(
  chatId: number, messageId: number, reporterName: string,
  text: string, imagesForAI: { data: string; mediaType: string }[],
  videosForAI: { buffer: ArrayBuffer; mediaType: string }[],
  mediaUrls: string[], env: Env,
  editChatId: number, editMsgId: number,
  project?: ProjectConfig | null,
): Promise<void> {
  const team = await getTeamConfig(env, project?.slug);
  const labels = project?.labels;
  let report;
  try {
    report = videosForAI.length > 0 && env.GEMINI_API_KEY
      ? await analyzeVideoReport(env, text, imagesForAI, videosForAI, team, labels)
      : await analyzeBugReport(env, text, imagesForAI, team, labels);
  } catch (aiErr: unknown) {
    console.error("AI analysis failed (silent), retrying text-only:", aiErr instanceof Error ? (aiErr as Error).message : aiErr);
    if (text && text.trim()) {
      report = await analyzeBugReport(env, text, [], team, labels);
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

  const cr = await createLinearIssue(env, report, mediaUrls, assigneeId, project ?? undefined);
  await env.BUG_REPORTS.put(
    `issue:${cr.linearIssueId}`,
    JSON.stringify({ chatId, messageId, reporterName, issueId: cr.issueId, issueUrl: cr.issueUrl, title: report.title, projectSlug: project?.slug } satisfies IssueMapping),
    { expirationTtl: 7_776_000 },
  );

  if (env.VECTORIZE && env.AI) await storeIssueVector(env, cr.linearIssueId, report.title, report.description, project?.projectId);

  const parts = [
    `${CE.SUCCESS} <b>Баг-репорт создан!</b>`,
    "",
    `<b>${esc(report.title)}</b>`,
    `Приоритет: ${priorityLabel(report.priority)}`,
  ];
  if (report.labels.length > 0) parts.push(`Метки: ${report.labels.map(esc).join(", ")}`);
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
// Media group batching
// ============================================================

export async function handleMediaGroup(message: TelegramMessage, env: Env, origin: string): Promise<void> {
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

export async function processMediaGroup(key: string, env: Env, origin: string): Promise<void> {
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

  const project = await resolveProjectForChat(env, buffer.chatId);
  await createReportFlow(buffer.chatId, buffer.firstMessageId, buffer.reporterName, buffer.text, imagesForAI, videosForAI, mediaUrls, env, project);
}

// ============================================================
// Single message report
// ============================================================

export async function processSingleReport(message: TelegramMessage, env: Env, origin: string): Promise<void> {
  const rawText = message.text || message.caption || "";
  const text = rawText.replace(/^\/report(@\S+)?/i, "").trim();
  const coll = await collectAndUploadMedia(message, env, origin);
  const fullText = text + (coll.extraText ? "\n\n" + coll.extraText : "");

  const project = await resolveProjectForChat(env, message.chat.id);
  await createReportFlow(
    message.chat.id, message.message_id, userName(message.from),
    fullText, coll.imagesForAI, coll.videosForAI, coll.mediaUrls, env, project,
  );
}

// ============================================================
// Media collection (single message)
// ============================================================

export async function collectAndUploadMedia(
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
