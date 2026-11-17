"""Google News RSS search feeds, the source of custom topics (Step 13; first tried in Step 6).

    https://news.google.com/rss/search?q=<query> when:2h&hl=en-US&gl=US&ceid=US:en

What a feed gives (checked 2026-11-14): up to 100 items; each has a title "Headline - Outlet",
a news.google.com/rss/articles/<id> link (not the article URL), a pubDate, a <source url=...>
with the outlet's name and home page, and a description that only repeats the title and outlet
(no snippet). The feed's own copyright notice limits use to "a personal feed reader for personal,
non-commercial use" (see the Step 6 report).

The real article URL needs two more requests per link (resolve()): the article page gives a
signature and timestamp, then Google's batchexecute endpoint returns the URL. About 1.5 s per
link, so it is meant only for the few stories that would reach a digest.
"""
from __future__ import annotations

import calendar
import json
import math
import re
import time
import unicodedata
from dataclasses import dataclass
from urllib.parse import quote, quote_plus

import feedparser
import requests

from job.fetch import USER_AGENT, clean_text

SEARCH = "https://news.google.com/rss/search"
ARTICLE = "https://news.google.com/rss/articles/"
BATCH = "https://news.google.com/_/DotsSplashUi/data/batchexecute"


def search_url(q: str, hl: str, gl: str, ceid: str, window: str | None = None) -> str:
    text = f"{q} when:{window}" if window else q
    return f"{SEARCH}?q={quote_plus(text)}&hl={hl}&gl={gl}&ceid={quote(ceid, safe='')}"


@dataclass
class GItem:
    guid: str            # Google's article id (stable for one article URL)
    title: str           # headline without the " - Outlet" suffix
    source: str          # outlet name
    source_url: str      # outlet home page, e.g. https://jam-news.net
    link: str            # news.google.com/rss/articles/... link
    published_at: int | None
    has_snippet: bool    # does the description say anything beyond the title and outlet?


def split_title(title: str, source: str) -> str:
    for sep in (" - ", " – ", " — ", " | "):
        if source and title.endswith(sep + source):
            return title[: -len(sep + source)].strip()
    return title.strip()


def parse(content: bytes) -> list[GItem]:
    feed = feedparser.parse(content)
    out = []
    for e in feed.entries:
        link = str(e.get("link", ""))
        src = e.get("source") or {}
        source = clean_text(src.get("title") if hasattr(src, "get") else "") or ""
        source_url = (src.get("href") or src.get("url") or "") if hasattr(src, "get") else ""
        raw_title = clean_text(e.get("title"))
        if not link or not raw_title:
            continue
        title = split_title(raw_title, source)
        desc = clean_text(e.get("summary") or e.get("description") or "")
        rest = desc.replace(raw_title, "").replace(title, "").replace(source, "").strip(" \xa0-")
        parsed = e.get("published_parsed")
        guid = str(e.get("id") or "") or link.split("/articles/")[-1].split("?")[0]
        out.append(GItem(guid=guid, title=title[:300], source=source[:120], source_url=source_url,
                         link=link, published_at=int(calendar.timegm(parsed)) if parsed else None,
                         has_snippet=len(rest) > 20))
    return out


@dataclass
class Fetched:
    query: dict
    items: list[GItem]
    status: int | None
    ms: int
    error: str | None = None


def fetch(query: dict, window: str | None, *, timeout: float,
          session: requests.Session | None = None) -> Fetched:
    url = search_url(query["q"], query["hl"], query["gl"], query["ceid"], window)
    t = time.time()
    try:
        resp = (session or requests).get(url, timeout=timeout, headers={"User-Agent": USER_AGENT})
    except requests.RequestException as exc:
        return Fetched(query, [], None, int((time.time() - t) * 1000), f"fetch error: {type(exc).__name__}")
    ms = int((time.time() - t) * 1000)
    if resp.status_code != 200:
        return Fetched(query, [], resp.status_code, ms, f"HTTP {resp.status_code}")
    try:
        return Fetched(query, parse(resp.content), 200, ms)
    except Exception as exc:
        return Fetched(query, [], 200, ms, f"parse error: {type(exc).__name__}")


