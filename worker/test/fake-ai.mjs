// A stand-in for Gemini's topic check (Step 13), used by the unit tests and the local preview
// (scripts/dev-server.mjs), so neither ever calls the real AI. It reads the typed text and the
// reader topics from the prompt and answers like the real model would:
//   Colombia / Колумбия / "Colombian news"  -> accept (or same_as the existing Colombia topic)
//   Formula 1 / F1                           -> accept (or same_as the existing Formula 1 topic)
//   AI regulation                            -> accept
//   my neighbour / Vasya Pupkin              -> reject private_person
//   asdf..., qwerty, xxx                      -> reject nonsense
//   Armenian news                            -> same_as armenia (a main topic)
//   anything else                            -> accept, named as typed

const KNOWN = [
  { re: /colomb|колумб/i, names: { en: "Colombia", ru: "Колумбия", hy: "Կոլումբիա", fr: "Colombie" }, emoji: "🇨🇴",
    queries: [{ q: "Colombia", ed: "en" }, { q: "Colombia Petro", ed: "es_co" }, { q: "Bogotá", ed: "es_co" }], boost: 2 },
  { re: /formula 1|formula one|\bf1\b|формул/i, names: { en: "Formula 1", ru: "Формула-1", hy: "Ֆորմուլա 1", fr: "Formule 1" },
    emoji: "🏎️", queries: [{ q: "Formula 1", ed: "en" }, { q: "F1 Grand Prix", ed: "en_gb" }], boost: 2 },
  { re: /japan|япони/i, names: { en: "Japan", ru: "Япония", hy: "Ճապոնիա", fr: "Japon" }, emoji: "🇯🇵",
    queries: [{ q: "Japan news", ed: "en" }, { q: "日本 ニュース", ed: "ja" }], boost: 2 },
  { re: /ai regulation|регулирован/i, names: { en: "AI regulation", ru: "Регулирование ИИ", hy: "ԱԲ կարգավորում", fr: "Régulation de l'IA" },
    emoji: "🤖", queries: [{ q: "AI regulation", ed: "en" }, { q: "AI Act", ed: "en_gb" }], boost: 1 },
];

export function topicAnswer(prompt) {
  const input = JSON.parse(/The reader typed: (".*")\n/.exec(prompt)?.[1] ?? '""');
  const lang = /The reader's language: (\w+)/.exec(prompt)?.[1] ?? "English";
  const ru = lang === "Russian";
  const readers = [...prompt.matchAll(/^ {3}- (c\d+): (.+)$/gm)].map((m) => ({ tag: m[1], name: m[2] }));
  const empty = { names: { en: "", ru: "", hy: "", fr: "" }, emoji: "", definition: "", queries: [], boost_max: 0 };
  const k = KNOWN.find((x) => x.re.test(input));
  if (!k && (/^(asdf|qwer|xxx|zzz|jkl)/i.test(input) || !/[aeiouyаеиоуыэюя]/i.test(input))) {
    return { verdict: "reject", reason_code: "nonsense", same_as: "", ...empty,
      reason: ru ? "Это не похоже на тему новостей." : "This does not look like a news topic." };
  }
  if (/neighbou?r|сосед|pupkin|пупкин/i.test(input)) {
    return { verdict: "reject", reason_code: "private_person", same_as: "", ...empty,
      reason: ru ? "Нельзя добавлять темы о частных лицах." : "We cannot follow news about a private person." };
  }
  if (/armenian news|новости армении/i.test(input)) {
    return { verdict: "accept", reason_code: "ok", same_as: "armenia", ...empty, reason: "Armenia is a main topic." };
  }
  const names = k ? k.names : { en: input, ru: input, hy: input, fr: input };
  const same = readers.find((r) => r.name.toLowerCase() === names.en.toLowerCase());
  return {
    verdict: "accept", reason_code: "ok", reason: ru ? "Хорошая тема." : "A good news topic.", same_as: same ? same.tag : "",
    names, emoji: k ? k.emoji : "📰", definition: `News about ${names.en}.`,
    queries: k ? k.queries : [{ q: input, ed: "en" }, { q: `${input} news`, ed: "en" }], boost_max: k ? k.boost : 1,
  };
}

// The HTTP answer Gemini's generateContent gives for that JSON.
export function geminiResponse(obj, tokens = { in: 900, out: 160 }) {
  return {
    candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: tokens.in, candidatesTokenCount: tokens.out, thoughtsTokenCount: 0 },
  };
}

export const isGemini = (url) => url.startsWith("https://generativelanguage.googleapis.com/");
export const isGroq = (url) => url.startsWith("https://api.groq.com/");

// The prompt text inside a Gemini request body.
export const promptOf = (body) => body?.contents?.[0]?.parts?.[0]?.text ?? body?.messages?.[0]?.content ?? "";
