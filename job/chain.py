"""Step 20: a resilient AI chain, so readers never notice an outage.

    free Gemini models, each on its own   (a 503 is retried with backoff while the run's retry time lasts)
    -> Groq, several models in rotation   (each model has its own per-minute limit)
    -> the paid emergency key             (ONLY when every free option failed for that call, hard caps)

Translations use only the strong models (free, then the emergency key); never Groq. The prices,
caps and model lists are in config/ai_budget.json; worker/src/spend.js has the same caps and prices
for the Worker's topic check.
"""
from __future__ import annotations

import calendar
import time
from typing import Callable

from job.ai import AIError, CallResult, GeminiProvider, GroqProvider, KeyState, RetryBudget, estimate_tokens  # noqa: F401


class GroqPool:
    """Several Groq models in rotation. Each model has its own per-minute token limit, so the pool
    uses the one with room now instead of sleeping; a 429 or a 5xx moves on to the next model; a
    daily limit (a long retry-after) takes that model out for the run. Looks like one provider
    (name 'groq'); `model` is the model of the last call."""
    name = "groq"

    def __init__(self, members: list[GroqProvider], sleep: Callable[[float], None] = time.sleep,
                 clock: Callable[[], float] = time.monotonic):
        assert members
        self.members = members
        self.sleep = sleep
        self.clock = clock
        self.current = members[0]
        self.busy_until: dict[str, float] = {}
        self.events: list[str] = []      # Step 20: why a model was skipped (the job logs a summary)
        self.max_output_tokens = members[0].max_output_tokens

    @property
    def model(self) -> str:
        return self.current.model

    def alive(self) -> list[GroqProvider]:
        return [m for m in self.members if not m.dead]

    def _room(self, m: GroqProvider, needed: int) -> float:
        """Seconds until `m` has room for `needed` tokens (0 = now)."""
        now = self.clock()
        wait = max(0.0, self.busy_until.get(m.model, 0) - now)
        rem, reset = m.limits.get("x-ratelimit-remaining-tokens"), m.limits.get("x-ratelimit-reset-tokens")
        if rem is not None and reset is not None and needed > rem:
            wait = max(wait, reset - (now - m.limits["at"]) + 1.0)
        return wait

    def wait_for_tokens(self, needed: int) -> float:
        alive = self.alive()
        if not alive:
            return 0.0
        best = min(alive, key=lambda m: (self._room(m, needed), alive.index(m)))
        self.current = best
        wait = min(self._room(best, needed), 65.0)
        if wait > 0:
            self.sleep(wait)
        return wait

    ROUNDS = 4   # when every model is only briefly busy (a per-minute 429), wait and go round again

    def generate(self, prompt: str, schema: dict | None) -> CallResult:
        last: AIError | None = None
        tried_bad: set[str] = set()     # models that gave a bad answer (or a 5xx) to THIS prompt
        for n in range(self.ROUNDS):
            order = ([self.current] + [m for m in self.members if m is not self.current] if n == 0
                     else sorted(self.members, key=lambda m: self.busy_until.get(m.model, 0)))   # the first free first
            for m in order:
                if m.dead or m.model in tried_bad:
                    continue
                if n > 0 and self.busy_until.get(m.model, 0) > self.clock():
                    continue
                self.current = m
                try:
                    return m.generate(prompt, schema)
                except AIError as exc:
                    last = exc
                    text = str(exc).lower()
                    if exc.kind == "rate_limit":
                        ra = exc.retry_after if exc.retry_after is not None else 60
                        if ra > 120 or "per day" in text or "(rpd)" in text or "(tpd)" in text:
                            m.dead = "daily limit"
                            self.events.append(f"{m.model}: out for the run (daily limit: {str(exc)[:120]})")
                        else:
                            self.busy_until[m.model] = self.clock() + ra
                            self.events.append(f"{m.model}: busy {ra:.0f} s")
                        continue
                    if exc.kind == "http" and exc.status in (400, 404) and "model" in text:
                        m.dead = f"HTTP {exc.status}"
                        self.events.append(f"{m.model}: out for the run (HTTP {exc.status})")
                        continue
                    if exc.kind in ("network", "too_large", "invalid", "truncated") or (exc.kind == "http" and (exc.status or 0) >= 500):
                        # Step 20 (seen live): gpt-oss-20b broke the JSON on most calls and refused a request qwen
                        # accepted (413); another model may do it. If none does, the last error goes to the caller.
                        tried_bad.add(m.model)
                        self.events.append(f"{m.model}: {exc.kind}, next model")
                        continue
                    raise
            # Step 20 (seen live): models that are only briefly busy (a per-minute 429 "try again in 1 to 15 s")
            # are not an outage: wait for the first one to be free and go round again
            waiting = [m for m in self.alive() if m.model not in tried_bad and self.busy_until.get(m.model, 0) > self.clock()]
            if not waiting:
                break
            wait = min(self.busy_until[m.model] - self.clock() for m in waiting) + 0.5
            if wait > 65:
                break
            self.sleep(wait)
        raise last or AIError(self.name, "every Groq model is out for this run", kind="rate_limit")


