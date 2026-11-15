// Step 10: CPU of the payment handlers on this PC (Node). The database and Telegram are stand-ins
// that answer at once, so this is the Worker's own work per update. Writes nothing anywhere.
//   node scripts/step10-cpu.mjs
import { handleUpdate } from "../src/bot.js";
import { checkPreCheckout, invoiceFields, shapeTips } from "../src/tips.js";

const db = { batch: async (st) => st.map((s) => (/RETURNING id/.test(s.sql) ? [{ id: 1 }] : /SELECT lang/.test(s.sql) ? [{ lang: "ru" }] : [])) };
const ctx = { db, now: 1, ownerId: "42", tg: async () => true, reply: async () => true };
const pre = { pre_checkout_query: { id: "q", from: { id: 7, language_code: "ru" }, currency: "XTR", total_amount: 100, invoice_payload: "tip:100" } };
const paid = { message: { message_id: 1, from: { id: 7 }, chat: { id: 7, type: "private" },
  successful_payment: { currency: "XTR", total_amount: 100, invoice_payload: "tip:100", telegram_payment_charge_id: "c" } } };
const tap = { callback_query: { id: "c", from: { id: 7 }, data: "tip:100", message: { chat: { id: 7, type: "private" } } } };
async function measure(name, fn, n = 20000) {
  for (let i = 0; i < 500; i++) await fn();   // warm-up
  const t0 = process.cpuUsage();
  for (let i = 0; i < n; i++) await fn();
  const t = process.cpuUsage(t0);
  console.log(`${name}: ${(((t.user + t.system) / 1000) / n * 1000).toFixed(1)} microseconds each`);
}
await measure("pre_checkout_query (check + answer)", () => handleUpdate(pre, ctx));
await measure("successful_payment (store + thank-you)", () => handleUpdate(paid, ctx));
await measure("amount button tap (sendInvoice)", () => handleUpdate(tap, ctx));
await measure("invoice fields (Mini App link)", async () => invoiceFields("ru", 100));
await measure("check alone", async () => checkPreCheckout(pre.pre_checkout_query, "42"));
await measure("Admin tips shaping (10 rows)", async () => shapeTips([{ tips: 10, stars: 999 }], Array.from({ length: 10 }, (_, i) => ({ id: i, amount: 50, at: 1, first_name: "A" }))));
