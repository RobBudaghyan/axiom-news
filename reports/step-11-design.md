# Step 11: Ukraine wording, simpler tips, new digest design

Date: 2026-11-16. Still on the TEST bot (@justatia_bot). Deployed (Worker version `94822f90`),
pushed (commits `f3ab08b` part A, `08fc3a7` part B, and the docs commit). Cost: still $0, no card.
One Gemini call was used for a translation sample (free tier).

## Part A: small changes

**"на Украине" in Russian.**
- The topic is now "Война на Украине" everywhere (digest, Mini App, bot replies).
- The translation prompt says: Ukraine always takes на (на Украине, на Украину, с Украины).
- The translation check now rejects "в Украине", "во Украине" and "в Украину" in Russian. A
  rejected story is translated again the next hour, with the reason given to the AI.
- Two Russian translations already stored with "в Украине" were marked for redo; the next hourly
  run translates them again with the new rule.

**Support Axiom.**
- No expand button any more. At the bottom of Settings: the short text, then three buttons:
  100, 500 and 1000 Stars. `/support` shows the same three buttons in one row.
- The 1-Star test amount is gone everywhere, also on the server: 1, 50 and 250 are refused for
  everyone, you included.

## What Telegram allows today (Bot API 10.4, 9 Nov 2026)

- **Normal messages (HTML):** bold, italic, underline, strikethrough, spoiler, links, code,
  quotes, quotes that open on tap ("expandable"), dates shown in the reader's own time format. At
  most 4,096 characters. Buttons can sit under a message (one opens the Mini App). Link previews
  can be switched off. Custom emoji need a paid Fragment username (skipped, as you said).
- **Rich messages (new since June 2026, `sendRichMessage`):** real headings, paragraphs, quote
  boxes, dividers, lists, tables (cells can be centred), collapsible sections, images, and buttons.
  Up to 32,768 characters and 500 blocks; Telegram's blog says it shows "Show more" only after
  about 8,000 characters.
- **Platform support:** Telegram does not list which apps show rich messages. It says an outdated
  app shows an "update the app" placeholder for new features. Your Android phone shows them well;
  iPhone and Desktop were not checked.

## The designs

Same 10 real stories from today (all six topics), sent to you on the TEST bot, each labelled.

| Round | Design | What it was |
|---|---|---|
| 1 | A | today's format (numbers, underlined headings, outlet on its own line) |
| 1 | B | clean list: headline as the link, " · Outlet" in italics, description below |
| 1 | C | cards: description and outlet inside a quote |
| 1 | D | headlines first, description in a quote you tap to open |
| 1 | E | a rich message with headings and dividers |
| 2 | E1-E4 | rich variants: headings with the topic emoji, 2-3 emojis per story, outlet placed differently |
| 3 | E5 | E2 (divider, big heading, outlet after the title) with the description in a quote box |
| 4 | E5a-E5d | the topic title as a pull quote, a centred box, the biggest heading, or between two lines |
| 5 | E5e | the centred box, plain bold headline, the outlet is the link |
| 6 | **E5f** | E5e with a divider line between topics |

B and C in round 1, and E1, E5 and E5e/E5f later, were also sent in Russian.

## Your choice: E5f

- A rich message. First line: "**Good evening, Rob** · 6 stories since 2 PM" (Russian:
  "**Добрый вечер, Rob** · 6 историй с 14:00").
- Each topic in a centred box with its emoji (for example "🇺🇦 Ukraine War"), a divider line
  between topics.
- Each story: the editor's 2-3 emojis, the headline in bold, " · Outlet" in italics as the link,
  then the description in a quote box. No numbers.
- The quiet note is the same first line: "**Good evening, Rob** · Quiet period: nothing important
  on your topics since 2 PM."
- A "⚙️ Settings" button under every digest and quiet note opens the Mini App ("⚙️ Настройки" in
  Russian). In English, Russian, Armenian and French.
- Still one message of at most 3,900 characters.

**Length counted the way Telegram counts it.** One piece of code now makes every part of the
digest, and the length cut measures exactly those parts. Checked against Telegram on every
preview: for normal messages, Telegram's own count of the text was **exactly** ours (7 of 7); for
rich messages, the text Telegram stored was exactly our count too (3,188 and 3,409 characters).
Telegram counts rich messages in Unicode characters, which can only be fewer than ours, so the cut
is exact or a few characters on the safe side.