# ---------------------------------------------------------------- money

def model_price(model: str, cfg: dict, at: int | None = None) -> tuple[float, float]:
    """USD per million (input, output) tokens on the paid tier, from config/ai_budget.json
    `emergency` (a later `prices_from` entry wins from its date)."""
    prices = dict(cfg.get("prices_per_million") or {})
    day = time.strftime("%Y-%m-%d", time.gmtime(at if at is not None else time.time()))
    for start in sorted(cfg.get("prices_from") or {}):
        if day >= start:
            prices.update(cfg["prices_from"][start])
    p = prices.get(model) or cfg.get("unknown_price") or [3.0, 15.0]
    return float(p[0]), float(p[1])


def call_cost(model: str, input_tokens: int | None, output_tokens: int | None, cfg: dict,
              at: int | None = None) -> float:
    pin, pout = model_price(model, cfg, at)
    return ((input_tokens or 0) * pin + (output_tokens or 0) * pout) / 1e6


def utc_day_start(ts: int) -> int:
    return ts - ts % 86400


def utc_month_start(ts: int) -> int:
    t = time.gmtime(ts)
    return calendar.timegm((t.tm_year, t.tm_mon, 1, 0, 0, 0, 0, 0, 0))


SPEND_SQL = ("SELECT coalesce(sum(CASE WHEN at >= ?1 THEN usd END), 0) AS day, "
             "coalesce(sum(CASE WHEN at >= ?2 THEN usd END), 0) AS month, coalesce(sum(usd), 0) AS total FROM ai_spend")


class SpendGuard:
    """The emergency key's hard caps: USD per UTC day and month, and the credits left. A paid call is
    allowed only if its WORST case (prompt tokens and the whole max_output_tokens at the price)
    still fits under every cap; its real cost (from the answer's token counts) is added at once.
    An unreadable ledger counts as 'cap reached' (fail closed)."""

    def __init__(self, cfg: dict, day: float = 0.0, month: float = 0.0, total: float = 0.0,
                 now: Callable[[], float] = time.time, readable: bool = True):
        self.cfg = cfg
        self.day, self.month, self.total = day, month, total
        self.now = now
        self.readable = readable
        self.spent_run = 0.0
        self.calls_run = 0
        self.refused: list[str] = []

    @classmethod
    def load(cls, db, cfg: dict, now: int, clock: Callable[[], float] = time.time) -> "SpendGuard":
        try:
            r = db.query(SPEND_SQL, [utc_day_start(now), utc_month_start(now)])[0]
            return cls(cfg, float(r["day"] or 0), float(r["month"] or 0), float(r["total"] or 0), now=clock)
        except Exception:
            return cls(cfg, readable=False, now=clock)

    def why_not(self, worst: float) -> str | None:
        c = self.cfg
        today = time.strftime("%Y-%m-%d", time.gmtime(self.now()))
        if not self.readable:
            return "the spend ledger could not be read"
        if c.get("credits_expire") and today >= c["credits_expire"]:
            return f"the credits expired on {c['credits_expire']}"
        if self.day + worst > float(c.get("daily_cap_usd", 0)):
            return f"daily cap ${float(c.get('daily_cap_usd', 0)):.2f} (spent ${self.day:.4f} today)"
        if self.month + worst > float(c.get("monthly_cap_usd", 0)):
            return f"monthly cap ${float(c.get('monthly_cap_usd', 0)):.2f} (spent ${self.month:.4f} this month)"
        if self.total + worst > float(c.get("credits_usd", 0)):
            return f"credits used up (${self.total:.2f} of ${float(c.get('credits_usd', 0)):.2f})"
        return None

    def add(self, usd: float) -> None:
        self.day += usd
        self.month += usd
        self.total += usd
        self.spent_run += usd
        self.calls_run += 1


