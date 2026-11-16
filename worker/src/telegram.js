// Telegram Bot API calls. The token is part of the URL, so URLs are never logged; errors
// carry only Telegram's status and description.

export class TelegramError extends Error {
  constructor(method, status, description, retryAfter) {
    super(`Telegram ${method} HTTP ${status}: ${description ?? ""}`.trim());
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export async function tgCall(token, method, body) {
  const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = await resp.json(); } catch { /* empty body */ }
  if (!resp.ok || !data.ok) {
    throw new TelegramError(method, resp.status, data.description, data.parameters?.retry_after);
  }
  return data.result;
}

// A message in HTML parse mode, link previews off (owner alerts, the Step 8 fold test).
export function sendHtml(token, chatId, text, extra = {}) {
  return tgCall(token, "sendMessage", {
    chat_id: chatId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra,
  });
}

// A rich message (Bot API 10.1+, Step 11): rich_message.html with headings, tables, quotes and
// dividers. Plain URLs, hashtags and the like are not turned into links (skip_entity_detection).
export function sendRich(token, chatId, html, extra = {}) {
  return tgCall(token, "sendRichMessage", {
    chat_id: chatId, rich_message: { html, skip_entity_detection: true }, ...extra,
  });
}

// A digest, the way its layout says (plan.kind), with any extra fields (the Settings button).
export function sendDigestMessage(token, chatId, text, { kind = "html", ...extra } = {}) {
  return kind === "rich" ? sendRich(token, chatId, text, extra) : sendHtml(token, chatId, text, extra);
}

export function sendPlain(token, chatId, text, extra = {}) {
  return tgCall(token, "sendMessage", { chat_id: chatId, text, link_preview_options: { is_disabled: true }, ...extra });
}

// An inline "Open settings" button that opens the Mini App (works in private chats).
export function settingsButton(appUrl, text = "Open settings") {
  return { reply_markup: { inline_keyboard: [[{ text, web_app: { url: appUrl } }]] } };
}