## Tests

- **Worker: 185 tests pass** (171 before part B's new file; 14 new in `design.test.mjs`).
  **Python: 119 pass** (1 new). **Mini App click-through: 30 of 30** (2 new: the Support section
  open with 100, 500, 1000; the same amounts for you).
- New checks: 200 random digests in four languages never pass the limit; the length estimate is
  never under the real length and at most 3 characters over; every language shows the same
  design; no long dash anywhere (also when a story or outlet name has one); the editor's emojis in
  full; no numbers; a line only between topics; the Settings button on digests and quiet notes, in
  the reader's language; sent as a rich message with no automatic links.
- **Found by the new tests and fixed:** an outlet name with a long dash would have stopped a digest
  from being sent; outlet names are now cleaned like the other texts.

**Rules broken on purpose, all caught:**

| Broken on purpose | Tests that failed |
|---|---|
| Python check for "в Украине" switched off | 1 |
| topic back to "Война в Украине" / a Russian text with "в Украине" | 5 / 1 |
| the 1-Star amount back / the old amounts back / /support in three rows | 3 / 4 / 1 |
| length estimate 5 characters short per story | 2 |
| length limit ignored | 7 |
| only one emoji per story | 8 |
| story numbers back | 11 |
| divider before the first topic too | 9 |
| sent as a plain message instead of a rich one | 14 |
| Settings button dropped / always in English | 7 / 8 |
| a long dash in a Russian digest text | 19 |
| outlet name not cleaned | 1 |
| description outside the quote box | 6 |

## Live checks (deployed Worker)

All 5 passed (`worker/scripts/step11-live-check.mjs`): "Send me a digest now" sent from the Worker
as a rich message (a quiet note, as nothing was new since your 18:00 digest); the Mini App lists
100, 500, 1000; 1 and 50 Stars are refused for you; 1000 gives a payment link (nothing paid).

## CPU (10 ms limit)

- **Digest build on this PC** (800 digests from today's full pools, three runs): before English
  0.49 to 0.53 ms, Russian 0.66 to 0.74 ms; after English 0.49 to 0.55 ms, Russian 0.70 to 0.76 ms.
  No real change.
- **On Cloudflare:** "Send me a digest now" took **3 ms** on a warm Worker; the first request of a
  new Worker instance took 7 to 8 ms (loading the code, the known cold start from Step 3); the
  hourly tick 7 ms; a 5-minute tick with no digest due 6 ms (Step 10 measured 3 ms for the same
  kind of tick; cron runs often start a fresh instance, which includes loading the code). A tick
  that sends a real digest was not seen yet (the next one is the other user's at 21:00 Yerevan).
  All under 10 ms, but a fresh instance that also sends several digests could get close: watch
  Cloudflare's Metrics for `exceededCpu` (already a known issue).

## Other fixes

- `digest-cli.mjs` ignored its defaults when a flag was missing (`--lang`, `--profile`); fixed.
  It now previews and sends the real rich digest with the button.
- The fold test (`fold-test.mjs`) keeps the old plain format, which is what it tests.

## Risks

- **Outdated Telegram apps** may show "update the app" instead of the digest. Ask new readers to
  keep Telegram updated. Going back to the old plain format is a one-line change (`LAYOUT` in
  `worker/src/digest.js`).
- **iPhone and Desktop** were not seen with rich messages.
- **There are now two users**, both reading Russian; the other user gets the new format from
  their next digest.

## Files
- **New:** `worker/test/design.test.mjs`, `worker/scripts/step11-designs.mjs` (the previews),
  `worker/scripts/step11-live-check.mjs`, this report.
- **Changed:** `worker/src/digest.js`, `cron.js`, `index.js`, `telegram.js`, `tips.js`, `bot.js`,
  `api.js`, `worker/public/app/` (Support section), `config/i18n/*.json`, `config/topics.yaml`,
  `prompts/translate.md`, `job/translate.py`, tests, `digest-cli.mjs`, `fold-test.mjs`,
  `step9-previews.mjs`, `step10-live-check.mjs`, `ui-check.mjs`, `dev-server.mjs`, `PROJECT_NOTES.md`.

## What you need to do
Nothing. If anyone you invite has an iPhone, a look at one digest would close the last gap.
