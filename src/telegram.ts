import type { Env, TelegramFile } from "./types";

const TG_API = "https://api.telegram.org/bot";

/**
 * Wrapper around fetch with a default 25s timeout.
 */
function fetchT(url: string, opts?: RequestInit, ms = 25_000): Promise<Response> {
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

// --- Bot avatar generation ---

function avatarCrc32(buf: Uint8Array): number {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  let crc = 4294967295;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 255] ^ (crc >>> 8);
  return (crc ^ 4294967295) >>> 0;
}

function writeU32BE(arr: Uint8Array, offset: number, val: number): void {
  arr[offset] = (val >>> 24) & 0xff;
  arr[offset + 1] = (val >>> 16) & 0xff;
  arr[offset + 2] = (val >>> 8) & 0xff;
  arr[offset + 3] = val & 0xff;
}

function makePngChunk(type: string, data: Uint8Array): Uint8Array {
  const buf = new Uint8Array(4 + 4 + data.length + 4);
  writeU32BE(buf, 0, data.length);
  buf[4] = type.charCodeAt(0);
  buf[5] = type.charCodeAt(1);
  buf[6] = type.charCodeAt(2);
  buf[7] = type.charCodeAt(3);
  buf.set(data, 8);
  const crcBuf = new Uint8Array(4 + data.length);
  crcBuf.set(buf.subarray(4, 8 + data.length));
  writeU32BE(buf, 8 + data.length, avatarCrc32(crcBuf));
  return buf;
}

