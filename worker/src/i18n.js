// Reader languages (Step 9). Every string a user reads lives in config/i18n/<lang>.json (one file
// per language); config/languages.json says which languages are enabled. A missing key falls back
// to English. Pure functions, no Intl (costly on a cold Worker): plural rules and times by hand.
// The Admin tab and the owner's health alerts stay English (owner only).
import LANGS from "../../config/languages.json" with { type: "json" };
import EN from "../../config/i18n/en.json" with { type: "json" };
import RU from "../../config/i18n/ru.json" with { type: "json" };
import HY from "../../config/i18n/hy.json" with { type: "json" };
import FR from "../../config/i18n/fr.json" with { type: "json" };

export { LANGS };
export const DICTS = { en: EN, ru: RU, hy: HY, fr: FR };

// Owner rule: never an em dash (nor an en dash, a figure dash or a horizontal bar), in any language.
export const FORBIDDEN = /[‒–—―]/;

const lookup = (dict, key) => {
  let v = dict;
  for (const k of key.split(".")) v = v == null ? undefined : v[k];
  return v;
};

// The value for `key` in `lang`, else in English.
export function raw(lang, key) {
  return lookup(DICTS[lang] ?? EN, key) ?? lookup(EN, key);
}

// Only what `lang` itself defines (no English fallback).
export function own(lang, key) {
  return lookup(DICTS[lang] ?? {}, key);
}

export function fill(s, vars = {}) {
  return String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

export function t(lang, key, vars) {
  const v = raw(lang, key);
  return typeof v === "string" ? fill(v, vars) : key;
}

// CLDR plural categories for the forms our dictionaries use: Russian one/few/many
// (1 история, 2 истории, 5 историй, 11 историй, 21 история), French and Armenian one for 0 and 1,
// English one for 1 only.
export function pluralCategory(lang, n) {
  const i = Math.abs(Math.trunc(n));
  if (lang === "ru") {
    const a = i % 10, b = i % 100;
    if (a === 1 && b !== 11) return "one";
    if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return "few";
    return "many";
  }
  if (lang === "fr" || lang === "hy") return i <= 1 ? "one" : "other";
  return i === 1 ? "one" : "other";
}

// forms = {one, few, many, other}; the right one for n, filled with vars (and {count}).
export function plural(lang, n, key, vars = {}) {
  const forms = raw(lang, key) ?? {};
  const cat = pluralCategory(lang, n);
  const s = forms[cat] ?? forms.other ?? forms.many ?? forms.one ?? key;
  return fill(s, { count: n, ...vars });
}

export const isEnabled = (lang) => LANGS.enabled.includes(lang);

// A user's first language: Telegram's language_code ("ru", "ru-RU", "pt-br") if we support it,
// else English. Used once, when the user is created; never again after that.
export function chooseLang(code) {
  const primary = String(code ?? "").toLowerCase().split(/[-_]/)[0];
  return isEnabled(primary) ? primary : LANGS.default;
}

// The language a user actually gets: their choice if it is enabled, else English.
export function effectiveLang(user) {
  return isEnabled(user?.lang) ? user.lang : LANGS.default;
}

// "2 PM" / "2:30 PM" in English (owner's format B), "14:00" everywhere else.
export function timeText(lang, p) {
  if (lang === "en") {
    const h = p.hour % 12 || 12;
    const ap = p.hour < 12 ? "AM" : "PM";
    return p.minute ? `${h}:${String(p.minute).padStart(2, "0")} ${ap}` : `${h} ${ap}`;
  }
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

// "Yerevan" -> "Ереван": common cities from the dictionary, otherwise the zone's own city name.
export function zoneName(lang, tz) {
  const city = String(tz ?? "").split("/").pop().replace(/_/g, " ");
  const v = own(lang, `zones.${city}`);
  return typeof v === "string" ? v : city;
}

// "09:00, 14:00 and 20:00" in the language's own "and".
export function listJoin(lang, items, key = "bot.and") {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")}${t(lang, key)}${items[items.length - 1]}`;
}

// Topic label in a language: the dictionary's, else the English label from the topics table.
export function topicLabel(lang, tag, labelEn) {
  if (lang !== "en") {
    const v = own(lang, `topics.${tag}`);
    if (typeof v === "string") return v;
  }
  return labelEn ?? raw("en", `topics.${tag}`) ?? tag;
}

// Bot command descriptions for setMyCommands.
export function commandList(lang) {
  return [
    { command: "start", description: t(lang, "commands.start") },
    { command: "settings", description: t(lang, "commands.settings") },
  ];
}
