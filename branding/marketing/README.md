# Axiom News marketing kit

Everything here is made in code: HTML, SVG and CSS scenes rendered frame by frame in headless Edge,
then ffmpeg. No AI images, no stock art, no phone frames. The logo is the vector logo from
`branding/source`. The digest is a real one: a dry preview from staging on 23 Nov 2026 (stories
copied from production, nothing sent or recorded), with only the preview label and the first name
removed. The Settings screens are fresh screenshots of the real Mini App (local preview, demo data).

**To look at everything:** open `branding/marketing/review.html` in Chrome or Edge (double-click it in
File Explorer). The language switch (English, Русский, Français, Հայերեն) is at the top right.

## What each file is for

| Folder | Files | Where to post |
|---|---|---|
| `story/<length>/<look>/` | `axiom-story-<05s,08s,10s,15s,20s>-<red,light,dark>-<en,ru,fr,hy>.mp4`, a first-frame `.png` next to each | Instagram Stories (also Reels or a Telegram channel). 1080x1920, 60 fps, silent: add music inside Instagram. Text stays out of the top 250 px and bottom 340 px, so Instagram's name bar, reply field and stickers never cover it. |
| `feed/` | `axiom-post-<en,ru,fr,hy>-1080x1350.png` | A single Instagram post (portrait 4:5). |
| `feed/` | `axiom-carousel-<lang>-<1..4>-1080x1350.png` | A 4-slide Instagram carousel, in this order: logo; what you get; topics (the six main topics with Technology & AI, Formula 1 as a custom topic); times, the four languages in a 2x2 grid, link, Free. |
| `bot/` | `axiom-how-it-works-1280x720.mp4` (220 KB, 11 s, loops, no words) | **The welcome video** (Step 19): installed as `worker/public/media/welcome.mp4`. |
| `whats-new/` | `whats-new-1080x1350.png`, `whats-new-1080x1920.png`, `whats-new.html` | Announcing a new feature on Instagram (feed and Story) or in the channel. |
| `review.html` | | The page with all of the above. |
| `source/` | | The scenes and scripts (below). |

### The Story lengths
All lengths are their own edits of the same scenes; nothing is sped up.
- **5 s:** logo, a digest, end card with the link.
- **8 s:** logo, digest, "Your topics.", end card.
- **10 s:** logo, digest, topics, "Your times.", end card.
- **15 s:** logo, digest, topics, times, "Your language.", end card (logo, Axiom News, t.me/axiom_news_bot, Free).
- **20 s:** the same with calmer steps, and the real Settings screen scrolling before the end card.

The three looks: **red** (red background, white logo, like the share card), **light** (the Mini App in light
mode), **dark** (the Mini App in dark mode; there the digest card is dark too, as Telegram shows it in dark mode).

## The welcome video ("how it works")
Step 19 (owner): one 11 s clip, no words, loops cleanly. It opens with the logo animation (the same motion
as `branding/out/welcome-1280x720.mp4`), then a wide white Settings screen in the Mini App's style: the six
main topics and the custom Formula 1 switch on (two columns), three digest times are picked, a digest
arrives in the chat; it fades back to plain red, which is its first frame. Labels are soft bars, so the same
file works in every language. It is the welcome video for new readers: `worker/public/media/welcome.mp4`
(sent with `sendAnimation`, the welcome text as its caption; the URL carries `?v=19` so Telegram fetches the
new file). After a re-render, copy it there and raise `WELCOME_VERSION` in `worker/src/index.js`.

## Suggested Instagram captions

English:
> 📰 Axiom News is a Telegram bot that sends a short digest of the important news at the times you choose.
> 🗂 Politics, Economy, Technology & AI, Armenia, Iran, Ukraine, or topics of your own, like Stocks or Formula 1.
> 🕘 Choose when it arrives, up to five times a day.
> 🌐 Available in several languages. Free.
> 👉 t.me/axiom_news_bot

Shorter, for a Story or Reel:
> A short digest of the important news, at the times you choose. Free on Telegram 👉 t.me/axiom_news_bot

Russian:
> 📰 Axiom News: Telegram-бот, который присылает короткую сводку важных новостей в выбранное вами время.
> 🗂 Политика, Экономика, Технологии и ИИ, Армения, Иран, Украина или ваши собственные темы, например «Акции» или «Формула-1».
> 🕘 Выбирайте, когда она приходит: до пяти раз в день.
> 🌐 Доступно на нескольких языках. Бесплатно.
> 👉 t.me/axiom_news_bot

Короче, для Stories или Reels:
> Короткая сводка важных новостей в выбранное вами время. Бесплатно в Telegram 👉 t.me/axiom_news_bot

French:
> 📰 Axiom News est un bot Telegram qui envoie un court résumé de l'actualité importante, aux heures de votre choix.
> 🗂 Politique, Économie, Technologie et IA, Arménie, Iran, Ukraine, ou vos propres sujets, comme la Bourse ou la Formule 1.
> 🕘 Choisissez quand il arrive, jusqu'à cinq fois par jour.
> 🌐 Disponible en plusieurs langues. Gratuit.
> 👉 t.me/axiom_news_bot