async function generateAvatarPNG(mskHour: number, mskMinute: number): Promise<Uint8Array> {
  const W = 400, H = 400, GRID = 13, CELL = 26, GAP = 4;
  const PAD = Math.floor((W - GRID * (CELL + GAP) + GAP) / 2);
  const BG = [22, 22, 30];

  const minuteOfDay = mskHour * 60 + mskMinute;
  const colorKeys = [
    [0, 20, 15, 50], [180, 25, 20, 60], [300, 60, 30, 55],
    [360, 200, 90, 30], [420, 255, 140, 40], [510, 255, 180, 60],
    [600, 130, 180, 210], [720, 60, 150, 255], [840, 80, 170, 255],
    [960, 100, 140, 240], [1050, 140, 80, 220], [1110, 160, 50, 200],
    [1200, 120, 40, 180], [1320, 50, 25, 100], [1410, 30, 18, 65],
    [1440, 20, 15, 50],
  ];

  let cLo = colorKeys[0], cHi = colorKeys[1];
  for (let ci = 0; ci < colorKeys.length - 1; ci++) {
    if (minuteOfDay >= colorKeys[ci][0] && minuteOfDay < colorKeys[ci + 1][0]) {
      cLo = colorKeys[ci];
      cHi = colorKeys[ci + 1];
      break;
    }
  }

  const cRange = cHi[0] - cLo[0];
  let cT = cRange > 0 ? (minuteOfDay - cLo[0]) / cRange : 0;
  cT = cT * cT * (3 - 2 * cT); // smoothstep

  const accent = [
    Math.round(cLo[1] + (cHi[1] - cLo[1]) * cT),
    Math.round(cLo[2] + (cHi[2] - cLo[2]) * cT),
    Math.round(cLo[3] + (cHi[3] - cLo[3]) * cT),
  ];

  const hourF = minuteOfDay / 60;
  let bright = 0;
  if (hourF >= 7 && hourF <= 18) {
    const bT = (hourF - 7) / 11;
    bright = 0.3 + 0.7 * Math.sin(bT * Math.PI);
  } else if (hourF > 6 && hourF < 7) {
    bright = (hourF - 6) * 0.3;
  } else if (hourF > 18 && hourF < 19) {
    bright = (19 - hourF) * 0.3;
  }

  let seed = mskHour * 4 + Math.floor(mskMinute / 15);
  function rng(): number {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed >> 16) / 32768;
  }

  const raw = new Uint8Array(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 3)] = 0;
    for (let x = 0; x < W; x++) {
      const idx = y * (1 + W * 3) + 1 + x * 3;
      raw[idx] = BG[0]; raw[idx + 1] = BG[1]; raw[idx + 2] = BG[2];
    }
  }

  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      let intensity = rng();
      if (intensity < 0.3) intensity = 0.05;
      else if (intensity < 0.5) intensity = 0.15;
      else if (intensity < 0.7) intensity = 0.35;
      else if (intensity < 0.85) intensity = 0.6;
      else intensity = 0.9;

      const cx = PAD + gx * (CELL + GAP);
      const cy = PAD + gy * (CELL + GAP);
      let cr = BG[0] + (accent[0] - BG[0]) * intensity;
      let cg = BG[1] + (accent[1] - BG[1]) * intensity;
      let cb = BG[2] + (accent[2] - BG[2]) * intensity;

      if (bright > 0 && intensity > 0.3) {
        const lR = 220 + (accent[0] > 150 ? 35 : 20);
        const lG = 220 + (accent[1] > 150 ? 35 : 20);
        const lB = 230 + (accent[2] > 150 ? 25 : 15);
        const lMix = bright * Math.pow(intensity, 1.2);
        cr = cr + (lR - cr) * lMix;
        cg = cg + (lG - cg) * lMix;
        cb = cb + (lB - cb) * lMix;
      }
      cr = Math.round(Math.min(255, Math.max(0, cr)));
      cg = Math.round(Math.min(255, Math.max(0, cg)));
      cb = Math.round(Math.min(255, Math.max(0, cb)));

      const R = 4;
      for (let py = 0; py < CELL; py++) {
        for (let px = 0; px < CELL; px++) {
          let corner = false;
          if (px < R && py < R) corner = (R - px) * (R - px) + (R - py) * (R - py) > R * R;
          if (px >= CELL - R && py < R) corner = (px - CELL + R + 1) * (px - CELL + R + 1) + (R - py) * (R - py) > R * R;
          if (px < R && py >= CELL - R) corner = (R - px) * (R - px) + (py - CELL + R + 1) * (py - CELL + R + 1) > R * R;
          if (px >= CELL - R && py >= CELL - R) corner = (px - CELL + R + 1) * (px - CELL + R + 1) + (py - CELL + R + 1) * (py - CELL + R + 1) > R * R;
          if (!corner) {
            const iy = cy + py, ix = cx + px;
            if (iy >= 0 && iy < H && ix >= 0 && ix < W) {
              const idx = iy * (1 + W * 3) + 1 + ix * 3;
              raw[idx] = cr; raw[idx + 1] = cg; raw[idx + 2] = cb;
            }
          }
        }
      }
    }
  }

  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  writer.write(raw);
  writer.close();
  const chunks: Uint8Array[] = [];
  const reader = cs.readable.getReader();
  while (true) {
    const r = await reader.read();
    if (r.done) break;
    chunks.push(r.value);
  }
  const totalLen = chunks.reduce((s, c) => s + c.length, 0);
  const compressed = new Uint8Array(totalLen);
  let off = 0;
  for (const chunk of chunks) { compressed.set(chunk, off); off += chunk.length; }

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  writeU32BE(ihdr, 0, W); writeU32BE(ihdr, 4, H);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const ihdrC = makePngChunk("IHDR", ihdr);
  const idatC = makePngChunk("IDAT", compressed);
  const iendC = makePngChunk("IEND", new Uint8Array(0));

  const png = new Uint8Array(sig.length + ihdrC.length + idatC.length + iendC.length);
  off = 0;
  png.set(sig, off); off += sig.length;
  png.set(ihdrC, off); off += ihdrC.length;
  png.set(idatC, off); off += idatC.length;
  png.set(iendC, off);
  return png;
}

export async function updateBotAvatar(env: Env): Promise<void> {
  try {
    const now = new Date();
    const mskHour = (now.getUTCHours() + 3) % 24;
    const mskMinute = now.getUTCMinutes();
    const png = await generateAvatarPNG(mskHour, mskMinute);

    const boundary = "----AvatarBoundary" + Date.now();
    const enc = new TextEncoder();
    const parts = [
      enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="photo"\r\n\r\n${JSON.stringify({ type: "static", photo: "attach://file" })}\r\n`),
      enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="avatar.png"\r\nContent-Type: image/png\r\n\r\n`),
      png,
      enc.encode(`\r\n--${boundary}--\r\n`),
    ];
    const totalLen = parts.reduce((s, p) => s + p.length, 0);
    const body = new Uint8Array(totalLen);
    let off = 0;
    for (const part of parts) { body.set(part, off); off += part.length; }

    const res = await fetchT(`${TG_API}${env.TELEGRAM_BOT_TOKEN}/setMyProfilePhoto`, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body,
    });
    if (!res.ok) {
      const err = await res.text();
      console.error("setMyProfilePhoto failed:", err);
    }
  } catch (e: unknown) {
    console.error("Avatar update failed:", e instanceof Error ? e.message : e);
  }
}
