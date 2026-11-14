// User settings from the Mini App: validation and the next digest time. Pure functions, no I/O.
// Limits live in config/digest.json ("settings_limits").
import { CONFIG, nextSlot, parseList } from "./digest.js";

// users.tz_detected: 0 = never reported (default zone), 1 = set from the device, 2 = chosen by hand
export const TZ_DEFAULT = 0, TZ_AUTO = 1, TZ_MANUAL = 2;
const KEYS = new Set(["topics", "digest_times", "max_stories", "format", "timezone", "tz_auto", "paused"]);
const KEEP_DUE_S = 15 * 60;   // a digest already due (waiting for the next 5-min tick) is kept

export class SettingsError extends Error {}

const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export function allowedTimes(cfg = CONFIG) {
  const L = cfg.settings_limits;
  const out = [];
  for (let m = minutes(L.earliest); m <= minutes(L.latest); m += L.step_minutes) {
    out.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
  }
  return out;
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
export function validatePatch(patch, topicTags, cfg = CONFIG) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new SettingsError("Nothing to save.");
  const unknown = Object.keys(patch).filter((k) => !KEYS.has(k));
  if (unknown.length) throw new SettingsError(`Unknown setting: ${unknown[0]}.`);
  const L = cfg.settings_limits;
  const out = {};
  if ("topics" in patch) {
    const t = patch.topics;
    if (!Array.isArray(t) || !t.every((x) => typeof x === "string")) throw new SettingsError("Topics must be a list.");
    const uniq = [...new Set(t)];
    if (!uniq.length) throw new SettingsError("Pick at least one topic.");
    const bad = uniq.find((x) => !topicTags.includes(x));
    if (bad) throw new SettingsError("That topic does not exist.");
    out.topics = topicTags.filter((x) => uniq.includes(x));   // keep the official order
  }
  if ("digest_times" in patch) {
    const t = patch.digest_times;
    if (!Array.isArray(t) || !t.every((x) => typeof x === "string")) throw new SettingsError("Times must be a list.");
    const uniq = [...new Set(t)].sort();
    if (!uniq.length) throw new SettingsError("Keep at least one digest time.");
    if (uniq.length > L.max_times) throw new SettingsError(`You can have up to ${L.max_times} digest times.`);
    const ok = allowedTimes(cfg);
    if (uniq.some((x) => !ok.includes(x))) {
      throw new SettingsError(`Times must be between ${L.earliest} and ${L.latest}, on the hour or half hour.`);
    }
    out.digest_times = uniq;
  }
  if ("max_stories" in patch) {
    const n = patch.max_stories;
    if (!Number.isInteger(n) || n < L.min_stories || n > L.max_stories) {
      throw new SettingsError(`Stories per digest must be between ${L.min_stories} and ${L.max_stories}.`);
    }
    out.max_stories = n;
  }
  if ("format" in patch) {
    if (!cfg.formats.includes(patch.format)) throw new SettingsError("Unknown format.");
    out.format = patch.format;
  }
  if ("timezone" in patch) {
    if (!validZone(patch.timezone)) throw new SettingsError("That time zone is not recognised.");
    out.timezone = patch.timezone;
    out.tz_detected = patch.tz_auto === true ? TZ_AUTO : TZ_MANUAL;
  } else if ("tz_auto" in patch) {
    throw new SettingsError("Time zone missing.");
  }
  if ("paused" in patch) {
    if (typeof patch.paused !== "boolean") throw new SettingsError("Pause must be on or off.");
    out.paused = patch.paused ? 1 : 0;
  }
  if (!Object.keys(out).length) throw new SettingsError("Nothing to save.");
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
    tz_source: u.tz_detected === TZ_MANUAL ? "manual" : u.tz_detected === TZ_AUTO ? "device" : "default",
    digest_times: parseList(u.digest_times, cfg.default_times),
    max_stories: u.max_stories || cfg.default_stories,
    topics: parseList(u.topics),
    format: cfg.formats.includes(u.format) ? u.format : cfg.format,
    paused: !!u.paused,
    next_digest_at: u.next_digest_at ?? null,
  };
}
