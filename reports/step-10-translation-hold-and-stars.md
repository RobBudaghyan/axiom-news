# Step 10: Translation hold and "Support Axiom ⭐"

Date: 2026-11-15. Still on the TEST bot (@justatia_bot). Deployed (Worker version `6b1c8146`),
pushed (commits `7fb2a8a` part A, `ee887c1` part B, and the docs commit). Command list updated
with `setup-bot.mjs`. Cost: still $0, no card.

## Part A: untranslated stories wait instead of turning the digest English

**What changed.** Before, if even one story in a Russian reader's digest had no Russian
translation yet, the whole digest went out in English. Now:
- That story is **held**: left out of this digest and **not** marked as sent.
- The rest of the digest goes out in Russian, and the greeting counts only the stories actually
  sent ("2 истории", not 3).
- The length limit (3,900 characters) is applied **after** the held stories are taken out, so their
  room goes to other translated stories that would have been cut.
- Once the held story is translated (the hourly job does this), it goes out in the reader's next
  digest, as long as it is less than 24 hours old. Each held story gets a small "held" note in the
  database, so it is not lost when the "since your last digest" window moves on. It is never sent
  twice.
- **Only exception:** if holding leaves **no story at all** while the English digest would have had
  some (for example right after someone switches to Russian), that digest goes out fully in
  English, as before. Never a mix of languages.
- If nothing qualifies anyway, the reader gets the normal quiet note in their language.

**What you see.** Admin, "Languages, last 24 h": for each language, "N stories held for
translation" (and "X of Y sent later"), and a badge counting the digests that went out **fully** in
English. The Mini App's language note now says a story not translated yet comes in a later digest.

**Tests (part A).** 154 Worker tests passed at this point (15 new or changed), 118 Python tests (1
new: old held notes are cleaned up after 30 days). The new tests check: an untranslated story is
dropped and the rest stays Russian; it is not marked sent and arrives in the next digest after
translation, even though its window passed; never resent after that; held again if still not
translated; only inside 24 hours; the greeting count; the length cut refills the freed room; zero
left means English; the quiet note in Russian; the Admin counts.

**Rules broken on purpose (part A), all caught:**

| Broken on purpose | Tests that failed |
|---|---|
| back to the old rule (one missing story makes all English) | 8 |
| held stories marked as sent | 4 |
| no held note written / held note ignored by the digest query | 4 / 4 |
| no 24-hour limit for held stories | 1 |
| length cut before the drop | 1 |
| greeting counts the held stories too | 5 |
| zero left: Russian quiet note instead of the English digest | 4 |
| English readers also hold stories | 1 |
| Admin held count off / full English fallback not logged | 1 / 2 |
| never-twice check off | 5 |

## Part B: "Support Axiom ⭐" (voluntary Telegram Stars tips)

**What changed.**
- **Mini App:** a "Support Axiom ⭐" button at the bottom of Settings. Tapping it shows 50, 100,
  250 and 500 ⭐; an amount opens Telegram's own payment sheet. A short note says Axiom is free,
  tips are voluntary and help keep it running, nothing is locked, and points to the terms.
- **Chat:** `/support` gives the same text with four amount buttons; a tap sends a Stars invoice.
- **Your account only** also sees a hidden "1 ⭐ test" amount (the server refuses it for anyone else).
- **After a payment:** a short thank-you in the person's language. A tip changes nothing else.
- **Stored:** one row per tip with only who tipped, the amount, Telegram's payment id, the time,
  and (if refunded) the refund time. If Telegram sends the same payment twice, it counts once.
- **Telegram's rules for bots that take Stars** (checked in the current docs, Bot API 10.4):
  Stars only (currency XTR, no payment provider, no card); every payment confirmation is answered
  at once (Telegram cancels after 10 seconds; ours answers without even reading the database);
  `/paysupport` (explains, and a note written after it is forwarded to you with the person's name
  and id); `/terms` (the tip terms). All three are in the command list, in English and Russian.
- **Refunds:** from Admin, after a confirm step, through Telegram's refund method. The person gets
  a short "your tip was refunded" note.

**What you see.** Admin, new "Tips" section: total Stars received (refunded tips not counted), the
number of tips, the last 10 tips (first name, amount, date) and a "Refund" button on each (it asks
first; a refunded tip shows "Refunded").