class EmergencyProvider(GeminiProvider):
    """The paid key. Same API and the same checks on its answers as the free models; before each call
    the SpendGuard must allow the call's worst case, else AIError(kind='cap') and the work waits.
    The cost of each answer is in CallResult.extra['cost_usd']."""
    name = "gemini_paid"

    def __init__(self, api_key: str, model: str, spend: SpendGuard, **kw):
        kw.setdefault("max_output_tokens", int(spend.cfg.get("max_output_tokens", 12000)))
        kw.setdefault("retry_delays", (5,))
        super().__init__(api_key, model, **kw)
        self.spend = spend
        self.last_cost = 0.0      # USD of the last call (0 if refused or not billed), read by the job's call log

    def worst_cost(self, prompt: str) -> float:
        # estimate_tokens runs up to ~10% low on Cyrillic: a 1.2x margin on the prompt
        return call_cost(self.model, int(estimate_tokens(prompt) * 1.2) + 50, self.max_output_tokens,
                         self.spend.cfg, int(self.spend.now()))

    def generate(self, prompt: str, schema: dict | None) -> CallResult:
        self.last_cost = 0.0
        why = self.spend.why_not(self.worst_cost(prompt))
        if why:
            self.spend.refused.append(why)
            raise AIError(self.name, f"emergency key not used: {why}", kind="cap")
        try:
            res = super().generate(prompt, schema)
        except AIError as exc:
            # an answer that came back but was unusable (truncated, blocked, empty) is still billed:
            # count its worst case, since such an error carries no token counts
            if exc.kind in ("truncated", "blocked", "empty"):
                self.last_cost = self.worst_cost(prompt)
                self.spend.add(self.last_cost)
            raise
        usd = call_cost(self.model, res.input_tokens, res.output_tokens, self.spend.cfg, int(self.spend.now()))
        self.spend.add(usd)
        self.last_cost = usd
        res.extra["cost_usd"] = usd
        return res


def free_failures(calls_log: list[tuple], since_index: int = 0, limit: int = 6) -> str:
    """'Why' for a paid call: the recent failed free calls of this run, condensed
    ("gemini-3.5-flash-lite: HTTP 503 x3; openai/gpt-oss-120b: HTTP 429")."""
    counts: dict[tuple[str, str], int] = {}
    for c in calls_log[since_index:]:
        provider, model, ok, error = c[1], c[2], c[3], c[8] or ""
        if ok or provider == "gemini_paid":
            continue
        code = f"HTTP {c[10]}" if c[10] else (error.split(": ", 1)[-1][:40] or "failed")
        counts[(model, code)] = counts.get((model, code), 0) + 1
    parts = [f"{m}: {code}{f' x{n}' if n > 1 else ''}" for (m, code), n in list(counts.items())[-limit:]]
    return "; ".join(parts) or "every free option failed"
