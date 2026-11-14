# Lessons from the old project that still apply

Condensed from the old project's `CLAUDE.md` "Known constraints" and `llm/provider.py`.
Only lessons that still matter for the v2 design are kept.

## AI (Gemini and fallback)

1. **Model names get retired without warning.** `gemini-2.0-flash`, `gemini-2.0-flash-lite`
   and `gemini-2.5-flash-lite` all started returning 404 at some point during the old
   project. Before changing `GEMINI_MODEL`, list the models through the API and make one real
   call to the candidate; appearing in the list does not mean it is callable. A sudden 404 is
   a retired model, not a code bug.
2. **Empty responses are errors, not "no news".** Gemini can return no text at all
   (safety filter, which war news trips occasionally, or truncation). The old code crashed
   on `None.strip()` in production. Check for missing text, raise an error that names the
   finish/block reason, and then fall back. Never treat it as an empty story list.
3. **Use structured output** (`response_mime_type=application/json` plus a schema) rather
   than asking for JSON in the prompt. Still strip a stray ``` fence before parsing.
4. **Accuracy rule.** Tell the model to use only the given text. It added stale background
   "facts" (it called the sitting US president "former president"). A dated list of current
   facts in the prompt fixed this; it has to be reviewed when facts change.
5. **Bias toward keeping real news.** A missed story hurts more than a borderline one. Keep
   the calibration examples (ceremonial visit = not news; developing security incident = news;
   regional spillover belongs to the conflict's topic).
6. **Dedup must be semantic** ("same concrete event"), not word overlap. Different events
   involving the same countries or people are not duplicates.
7. **Topic definitions matter.** A bare label caused wrong tags (an unrelated Turkish
   military story got tagged with an Armenia defence topic). Every topic carries a short
   definition with at least one near-miss that does not count.
8. **Lighter models drop secondary tags.** `gemini-3.1-flash-lite` sometimes left out a
   broader tag (politics, wars_conflicts) next to a specific one in 4 of 10 old test samples.
   The v2 prompt asks for every applicable tag, and the job code can add `wars_conflicts`
   automatically whenever `ukraine_war` or `iran_war` is present.
9. **Source volume drives AI load.** The old bot made one AI call per post and a few busy
   sources caused a real cost spike. v2 batches everything into one call per hour, so the
   number of calls is fixed. Input size still grows with volume, so cap items per feed per
   run and send short snippets.
10. **Gemini context caching needs at least 1024 tokens of cached content.** The prompt
    prefix was too small for it to be worth it. Don't rely on caching.

## Telegram / Mini App

11. **One consumer per bot token.** Two processes polling `getUpdates` with the same token
    fought each other for 41 minutes in production. v2 uses a webhook only. Never run a
    local poller against the live bot's token; that is what the separate TEST bot is for.
12. **Telegram's Mini App WebView caches static files aggressively.** Serve `index.html`
    with `Cache-Control: no-store` and put a version or hash in the asset URLs. If "my change
    doesn't show up" happens, first compare the bytes actually being served before
    debugging code.
13. **Mini App colours:** take surface and text colours from Telegram's theme
    (`bg_color`, `secondary_bg_color`, `text_color`, `hint_color`) so light and dark both
    work. Keep the accent colour (buttons, toggles) fixed. Mapping Telegram's
    `button_color`/`link_color` caused two visual incidents.
14. **Some user info is only available during a live interaction.** The Bot API cannot later
    fetch a user's `language_code` or premium status. Save what you need (name, language)
    from the webhook update or Mini App `initData` when it arrives.
15. **Media groups cannot carry inline buttons.** This doesn't matter for text digests, but
    don't plan features around it.

## Data / operations

16. **Every per-user table must be cleaned up when an account is reset or deleted.** A new
    table with a foreign key to `users` broke Reset in production the first time a real
    user had a row in it. When adding a per-user table, update the delete/reset code in the
    same change.
17. **Never hard-code secrets.** `.env` locally, platform secrets in production.
18. **Windows encoding.** On the owner's Windows PC, Python's subprocess and console use
    cp1252 by default and crashed on emoji or checkmarks. Use `encoding="utf-8"` explicitly
    and reconfigure stdout to UTF-8 in scripts that print non-ASCII (feed names in Russian or
    Armenian).
19. **Test background-job branches for real.** A retry worker had its keep/delete branches
    inverted and silently lost posts, and it was found only by accident. Retry and "pending
    items" logic needs an actual test, not just a code read.
20. **Keep README current.** The old README drifted badly out of date. In v2 it stays short
    and is checked at the end of every step.
21. **Verify platform facts against the real thing** (library source, live API, official
    docs) rather than memory, and record the date of checking.

## Learned in v2 (Step 3)

22. **Measure Worker CPU on Cloudflare itself, not in Node.** `wrangler tail --format json`
    reports `cpuTime` per invocation. Node on the PC was misleading in both directions: a cold
    time-zone lookup cost 10-17 ms in Node but 1-3 ms on Cloudflare, while a pairwise duplicate
    check that took 0.2 ms in Node cost several ms on a cold Worker. Heavy work belongs in the
    GitHub job, which has no CPU limit.
23. **Never pipe a safety check into another command in a chain.** `scan | tail -1 && git push`
    pushed even though the scan failed, because the pipe's exit code is `tail`'s. Run the check
    on its own (or with `set -o pipefail`) and push only after it exits 0.

## Learned in v2 (Step 4)

24. **Check the diff after every scripted text edit.** Some files here have Windows line endings
    (CRLF). A find-and-replace that assumed `\n` silently changed nothing, twice; once it left the
    job without its new feed-health code until a test caught it. Read `git diff` (or let a test
    fail) before trusting an edit made by a script.
25. **Windows shows flag emoji as letters** ("AM", "RU"); phones show flags. A screenshot taken on
    the PC is not what users see. The local preview loads a flag-only font for that reason; the
    real Mini App uses the phone's own emoji.
26. **A Worker instance cannot be trusted to live until the next tick.** A counter that was only
    written "at the next cron tick in the same instance" was missing after the first tick on
    Cloudflare, because that tick ran in a fresh instance. Write per invocation.

## Learned in v2 (Step 5)

27. **An AI editor anchors on any score you show it.** With the first-pass score in the prompt, the
    editor kept it for almost every story (every 7 stayed a 7). Hiding it made the scores
    independent and much stricter. Show the model the evidence (titles, snippets), not an earlier
    verdict.
28. **"Leave it empty to keep it" needs code that keeps it field by field.** The editor repeated an
    already-edited headline but left its emojis and description empty, and the code wiped them.
    A new value should replace an old one only when it is non-empty and valid.
29. **Guard against roundups in every merge step.** Once in about ten answers the model put dozens
    of unrelated stories into one "various developments" event. A hard cap on the size of one
    event (6 stories) plus "retry if under half the candidates are covered" catches it.
30. **Measure "it looks off" before guessing.** The Mini App's icons sat 6 px low. Measuring the
    drawn icon against its square in headless Edge found the cause in minutes: the Admin tab's
    stat boxes and the icon squares shared the CSS class name `tile`, so the icons got the stat
    boxes' padding. Keep class names unique per component.
31. **A check script must not write made-up identity data.** `api-check.mjs` opened the app as the
    owner with the name "Owner", and opening the app saves the Telegram first name, so the real
    name was overwritten and one preview digest greeted "Owner". Sign test requests with the
    values already stored.
32. **Piping a command into `head` does not stop it.** `script --preview | head -4` still sent the
    Telegram message after `head` had exited. Never pipe a command that has side effects just to
    shorten its output.
