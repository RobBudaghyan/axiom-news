// User settings from the Mini App: validation and the next digest time. Pure functions, no I/O.
// Limits live in config/digest.json ("settings_limits"). Since Step 5 a user sets only topics,
// digest times (on the hour, 06:00-23:00, 1 to 5) and pause; Step 9 adds the language. The time zone always follows the
// phone (saved on every open, src/api.js); the story count and the format are no longer settings.
import { CONFIG, nextSlot, parseList } from "./digest.js";
import { LANGS, effectiveLang, t } from "./i18n.js";

// users.tz_detected: 0 = never reported (default zone), 1 = set from the device.
// (2 = "chosen by hand" existed until Step 5; such a zone is replaced by the phone's on next open.)
export const TZ_DEFAULT = 0, TZ_AUTO = 1, TZ_MANUAL = 2;
const KEYS = new Set(["topics", "digest_times", "paused", "lang"]);
const KEEP_DUE_S = 15 * 60;   // a digest already due (waiting for the next 5-min tick) is kept

// A refused setting: `code` names the message in config/i18n (errors.<code>), so the Mini App can
// show it in the user's language; `message` is the English text (Step 9).
export class SettingsError extends Error {
  constructor(code, vars = {}) {
    super(t("en", `errors.${code}`, vars));
    this.code = code;
    this.vars = vars;
  }
}

const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const fromMinutes = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export function allowedTimes(cfg = CONFIG) {
  const L = cfg.settings_limits;
  const out = [];
  for (let m = minutes(L.earliest); m <= minutes(L.latest); m += L.step_minutes) out.push(fromMinutes(m));
  return out;
}

// Step 5 migration: an older time like "08:30" goes to the nearest allowed hour (a half hour
// rounds up: 08:30 -> 09:00), clamped to the allowed range; duplicates removed, sorted, at most
// max_times. Used by scripts/archive/migrate-times.mjs (Step 5).
export function roundTimes(times, cfg = CONFIG) {
  const L = cfg.settings_limits;
  const lo = minutes(L.earliest), hi = minutes(L.latest), step = L.step_minutes;
  const out = new Set();
  for (const t of times) {
    if (typeof t !== "string" || !/^\d{2}:\d{2}$/.test(t)) continue;
    const m = Math.min(hi, Math.max(lo, Math.floor((minutes(t) + step / 2) / step) * step));
    out.add(fromMinutes(m));
  }
  const list = [...out].sort().slice(0, L.max_times);
  return list.length ? list : [...cfg.default_times];
}

// A valid IANA zone name. Building the formatter is also what digest.js does, so the result is
// reused later through its cache (Intl is the costly part on a cold Worker).
export function validZone(tz) {
  if (typeof tz !== "string" || !tz || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// patch: what the Mini App sends (any subset). topicTags: the known topic tags.
// Returns the clean column values to write. Throws SettingsError with a friendly message.
// extra.custom: how many custom topics the user follows (Step 13): with one, every main topic may be off.
export function validatePatch(patch, topicTags, cfg = CONFIG, extra = {}) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new SettingsError("nothing");
  const unknown = Object.keys(patch).filter((k) => !KEYS.has(k));
  if (unknown.length) throw new SettingsError("unknown_setting", { key: unknown[0] });
  const L = cfg.settings_limits;
  const out = {};
  if ("topics" in patch) {
    const t = patch.topics;
    if (!Array.isArray(t) || !t.every((x) => typeof x === "string")) throw new SettingsError("topics_list");
    const uniq = [...new Set(t)];
    if (!uniq.length && !extra.custom) throw new SettingsError("keep_topic");
    const bad = uniq.find((x) => !topicTags.includes(x));
    if (bad) throw new SettingsError("no_topic");
    out.topics = topicTags.filter((x) => uniq.includes(x));   // keep the official order
  }
  if ("digest_times" in patch) {
    const t = patch.digest_times;
    if (!Array.isArray(t) || !t.every((x) => typeof x === "string")) throw new SettingsError("times_list");
    const uniq = [...new Set(t)].sort();
    if (!uniq.length) throw new SettingsError("keep_time");
    if (uniq.length > L.max_times) throw new SettingsError("max_times", { max: L.max_times });
    const ok = allowedTimes(cfg);
    if (uniq.some((x) => !ok.includes(x))) {
      throw new SettingsError("times_hour", { from: L.earliest, to: L.latest });
    }
    out.digest_times = uniq;
  }
  if ("paused" in patch) {
    if (typeof patch.paused !== "boolean") throw new SettingsError("pause_bool");
    out.paused = patch.paused ? 1 : 0;
  }
  if ("lang" in patch) {   // Step 9: only a language in the picker (config/languages.json "enabled")
    if (typeof patch.lang !== "string" || !LANGS.enabled.includes(patch.lang)) throw new SettingsError("lang_bad");
    out.lang = patch.lang;
  }
  if (!Object.keys(out).length) throw new SettingsError("nothing");
  return out;
}

// The next digest after a settings change. A digest that is already due (its slot passed less
// than 15 minutes ago and the 5-minute tick has not sent it yet) is kept, so saving a setting
// right after 14:00 does not swallow the 14:00 digest. Otherwise: the first slot after now.
export function nextDigestAfterChange(before, after, now, cfg = CONFIG) {
  const wasDue = before.next_digest_at != null && before.next_digest_at <= now &&
    now - before.next_digest_at < KEEP_DUE_S && !before.paused;
  if (wasDue && !after.paused) return before.next_digest_at;
  const times = parseList(after.digest_times, cfg.default_times);
  return nextSlot(now, after.timezone || cfg.default_timezone, times);
}

// The settings the Mini App shows (no internal columns).
export function publicUser(u, cfg = CONFIG) {
  return {
    first_name: u.first_name ?? "",
    timezone: u.timezone || cfg.default_timezone,
    tz_source: u.tz_detected === TZ_DEFAULT || u.tz_detected == null ? "default" : "device",
    digest_times: parseList(u.digest_times, cfg.default_times),
    topics: parseList(u.topics),
    paused: !!u.paused,
    next_digest_at: u.next_digest_at ?? null,
    lang: effectiveLang(u),            // Step 9: a language that is not enabled shows as English
  };
}
