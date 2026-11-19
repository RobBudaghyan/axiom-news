// Loads a real digest (data/digest-<lang>.html, saved from staging with
// `AXIOM_ENV=staging node worker/scripts/digest-cli.mjs --preview --dry --lang <lang> --topics main`)
// into an element. Only two edits: the preview label line is removed, and the owner's first name is
// left out of the greeting. The stories, outlets and summaries are exactly as the bot sent them.
// Emoji are drawn as Twemoji images (emoji/<codepoints>.svg, picked by pick-emoji.mjs).
const emojiFile = (seq) => {
  const cps = [...seq].map((c) => c.codePointAt(0).toString(16));
  return (seq.includes(String.fromCharCode(0x200d)) ? cps : cps.filter((c) => c !== "fe0f")).join("-");
};

function emojify(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue;
    if (!/\p{RGI_Emoji}/v.test(text)) continue;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(/\p{RGI_Emoji}/gv)) {
      frag.append(text.slice(last, m.index));
      const img = document.createElement("img");
      img.className = "emo";
      img.alt = m[0];
      img.src = `emoji/${emojiFile(m[0])}.svg`;
      frag.append(img);
      last = m.index + m[0].length;
    }
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
  return Promise.all([...root.querySelectorAll("img.emo")].map((i) =>
    new Promise((r) => (i.complete ? r() : ((i.onload = r), (i.onerror = () => { console.warn("no emoji " + i.src); r(); }))))));
}

window.loadDigest = async (el, lang, maxStories = 99) => {
  let html = await (await fetch(`data/digest-${lang}.html`)).text();
  html = html.replace(/^<p><i>[^<]*<\/i><\/p>/, "").replace(/(<p><b>[^<,]+), [^<]+<\/b>/, "$1</b>");
  el.innerHTML = html;
  // keep the first N stories (a story is a <p> with a link, plus its quote)
  let n = 0;
  for (const node of [...el.children]) {
    if (node.tagName === "P" && node.querySelector("a")) n++;
    if (n > maxStories) node.remove();
  }
  while (el.lastElementChild && ["HR", "TABLE"].includes(el.lastElementChild.tagName)) el.lastElementChild.remove();
  await emojify(el);
};
