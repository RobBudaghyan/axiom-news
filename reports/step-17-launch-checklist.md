# Step 17 Part 2: launch checklist (2026-11-20)

Nothing here changes production. The switch itself (Part 3) starts only after the owner says "go".

## Ready (checked 2026-11-20, about 05:00 UTC)

| # | Item | State |
|---|---|---|
| 1 | Hourly job on production | last 24 h: 22 runs ok, 2 partial (Gemini 503s, items retried next run), none failed |
| 2 | Editor | fixed and shipped 04:40 UTC (one big event kept, 45 stories a call, left-out stories wait). Before: the second call failed 6 times a run since 02:07, the longest run took 15 min |
| 3 | Database (D1) | yesterday 96.7k writes (one-offs) and 2.42M reads; projected about 31k to 39k writes a day (31% to 39%) with the feed change; the 80% alert and the Admin "Free limit used" line work |
| 4 | Feeds | 117 on (6 noisy feeds off), tass_ru, ria, rg, izvestia at 4 a run (shipped 04:40 UTC) |
| 5 | Production secrets | 8 Worker secrets set (incl. the analytics token); GitHub job secrets set |
| 6 | Fly.io | the owner deleted the whole account: nothing to clean up |
| 7 | Staging keeps the TEST bot | the TEST token is now also in `.env.staging`, so `.env` can take the real token without moving staging. `point-bot.mjs` and `setup-bot.mjs` refuse the TEST bot on production and any other bot on staging (checked both ways) |
| 8 | Texts, welcome animation, loading screen (Step 17b) | on staging and the TEST bot; deployed to production with the switch |
| 9 | Invite texts (English, Russian) | ready, in `reports/step-17b-branding.md` |

## Found today, handled in the switch
- `.env` (production's values) still holds the TEST bot's token: production's alerts go through @justatia_bot
  today. The switch puts the real token in `.env`.
- Production users: 3 (Rob, Ashot, and one shown as a flag). Owner: keep only Rob. The other two are deleted
  on production with all their rows (`sent`, `digest_holds`, `custom_follows`, `feedback`,
  `announcement_sends`, `topic_checks`); staging keeps its own copy. Production has 291 `sent` rows and
  4 custom follows today.
- `drop_pending_updates` stays off: a few old /start messages to @axiom_news_bot from the Fly.io days may
  arrive once (a welcome each, harmless).

## Waiting on the owner before "go"
1. Step 17b: your OK on the branding after checking on your phone (TEST bot), or what to change.
2. The real bot's token: BotFather > /mybots > @axiom_news_bot > API Token. Put it in `.env` as
   `TELEGRAM_BOT_TOKEN=...` yourself (replace the TEST one). Never in chat. (Revoke it first if the old
   Fly.io copy might still have it.)
3. Say "go".

## The switch (Part 3, after "go")
1. Check the token: `getMe` must answer @axiom_news_bot (the scripts refuse the TEST bot).
2. `set_secrets.py worker-prod` (the real token as production's secret).
3. `USER_SENDS = "on"` for production in `wrangler.toml`; deploy staging (same code), then
   `SHIP_IT=yes npm run deploy:prod`.
4. `node scripts/point-bot.mjs` and `node scripts/setup-bot.mjs` (production): webhook, menu button,
   commands, descriptions in en and ru, read back.
5. Delete the two other users on production (keep Rob).
6. You: BotFather steps 1 to 8 (`reports/step-17b-branding.md`): description animation, photo, Main Mini
   App, Full size, splash icon and colours, previews.
7. You, from another account: empty chat, profile, Start, welcome with animation, setup, sample digest.
   Me: the first digests, ticks under 10 ms CPU, D1 numbers.
8. You send the invites.
