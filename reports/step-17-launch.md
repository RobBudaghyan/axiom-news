# Step 17: launch (2026-11-20)

Axiom News runs on the real bot **@axiom_news_bot** from 2026-11-20 08:41 UTC. Production sends to
readers (`USER_SENDS = "on"`); staging keeps the TEST bot @justatia_bot.

## What Step 17 did
- **D1 reads (Part 1):** missing indexes and queries that read the whole story pool; job reads per run
  about a third of before (Step 17 progress).
- **D1 writes (17c):** items written once, not-news items as hashes, fewer small writes, staging sync on
  demand; feeds trimmed (6 off, 4 Russian agencies at 4). Normal day projected at about 31k writes
  (31%), reads about 20% to 24% (`reports/step-17c-database-writes.md`).
- **Editor fix:** one big event (40 summit stories) is no longer refused; 45 stories a call; a run went
  from 367 s and 20 AI calls to 71 s and 5.
- **Branding (17b):** vector logo, welcome animation, loading screen, texts, BotFather files.
- **Delete user / Delete my data:** Admin's Delete on every row but the owner's; Help > "🗑 Delete my
  data" in every language; one batch removes every row about the person (tips stay anonymous); the next
  /start is a brand-new user. Readers who block the bot are marked blocked at once (`my_chat_member`).
- **Owner's last changes:** the welcome has one line about Axiom News; the sample digest after the setup
  has no label, opens with "Good evening, Rob · here is what happened in the last 24 hours" and holds at
  most 8 stories, 2 a topic (`config/digest.json`).

## The switch (owner's "ship all of this and proceed with switch", 2026-11-20)
1. Staging deployed and checked first (api-check 9 PASS; tests: Worker 322, Python 177).
2. Production users: Ashot and the second test user deleted with all their data
   (`worker/scripts/delete-user.mjs --all-but-owner`, the same statements as Admin). Only Rob is left.
3. `set_secrets.py worker-prod`: the real bot's token (from `.env`, revoked and new) as production's secret.
4. `SHIP_IT=yes npm run deploy:prod` (guard passed: the same code as staging), Worker 1d95b3e4.
5. `point-bot.mjs`: @axiom_news_bot -> production, with message, callback_query, pre_checkout_query and
   my_chat_member; Rob's chat menu points at production's Mini App. `setup-bot.mjs`: menu button, commands
   and descriptions in English and Russian, read back. It also set the English description from our
   texts (the same Step 17b text the advisor used).
6. Checked after: the Mini App and the welcome animation are served (200); cron ticks ok at 2 ms CPU;
   staging still points at @justatia_bot. The TEST token stays in `.env.staging`; the bot scripts refuse
   the TEST bot on production.

## For the owner
- Send /start to @axiom_news_bot once (you get "welcome back": your production settings are kept, Russian,
  next digest 14:00 UTC). If the real bot had never talked to you, the first digest would fail and mark
  you blocked; /start clears that.
- The profile previews in BotFather are still yours to add (files in `branding/out/`).
- Fly.io: you deleted the whole account; nothing left.
- Watch the first days: Admin "Free limit used", digests to new readers, Worker CPU (Admin shows runs
  over the limit).

## Invite messages
English:
> 📰 I have launched Axiom News, a Telegram bot that sends a short digest of the important news at the times you choose.
> 🗂 You pick the topics, including your own.
> 🌐 Available in several languages.
> 👉 t.me/axiom_news_bot

Russian:
> 📰 Я запустил Axiom News: это Telegram-бот, который присылает короткую сводку важных новостей в выбранное вами время.
> 🗂 Темы выбираете вы, включая свои собственные.
> 🌐 Доступно на нескольких языках.
> 👉 t.me/axiom_news_bot
