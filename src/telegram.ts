import type { Env, TelegramFile } from "./types";

const TG_API = "https://api.telegram.org/bot";

/**
 * Wrapper around fetch with a default 25s timeout.
 */
export function fetchT(url: string, opts?: RequestInit, ms = 25_000): Promise<Response> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  const init: RequestInit = { ...(opts || {}), signal: c.signal };
  return fetch(url, init).finally(() => clearTimeout(t));
}

export async function sendMessage(
  env: Env,
  chatId: number,
  text: string,
  replyToMessageId?: number,
): Promise<number | null> {
  let res = await fetchT(`${TG_API}${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      ...(replyToMessageId && { reply_to_message_id: replyToMessageId }),
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error(`Telegram sendMessage failed (${res.status}):`, errText);
    // Fallback: strip HTML tags and retry without parse_mode
    if (errText.includes("can't parse") || errText.includes("Bad Request")) {
      res = await fetchT(`${TG_API}${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: text.replace(/<[^>]*>/g, ""),
          ...(replyToMessageId && { reply_to_message_id: replyToMessageId }),
        }),
      });
    }
  }
  try {
    const d = (await res.json()) as { ok: boolean; result?: { message_id: number } };
    return d.ok && d.result ? d.result.message_id : null;
  } catch {
    return null;
  }
}

export async function deleteMessage(
  env: Env,
  chatId: number,
  messageId: number,
): Promise<void> {
  try {
    await fetchT(`${TG_API}${env.TELEGRAM_BOT_TOKEN}/deleteMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    });
  } catch (e) {
    console.error(e);
  }
}

interface InlineButton {
  text: string;
  callback_data: string;
}

export async function sendMessageWithButtons(
  env: Env,
  chatId: number,
  text: string,
  buttons: InlineButton[][],
): Promise<void> {
  const res = await fetchT(`${TG_API}${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buttons },
    }),
  });
  if (!res.ok) console.error(`TG sendMessageWithButtons failed (${res.status}):`, await res.text());
}

export async function editMessageText(
  env: Env,
  chatId: number,
  messageId: number,
  text: string,
): Promise<void> {
  const res = await fetchT(`${TG_API}${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
    }),
  });
  if (!res.ok) console.error(`TG editMessageText failed (${res.status}):`, await res.text());
}

export async function editMessageWithButtons(
  env: Env,
  chatId: number,
  messageId: number,
  text: string,
  buttons: InlineButton[][],
): Promise<void> {
  const res = await fetchT(`${TG_API}${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buttons },
    }),
  });
  if (!res.ok) console.error(`TG editMessageWithButtons failed (${res.status}):`, await res.text());
}

export async function answerCallbackQuery(
  env: Env,
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  const res = await fetchT(`${TG_API}${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text,
    }),
  });
  if (!res.ok) console.error(`TG answerCallbackQuery failed (${res.status})`);
}

export async function answerInlineQuery(
  env: Env,
  queryId: string,
  results: unknown[],
  opts?: Record<string, unknown>,
): Promise<void> {
  const body: Record<string, unknown> = {
    inline_query_id: queryId,
    results,
    cache_time: 5,
    is_personal: true,
  };
  if (opts) Object.assign(body, opts);
  const res = await fetchT(`${TG_API}${env.TELEGRAM_BOT_TOKEN}/answerInlineQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.error(`TG answerInlineQuery failed (${res.status}):`, await res.text());
}

export async function editInlineMessage(
  env: Env,
  inlineMessageId: string,
  text: string,
  buttons?: InlineButton[][],
): Promise<void> {
  const body: Record<string, unknown> = {
    inline_message_id: inlineMessageId,
    text,
    parse_mode: "HTML",
  };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };
  let res = await fetchT(`${TG_API}${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error(`TG editInlineMessage failed (${res.status}):`, errText);
    if (errText.includes("can't parse") || errText.includes("Bad Request")) {
      await fetchT(`${TG_API}${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inline_message_id: inlineMessageId,
          text: text.replace(/<[^>]*>/g, ""),
        }),
      });
    }
  }
}

export async function getFileUrl(env: Env, fileId: string): Promise<string | null> {
  const res = await fetchT(`${TG_API}${env.TELEGRAM_BOT_TOKEN}/getFile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
  const data = (await res.json()) as { ok: boolean; result?: TelegramFile };
  if (!data.ok || !data.result?.file_path) return null;
  return `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${data.result.file_path}`;
}

export async function downloadFile(
  env: Env,
  fileId: string,
): Promise<{ buffer: ArrayBuffer; mediaType: string } | null> {
  const url = await getFileUrl(env, fileId);
  if (!url) return null;

  const res = await fetch(url);
  if (!res.ok) return null;

  const buffer = await res.arrayBuffer();
  let mediaType = res.headers.get("content-type") || "application/octet-stream";
  if (mediaType === "application/octet-stream") {
    const ext = url.split(".").pop()?.toLowerCase();
    const mimeMap: Record<string, string> = {
      jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
      gif: "image/gif", webp: "image/webp", mp4: "video/mp4",
      mov: "video/quicktime", avi: "video/x-msvideo", webm: "video/webm",
    };
    mediaType = (ext && mimeMap[ext]) || "image/jpeg";
  }
  return { buffer, mediaType };
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

let _botUsername: string | null = null;

export async function getBotUsername(env: Env): Promise<string> {
  if (_botUsername) return _botUsername;
  try {
    const res = await fetchT(`${TG_API}${env.TELEGRAM_BOT_TOKEN}/getMe`, { method: "GET" });
    const data = (await res.json()) as { ok: boolean; result?: { username: string } };
    if (data.ok && data.result) _botUsername = data.result.username;
  } catch (e) {
    console.error(e);
  }
  return _botUsername || "bot";
}
