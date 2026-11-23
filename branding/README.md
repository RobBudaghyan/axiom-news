# Branding (Step 17b)

Everything is built in code: HTML, SVG and CSS rendered in headless Edge, then ffmpeg. No AI images,
no stock art. The logo is the existing Axiom News logo, rebuilt as a vector.

## Sources (`source/`)
| File | What it is |
|---|---|
| `build_logo.py` | Rebuilds the logo as outlined SVG from Montserrat ExtraBold, fitted to the original's measured geometry (`reference/original-profile-320.jpg`, the only copy that existed). Writes `logo.svg`, `logo-icon.svg` (rounded), `logo-lockup.svg` (bar and NEWS only), `logo-paths.json/.js` |
| `build_splash.py` | The splash icon for BotFather's Mini App loading screen: the rounded logo flattened into ONE `<path>` (skia-pathops), `out/splash-icon.svg` |
| `anim.html` | The one motion: the white bar draws from its left edge, AXIOM rises inside it, NEWS settles below. 3 s (description) or 2 s (welcome, `setup({short: true})`) |
| `preview.html` | Main Mini App previews for the bot profile, 1080x1920 |
| `card.html` | Share cards, 1080x1080 and 1080x1920 |
| `loading.html` | Check page: the Mini App's real loading markup and CSS, frozen at 1 s |
| `digest.js`, `data/digest-*.html` | A real digest from staging (dry run), shown as Telegram shows a rich message |
| `capture-app.mjs` | Real Mini App screenshots (`shots/`) from the local preview server |
| `render.mjs` | Renders stills and videos (jobs: logo, anim, welcome, cards, previews, loading) |
| `icons.mjs` | PNG icons with transparency (sharp) |
| `pick-emoji.mjs` | Copies the Twemoji SVGs the pages need into `emoji/` |
| `send-to-owner.mjs` | Sends the previews and files to the owner on the TEST bot (refuses any other bot) |
| `fonts/` | Inter (SIL OFL), for the pages. The logo needs no font: its letters are outlines |

## Rebuild
Tools outside the repo, fetched once into any scratch folder (all free):
`pip install --target <dir> fonttools brotli imageio-ffmpeg skia-pathops pillow`, `npm pack @fontsource/montserrat@5.1.0`,
`npm pack @twemoji/svg@15.0.0`.
```
python branding/source/build_logo.py <montserrat>/files/montserrat-latin-800-normal.woff2
python branding/source/build_splash.py <montserrat>/files/montserrat-latin-800-normal.woff2
node worker/scripts/dev-server.mjs            (another terminal; for capture-app only)
node branding/source/capture-app.mjs
node branding/source/pick-emoji.mjs <twemoji>/package
FFMPEG=<ffmpeg.exe> node branding/source/render.mjs all
node branding/source/icons.mjs
```
After changing the welcome animation, copy `out/welcome-1280x720.mp4` to `worker/public/media/welcome.mp4`.

## Outputs (`out/`)
| File | Where it shows |
|---|---|
| `description-640x360.mp4` (also `-320x180.mp4`, `-640x360.png`) | BotFather, Edit Description Picture: the empty chat, before Start |
| `welcome-1280x720.mp4` = `worker/public/media/welcome.mp4` | Sent with the welcome (sendAnimation, by URL) |
| `profile-photo-1280.png` / `-640.png` | BotFather, Edit Botpic |
| `splash-icon.svg` (`splash-icon-512.png` to look at) | BotFather's Mini App loading screen (one path, as BotFather requires) |
| `loading-icon.svg` / `-512.png` / `-192.png` | The rounded logo with several shapes (BotFather refuses it for the splash; fine elsewhere) |
| `preview-{en,ru,fr,hy}-{setup,settings,digest}.png` | The bot profile's Main Mini App previews |
| `share-{en,ru,fr,hy}-1080x1080.png`, `-1080x1920.png` | For the owner to share |
| `frames/` | Checks: logo against the original, avatar sizes, motion contact sheets, loading screen |

Credits: Montserrat and Inter (SIL Open Font License), Twemoji graphics (CC BY 4.0, used only in the
rendered digest inside previews and cards).