Plus court, pour une Story ou un Reel :
> Un court résumé de l'actualité importante, aux heures de votre choix. Gratuit sur Telegram 👉 t.me/axiom_news_bot

Armenian:
> 📰 Axiom News-ը Telegram բոտ է, որը ձեր ընտրած ժամերին ուղարկում է կարևոր նորությունների կարճ ամփոփում։
> 🗂 Քաղաքականություն, Տնտեսություն, Տեխնոլոգիաներ և ԱԲ, Հայաստան, Իրան, Ուկրաինա կամ ձեր սեփական թեմաները, օրինակ՝ «Բաժնետոմսեր» կամ «Ֆորմուլա 1»։
> 🕘 Ընտրեք, թե երբ է այն գալիս՝ օրական մինչև հինգ անգամ։
> 🌐 Հասանելի է մի քանի լեզվով։ Անվճար։
> 👉 t.me/axiom_news_bot

Ավելի կարճ, Story-ի կամ Reel-ի համար.
> Կարևոր նորությունների կարճ ամփոփում՝ ձեր ընտրած ժամերին։ Անվճար Telegram-ում 👉 t.me/axiom_news_bot

For What's new (edit to the feature):
> ✨ New in Axiom News: Technology & AI is a main topic now, and the bot speaks French and Armenian too. 👉 t.me/axiom_news_bot
> ✨ Новое в Axiom News: новая основная тема «Технологии и ИИ», а ещё бот теперь говорит по-французски и по-армянски. 👉 t.me/axiom_news_bot
> ✨ Nouveau sur Axiom News : un nouveau sujet principal, Technologie et IA, et le bot parle désormais français et arménien. 👉 t.me/axiom_news_bot
> ✨ Նորություն Axiom News-ում. նոր հիմնական թեմա՝ «Տեխնոլոգիաներ և ԱԲ», իսկ բոտն այժմ խոսում է նաև ֆրանսերեն և հայերեն։ 👉 t.me/axiom_news_bot

## What's new card: change the text
Open `whats-new/whats-new.html` in a text editor and change the three lines at the top (`label`,
`title`, `text`), for example `label: "Новое"` for Russian. Then, from the project folder:
```
node branding/marketing/whats-new/render.mjs
```
It writes both sizes next to the HTML in a few seconds. Needs only Node and Edge (already on this PC).
An emoji in the text needs its picture in `source/emoji` (see `pick-emoji.mjs`).

## Re-render everything
Tools (free, outside the repo, once): ffmpeg (any build; `pip install --target <dir> imageio-ffmpeg` has one)
and, for new emoji, `npm pack @twemoji/svg@15.0.0`.

| Step | Command (from the project folder) |
|---|---|
| Fresh digest (dry, staging) | `cd worker`, `AXIOM_ENV=staging node scripts/digest-cli.mjs --preview --dry --lang en` (and `ru`, `fr`, `hy`; staging needs French and Armenian translations, so a reader of each language, or the job's Translator run once); save the `<p>...` line as `branding/marketing/source/data/digest-<lang>.html`. If staging is quiet, `venv/Scripts/python scripts/sync_staging.py --hours 48` first. |
| Fresh Settings shots | `PORT=8797 node worker/scripts/dev-server.mjs` in one terminal, then `node branding/marketing/source/capture-app.mjs` |
| Emoji | `node branding/marketing/source/pick-emoji.mjs <twemoji>/package` |
| Story videos | `FFMPEG=<ffmpeg.exe> node branding/marketing/source/render.mjs story` (all 30, about 20 min with 3 browsers), or filtered: `... story 15 red en` |
| Bot clip | `FFMPEG=<ffmpeg.exe> node branding/marketing/source/render.mjs bot` |
| Feed | `node branding/marketing/source/render.mjs feed` |
| Review page | `node branding/marketing/source/make-review.mjs` |

A single frame to look at: `node branding/marketing/source/render.mjs peek story.html '{"len":"15","look":"red","lang":"en"}' 7.5`
(PNG in the folder named by `CHECKS`, default a temp folder).

### Sources (`source/`)
| File | What it is |
|---|---|
| `kit.css`, `kit.js` | The three looks, the Mini App's components (rows, switches, button grid), the logo, the digest loader |
| `story.html` | The Story scenes and the five edits (timings at the top) |
| `howitworks.html` | The bot clip |
| `feed.html` | The feed post and carousel |
| `render.mjs` | Renders videos (frames piped into ffmpeg: H.264 High, CRF 16, 60 fps) and stills |
| `capture-app.mjs` | Fresh Mini App screenshots into `shots/` |
| `make-review.mjs` | Writes `review.html` with file sizes |
| `data/`, `shots/`, `emoji/` | The real digest, the Settings shots, Twemoji pictures |

Credits: Inter (SIL Open Font License), Twemoji graphics (CC BY 4.0), Montserrat in the logo outlines (SIL OFL).
