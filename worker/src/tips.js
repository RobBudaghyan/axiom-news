// Step 10: voluntary tips in Telegram Stars ("Support Axiom ⭐"). A tip unlocks nothing and
// changes nothing else for the user. Telegram's rules for bots that sell digital goods
// (core.telegram.org/bots/payments-stars): currency XTR, an empty provider token, answer every
// pre_checkout_query within 10 seconds, deliver only on successful_payment, keep the charge id for
// refunds, answer /paysupport and offer /terms.
//
// Flow: the Mini App asks /api/tip for an invoice link (createInvoiceLink) and opens it with
// Telegram.WebApp.openInvoice; /support in the chat shows amount buttons and a tap sends an
// invoice (sendInvoice). Telegram then sends pre_checkout_query (answered at once, from the payload
// alone, no database read), and after the payment a message with successful_payment: one row in
// `tips` (the UNIQUE charge id makes a repeated update count once) and a thank-you in the user's
// language. The owner can refund a tip from Admin (refundStarPayment), after a confirm step.
import { t } from "./i18n.js";

export const TIP_AMOUNTS = [50, 100, 250, 500];
export const TEST_AMOUNT = 1;   // hidden, only for the owner's account (live test on the TEST bot)
const PAYLOAD_RE = /^tip:(\d{1,5})$/;

export const isOwnerId = (id, ownerId) => ownerId != null && String(id) === String(ownerId);

export function allowedAmount(amount, isOwner) {
  return Number.isInteger(amount) && (TIP_AMOUNTS.includes(amount) || (isOwner && amount === TEST_AMOUNT));
}

// The amounts a user may pick (the owner also sees the 1-Star test amount).
export const amountsFor = (isOwner) => (isOwner ? [...TIP_AMOUNTS, TEST_AMOUNT] : [...TIP_AMOUNTS]);

export const payloadFor = (amount) => `tip:${amount}`;
export function amountOf(payload) {
  const m = PAYLOAD_RE.exec(String(payload ?? ""));
  return m ? Number(m[1]) : null;
}

// The invoice, shared by createInvoiceLink (Mini App) and sendInvoice (/support).
export function invoiceFields(lang, amount) {
  return {
    title: t(lang, "bot.tip_title").slice(0, 32),
    description: t(lang, "bot.tip_description").slice(0, 255),
    payload: payloadFor(amount),
    provider_token: "",
    currency: "XTR",
    prices: [{ label: t(lang, "bot.tip_label"), amount }],
  };
}

// pre_checkout_query: ok only for a tip invoice in Stars whose amount matches its payload and is
// allowed for this user. Pure: no I/O, so the answer goes out within milliseconds.
export function checkPreCheckout(q, ownerId) {
  const amount = amountOf(q?.invoice_payload);
  return q?.currency === "XTR" && amount != null && q.total_amount === amount &&
    allowedAmount(amount, isOwnerId(q.from?.id, ownerId));
}

export async function answerPreCheckout(q, tg, ownerId, lang) {
  const ok = checkPreCheckout(q, ownerId);
  await tg("answerPreCheckoutQuery", ok ? { pre_checkout_query_id: q.id, ok: true }
    : { pre_checkout_query_id: q.id, ok: false, error_message: t(lang, "bot.tip_bad") });
  return ok;
}

// successful_payment: stored once per charge id. Returns {stored, amount}; stored is false for a
// repeated update (nothing is counted twice and no second thank-you is sent).
export async function recordPayment(db, userId, sp, now) {
  const amount = Number(sp.total_amount);
  const [rows] = await db.batch([{
    sql: "INSERT INTO tips (user_id, amount, charge_id, at) VALUES (?1, ?2, ?3, ?4) " +
         "ON CONFLICT(charge_id) DO NOTHING RETURNING id",
    params: [userId, amount, String(sp.telegram_payment_charge_id), now],
  }]);
  return { stored: rows.length > 0, amount };
}

// ------------------------------------------------------------------ Admin (owner only)

export function tipsStatements() {
  return [
    { sql: "SELECT count(*) AS tips, coalesce(sum(amount), 0) AS stars, " +
           "sum(refunded_at IS NOT NULL) AS refunded, coalesce(sum(CASE WHEN refunded_at IS NOT NULL THEN amount END), 0) AS refunded_stars " +
           "FROM tips", params: [] },
    { sql: "SELECT t.id, t.amount, t.at, t.refunded_at, u.first_name FROM tips t LEFT JOIN users u ON u.id = t.user_id " +
           "ORDER BY t.at DESC, t.id DESC LIMIT 10", params: [] },
  ];
}

export function shapeTips([total] = [], last = []) {
  const n = (v) => Number(v ?? 0);
  return {
    stars: n(total?.stars) - n(total?.refunded_stars),   // received and kept
    tips: n(total?.tips) - n(total?.refunded),
    refunded: n(total?.refunded), refunded_stars: n(total?.refunded_stars),
    last: last.map((r) => ({ id: r.id, name: r.first_name || "(no name)", amount: n(r.amount), at: r.at,
                             refunded_at: r.refunded_at ?? null })),
  };
}

// Refund one tip through the Bot API. Returns {status, body} for the API to send. A tip Telegram
// already refunded (e.g. a second tap) is marked refunded too.
export async function refundTip(db, tg, tipId, now) {
  const [[tip]] = await db.batch([{ sql: "SELECT id, user_id, amount, charge_id, refunded_at FROM tips WHERE id = ?1", params: [tipId] }]);
  if (!tip) return { status: 404, body: { ok: false, message: "That tip was not found." } };
  if (tip.refunded_at) return { status: 409, body: { ok: false, message: "This tip was already refunded." } };
  try {
    await tg("refundStarPayment", { user_id: tip.user_id, telegram_payment_charge_id: tip.charge_id });
  } catch (e) {
    if (!/CHARGE_ALREADY_REFUNDED/i.test(e.message)) {
      return { status: 502, body: { ok: false, message: `Telegram did not refund it: ${e.message}` } };
    }
  }
  await db.batch([{ sql: "UPDATE tips SET refunded_at = ?1 WHERE id = ?2 AND refunded_at IS NULL", params: [now, tip.id] }]);
  return { status: 200, body: { ok: true, message: `Refunded ${tip.amount} ⭐.`, user_id: tip.user_id, amount: tip.amount } };
}
