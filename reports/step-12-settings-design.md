# Step 12: the Settings redesign

Date: 2026-11-16. Still on the TEST bot (@justatia_bot). Cost: still $0, no card, no AI calls.
Commits: `4da55e5` (the three designs, live for your pick) and the final commit with this report.
Deployed: Worker version `afb0ac12` (the trial), then `f10dfedb` (the final design).

## What you asked for, and what was done

1. **Helper texts removed.** Under Topics, Times, Language, Time zone, Pause and Support, and
   "Changes are saved as soon as you make them": all gone. The only small text left is the time
   zone line at the bottom. The words were removed from all four dictionaries too.
2. **No "Saved" message.** A saved change gives one light vibration (Telegram
   `impactOccurred("light")`). Errors still show, short, in a calm grey bubble (for example "Up to
   5 times a day. Remove one first.").
3. **Language** is now two buttons like the times, each with its flag: 🇬🇧 English, 🇷🇺 Русский
   (🇦🇲 Հայերեն and 🇫🇷 Français appear the same way when switched on). The chosen one is red.
   Flags live in `config/languages.json`.
4. **Support Axiom:** the title and the 100 / 500 / 1000 ⭐ buttons, no text. /terms and
   /paysupport stay in the bot.
5. **Time zone:** no row any more. One quiet line at the very bottom, "Yerevan · GMT+4"
   ("Ереван · GMT+4" in Russian). Still taken from the phone on every open.
6. **One size everywhere:** every row and button is 48 px high (tap targets well over 44 px),
   every card and button has 12 px corners, every gap is 8 px. The button grids share six
   columns: a time takes 1, a tip 2, a language 3, so all columns line up. The 18 times are now a
   6 x 3 grid: one row each for morning, afternoon and evening.

Also: iOS colours (light #f2f2f7 with white cards, dark #000 with #1c1c1e cards), the iOS
system font, small sentence-case section titles in grey, hairline separators, short smooth
motion (off when the phone asks for reduced motion). The page follows Telegram's light or dark
mode, and Telegram's header, background and bottom bar are set to the page's exact colour, so
no edge shows a different grey (Telegram 6.9 and newer; older apps keep their own header colour).
The "Next digest" card is cleaner: a red clock square, "Next digest", "Today at 20:00".

## The three versions (live on the TEST bot with an owner-only switch)

Screenshots, 390 px wide, light and dark, English and Russian, in `reports/data/step-12/`:

| Version | What it was | Files |
|---|---|---|
| 1. iOS Settings | white cards on grey; each topic row has a small coloured square with its emoji and a red switch; pause the same | `design1-{light,dark}-{en,ru}.png` |
| 2. Pure minimal | a plain white (dark: black) page, no squares, emoji only, red check marks, more space | `design2-{light,dark}-{en,ru}.png` |
| 3. All buttons | topics and pause also buttons (red when on), so the page is one component | `design3-{light,dark}-{en,ru}.png` |

## Your choice: design 1

Built as it was, with no mixing. The switch and designs 2 and 3 are removed from the code.
Final screenshots: `reports/data/step-12/final-settings-{light,dark}-{en,ru}.png` and
`final-admin-{light,dark}.png`; `docs/screenshots/` is refreshed too.

**Admin** keeps all its content and texts. Style only: the same cards, rows of at least 48 px,
corners and section titles; the two action rows now have solid red squares with white icons (like
the Next digest card), and the health line has a solid square too (green with a check, amber or
orange with "!", never the brand red).

## Plan for "My topics" (next step, not built)

A second card right under **Topics**, titled **My topics**, made of the same rows:

- **Each custom topic is a row** (48 px): a small grey square with 📌, the topic as typed (one
  line, cut with "..." if long), and on the right a round grey "x" (drawn 22 px, tap area 44 px).
  Tapping "x" removes it at once with the light vibration; no confirm, no toast. Custom topics have
  no switch: they are on while they exist.
- **The last row adds one:** a solid red square with a white "+", then a text field in the same
  row ("Add a topic", 17 px text so iPhones do not zoom). An **Add** word in red appears on the
  right once something is typed; the keyboard's Enter does the same. After Add, the new row slides
  in above and the field clears.
- **Limit 3:** when there are 3, the add row disappears; nothing else changes. Errors (too short,
  already there, server refused) use the same short grey bubble as today.
- **Spacing:** nothing new: 48 px rows, 12 px card corners, hairlines from the text, 28 px between
  sections, section title in grey. Russian placeholder "Добавить тему" fits at 360 px.
- The click-through then gets: add, remove, the limit of 3, Enter, and the layout rules on the
  new card at 360 and 430 px.

## Tests

- **Worker unit tests: 185 pass.** Two changed: the Russian "сводка" test now checks other strings
  (the removed "times summary" was one of them), and the tips text list no longer has the removed
  Support text. The dictionary key test passes (every key in every language).
- **Python: 119 pass.**
- **Mini App click-through (`ui-check.mjs`): 47 of 47.** New or rewritten checks: no helper
  text (the only paragraph is the time zone line, last on the page); a save gives exactly one light
  vibration and no message (topic, time, pause, language); language buttons with flags, the chosen
  one red; the time zone line "City · GMT+n" and no row; Support is the title plus three buttons;
  Telegram's header, background and bottom bar match the page (light and dark); every row and
  button 48 px, one corner size, all grid buttons on the six shared columns, every tap target 44 px
  or more, no text cut off, no sideways scroll; all of that at **360 and 430 px in English and
  Russian, light and dark**; no design switch; Admin in the same style.
- The local preview got a reset (`POST /__reset`), so the click-through no longer needs a freshly
  started preview.

**Rules broken on purpose, all caught** (each run against the final version):

| Broken on purpose | Checks that failed |
|---|---|
| a "Saved" message after every save | 4 |
| no vibration on a save | 3 |
| a helper text back under Topics | 10 |
| language buttons without flags | 1 |
| no time zone line | 12 |
| the Support text back | 11 |
| tip buttons 44 px high (not the common 48) | 10 |
| a wider gap in one grid (columns no longer line up) | 10 |
| time buttons 40 px high (under 44) | 11 |
| Telegram's header left at its own grey | 2 |
| long topic names cut short (Russian at 360 px) | 4 |
| Admin action squares pale again | 1 |

## Page size

| File | Before | After |
|---|---|---|
| app.css | 16,037 B | 16,643 B |
| app.js | 37,410 B | 37,486 B |
| i18n.js | 19,514 B | 14,003 B |
| index.html | 885 B | 885 B |
| **Total** | **73,846 B (23.8 KB compressed)** | **69,017 B (22.6 KB compressed)** |

About 4.8 KB smaller, mostly the removed helper texts in four languages. During the trial (all
three designs in the code) it was 72,946 B.

## CPU

No Worker code changed in this step (`worker/src/` is untouched), so every Mini App API call costs
what it did (open 3-6 ms, save 1-5 ms, measured in Step 4; all under 10 ms). The live API check
was run again after the deploy (see below).

## Deploy

Deployed (version `f10dfedb`) and checked live: the page is served with `no-store`; the CSS, JS
and dictionary files carry the same content hashes as on this PC; the served JS has no design
switch. **Live API check (`api-check.mjs`): 9 of 9 pass** (open as owner, a real time change saved
in D1 and put back, next digest matches D1, a half-hour time and a removed setting refused, Admin
200 for you and 403 for anyone else, a tampered signature 401).

One side effect, undone: the live check opens the app from this PC, which saved this PC's zone
(Asia/Yerevan) over yours (Asia/Dubai). Both are GMT+4, so no digest time moved; your zone was
put back in D1 right away, and your phone sets it again on your next open anyway.

## Files

- **Changed:** `worker/public/app/` (app.css, app.js, i18n.js, index.html), `config/i18n/*.json`
  (helper texts out, `zone_line` in), `config/languages.json` (flags), `worker/scripts/stamp-app.mjs`
  (flags into i18n.js), `ui-check.mjs`, `dev-server.mjs` (reset), `test/i18n.test.mjs`,
  `test/tips.test.mjs`, `docs/screenshots/`, `PROJECT_NOTES.md`.
- **New:** `worker/scripts/step12-screenshots.mjs`, `worker/scripts/step12-message.mjs` (the
  message to you on the TEST bot), `reports/data/step-12/` (18 screenshots), this report.

## What you need to do

Nothing. If anyone you invite has an iPhone, one look at Settings would close the last gap (it was
checked in a desktop browser with a stand-in for Telegram; iPhone was not seen).