**Tests (part B).** Worker 154 -> **169**. New: the invoice (Stars, empty provider, one price,
the amount in the payload, title and description within Telegram's limits); only the four amounts,
the 1-Star amount only for you; `/support` buttons and the invoice a tap sends; the payment
confirmation (accepted without a database read; refused for a wrong currency, a changed amount, an
unknown amount, or the test amount from someone else); a payment stored once with one thank-you
(in Russian for a Russian reader) and no other change to the user; Telegram's refund note; refunds
owner only, marked once, a Telegram refusal leaves it unmarked; Admin totals; `/paysupport` and
`/terms`; the command list; every new text present in en, ru, hy and fr, no em dash, сводка rule
unchanged. The Mini App click-through (28 checks in headless Edge) passes; it caught one real
problem (the star icon was not drawn like the other icons), now fixed.

**Rules broken on purpose (part B), all caught:**

| Broken on purpose | Tests that failed |
|---|---|
| every payment confirmation accepted | 1 |
| amount not checked against the invoice | 1 |
| 1-Star test amount for everyone | 3 |
| a repeated payment stored twice / thank-you sent twice | 3 / 1 |
| refund not owner only | 1 |
| refund not marked / marked although Telegram refused | 2 / 1 |
| not Stars (USD) / a payment provider token | 2 / 1 |
| database read before answering the confirmation | 1 |
| a tip changes the user's settings | 1 |
| /paysupport missing from the command list / its note not sent to you | 1 / 1 |
| a text missing in Armenian / an em dash in a Russian text | 3 / 3 |
| Admin total counts refunded tips | 1 |

**Live check.** You tapped the button on your phone: the Mini App showed the amounts and Telegram
opened its payment sheet (5 real invoice links made). You chose **not to pay**: the smallest Stars
purchase costs about $2, so no real tip was made. Instead I ran 8 live checks that cost nothing
(`worker/scripts/step10-live-check.mjs`), all passed:
- a stranger gets "not allowed" for Admin and for refunds;
- your refund of a tip that does not exist stops before Telegram is asked;
- Admin answers with the Tips section (0 Stars, 0 tips) and the new held counts;
- Telegram's refund method answers a made-up payment id with an error (so the call and its
  fields are right; there was no real payment to refund);
- the 1-Star amount gives you an invoice link and is refused for a stranger.

**Not checked live:** a real payment arriving, the thank-you message from a real payment, and a
real refund. These are covered by the tests with Telegram's documented messages. The first real
tip will show it; if you ever buy Stars, a 1 ⭐ tip and a refund from Admin would close this gap
(the refund gives the Star back).

## Worker CPU (10 ms limit)

- **Digest build** (this PC, 800 digests from today's real pool): English 0.47 ms each, Russian
  0.53 to 0.64 ms, Russian with 30% of stories held 0.53 to 0.63 ms. Holding adds no measurable cost.
- **Payment handlers** (this PC): a few microseconds each (the confirmation, storing a payment,
  the invoice for a button tap).
- **On Cloudflare** (`wrangler tail`, new version): the invoice links from your taps took **1 ms**
  each; Admin with the Tips section 0 to 4 ms; the refund route 1 to 2 ms; the Mini App open 3 ms.
- A 5-minute cron tick on the new version took **3 ms** (no digest was due). **A tick that sends a
  digest with held stories was not measured on Cloudflare** (nobody reads Russian yet); from the
  numbers above it costs the same as a Step 9 Russian digest, inside the same margin.

## Risks

- **A story that keeps failing the translation checks** is held from Russian readers until it
  passes or is 24 hours old. If it is the only story a digest would have, that digest goes out in
  English (the "zero left" rule).
- **Held stories arrive later**, so a Russian reader may get a story a few hours after English
  readers. The hourly job translates within the hour in normal runs.
- **No real payment has gone through yet** (see Live check).
- **Disputes and withdrawals:** Telegram makes the bot owner responsible for tip disputes;
  `/paysupport` notes come to you in the chat. Turning Stars into money goes through Telegram's own
  withdrawal rules, which are not set up.
- **Russian readers from before this step** keep the old two-command list in their chat until they
  change language again (there are none yet).

## Files
- **New:** `worker/src/tips.js`, `worker/test/hold.test.mjs`, `worker/test/tips.test.mjs`,
  `worker/scripts/step10-cpu.mjs`, `worker/scripts/step10-live-check.mjs`, this report.
- **Changed:** `db/schema.sql` (tables `digest_holds` and `tips`, applied to the live database
  first), `job/run.py` (clean-up), `worker/src/digest.js`, `cron.js`, `api.js`, `admin.js`,
  `bot.js`, `i18n.js`, `index.js`, `worker/public/app/` (Support section, Admin Tips, texts),
  `config/i18n/en.json`, `ru.json`, `hy.json`, `fr.json`, `worker/scripts/setup-bot.mjs`,
  `digest-cli.mjs` (`--held`), `dev-server.mjs` and `dev/mock-telegram.js` (preview), tests,
  `PROJECT_NOTES.md`.

## What you need to do
Nothing. If you ever have Stars, a 1 ⭐ test tip and a refund from Admin would confirm the payment
path end to end.