def resolve(link: str, *, session: requests.Session | None = None, timeout: float = 15) -> str:
    """The real article URL behind a news.google.com/rss/articles/<id> link (2 requests).
    Raises ValueError if Google's page or answer has changed shape."""
    s = session or requests.Session()
    aid = link.split("/articles/")[1].split("?")[0]
    page = s.get(ARTICLE + aid, timeout=timeout, headers={"User-Agent": USER_AGENT}).text
    sg = re.search(r'data-n-a-sg="([^"]+)"', page)
    ts = re.search(r'data-n-a-ts="([^"]+)"', page)
    if not (sg and ts):
        raise ValueError("article page without signature")
    inner = ["Fbv4je", '["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,'
             'null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],'
             f'"{aid}",{ts.group(1)},"{sg.group(1)}"]']
    resp = s.post(BATCH, data="f.req=" + quote(json.dumps([[inner]])), timeout=timeout,
                  headers={"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
                           "User-Agent": USER_AGENT})
    try:
        parsed = json.loads(resp.text.split("\n\n")[1])[:-2]
        url = json.loads(parsed[0][2])[1]
    except (IndexError, ValueError, TypeError) as exc:
        raise ValueError(f"unexpected batchexecute answer (HTTP {resp.status_code})") from exc
    if not str(url).startswith("http"):
        raise ValueError("no URL in answer")
    return url


# ---------------------------------------------------------------- title similarity (no AI)

STOP = set((
    "the a an and or but of to in on at for from by with as is are was were be been has have had its it "
    "this that these those their his her they them he she we you who which what when where after before "
    "over under amid against about into than then there here also not no new more most says said say "
    "will would could should may might can just one two first last year day week news live latest update "
    "video watch photos report reports according amid "
    "и в во не на с со что как по к из за от для о об до это его ее их он она они мы вы был была были "
    "будет при над под без так также уже ли же бы или но а то все этот эта эти году года день новости "
    "заявил заявила сообщил сообщила"
).split())
WORD = re.compile(r"\w+", re.U)


def tokens(text: str) -> set[str]:
    """Content words of a title: lower case, accents removed, stop words out, 5-letter stems.
    Works for Latin, Cyrillic and Armenian script (words are matched within one script)."""
    s = unicodedata.normalize("NFKD", text or "")
    s = "".join(ch for ch in s if not unicodedata.combining(ch)).lower().replace("ё", "е")
    return {w[:5] for w in WORD.findall(s) if len(w) >= 3 and w not in STOP and not w.isdigit()}


class TitleIndex:
    """Titles to compare against, with rarity weights (IDF) and an inverted index so one lookup
    only scores titles that share a word. Similarity = shared weight / the smaller title's weight."""

    def __init__(self, titles: list[tuple[object, str]]):
        self.keys = [k for k, _ in titles]
        self.maps = [tokens(t) for _, t in titles]
        df: dict[str, int] = {}
        for m in self.maps:
            for w in m:
                df[w] = df.get(w, 0) + 1
        n = max(1, len(self.maps))
        self.idf = {w: math.log(1 + n / d) for w, d in df.items()}
        self.default_idf = math.log(1 + n)
        self.totals = [self._weight(m) for m in self.maps]
        self.inv: dict[str, list[int]] = {}
        for i, m in enumerate(self.maps):
            for w in m:
                self.inv.setdefault(w, []).append(i)

    def _weight(self, m: set[str]) -> float:
        return sum(self.idf.get(w, self.default_idf) for w in m)

    def best(self, title: str) -> tuple[float, object | None]:
        m = tokens(title)
        if len(m) < 2:
            return 0.0, None
        mine = self._weight(m)
        cands: set[int] = set()
        for w in m:
            cands.update(self.inv.get(w, ()))
        best, key = 0.0, None
        for i in cands:
            shared = sum(self.idf.get(w, self.default_idf) for w in m & self.maps[i])
            lo = min(mine, self.totals[i])
            score = shared / lo if lo > 0 else 0.0
            if score > best:
                best, key = score, self.keys[i]
        return best, key

    def add(self, key: object, title: str) -> None:
        m = tokens(title)
        i = len(self.maps)
        self.keys.append(key)
        self.maps.append(m)
        self.totals.append(self._weight(m))
        for w in m:
            self.inv.setdefault(w, []).append(i)
