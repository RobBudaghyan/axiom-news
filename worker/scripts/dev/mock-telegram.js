// A stand-in for telegram-web-app.js, used ONLY by the local preview (scripts/dev-server.mjs) so the
// Mini App can be rendered and screenshotted in a normal browser. It mimics what the real script
// provides: initData, theme CSS variables, haptics, BackButton, MainButton, showConfirm.
// window.__MOCK = {initData, theme: "light"|"dark", confirm: true|false} is set by the dev server.
(() => {
  const M = window.__MOCK || {};
  // Telegram iOS default themes (Day / Night), as reported in themeParams.
  const THEMES = {
    light: { bg_color: "#ffffff", secondary_bg_color: "#f0f0f6", section_bg_color: "#ffffff", text_color: "#000000",
      hint_color: "#8e8e93", subtitle_text_color: "#8e8e93", section_header_text_color: "#6d6d72",
      section_separator_color: "#c8c7cc", destructive_text_color: "#ff3b30", link_color: "#007aff",
      button_color: "#007aff", button_text_color: "#ffffff", accent_text_color: "#007aff", header_bg_color: "#f8f8f8",
      bottom_bar_bg_color: "#f2f2f2" },
    dark: { bg_color: "#000000", secondary_bg_color: "#000000", section_bg_color: "#1c1c1d", text_color: "#ffffff",
      hint_color: "#98989e", subtitle_text_color: "#98989e", section_header_text_color: "#8d8e93",
      section_separator_color: "#545458", destructive_text_color: "#eb5545", link_color: "#3e88f7",
      button_color: "#3e88f7", button_text_color: "#ffffff", accent_text_color: "#3e88f7", header_bg_color: "#1a1a1a",
      bottom_bar_bg_color: "#1d1d1d" },
  };
  const scheme = M.theme === "dark" ? "dark" : "light";
  const theme = THEMES[scheme];
  const root = document.documentElement.style;
  for (const [k, v] of Object.entries(theme)) root.setProperty(`--tg-theme-${k.replace(/_/g, "-")}`, v);
  root.setProperty("--tg-viewport-stable-height", `${window.innerHeight}px`);
  // Windows has no colour flag emoji; phones do. A flag-only font (Twemoji, pinned version) makes
  // the preview look like a phone. Preview only: the real Mini App uses the phone's own emoji.
  const flags = document.createElement("style");
  flags.textContent = '@font-face{font-family:"Flags";unicode-range:U+1F1E6-1F1FF,U+1F3F4,U+E0062-E007F;' +
    'src:url(https://cdn.jsdelivr.net/npm/country-flag-emoji-polyfill@0.1.8/dist/TwemojiCountryFlags.woff2) format("woff2")}' +
    'body{font-family:"Flags",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif}';
  document.head.appendChild(flags);
  const log = (...a) => { (window.__calls = window.__calls || []).push(a.join(" ")); };

  const handlers = { back: [], main: [] };
  let mainEl = null;
  const MainButton = {
    text: "", color: theme.button_color, textColor: "#ffffff", isVisible: false, isActive: true,
    setParams(p) {
      if (p.text != null) this.text = p.text;
      if (p.color) this.color = p.color;
      if (p.text_color) this.textColor = p.text_color;
      if (p.is_active != null) this.isActive = p.is_active;
      if (p.is_visible != null) this.isVisible = p.is_visible;
      draw(); return this;
    },
    setText(t) { return this.setParams({ text: t }); },
    show() { return this.setParams({ is_visible: true }); },
    hide() { return this.setParams({ is_visible: false }); },
    enable() { return this.setParams({ is_active: true }); },
    disable() { return this.setParams({ is_active: false }); },
    showProgress() { return this; }, hideProgress() { return this; },
    onClick(f) { handlers.main.push(f); return this; }, offClick() { return this; },
  };
  function draw() {   // a bar like Telegram's bottom button area
    if (!mainEl) {
      mainEl = document.createElement("div");
      mainEl.setAttribute("data-mock", "main-button");
      Object.assign(mainEl.style, { position: "fixed", left: "0", right: "0", bottom: "0", zIndex: "99",
        padding: "8px 16px 14px", background: theme.bottom_bar_bg_color, transition: "transform .25s" });
      mainEl.innerHTML = '<button style="width:100%;height:50px;border:0;border-radius:12px;text-align:center;font:600 17px -apple-system,Segoe UI,Roboto,sans-serif"></button>';
      mainEl.firstChild.onclick = () => MainButton.isActive && handlers.main.forEach((f) => f());
      document.body.appendChild(mainEl);
    }
    const b = mainEl.firstChild;
    b.textContent = MainButton.text;
    b.style.background = MainButton.isActive ? MainButton.color : (scheme === "dark" ? "#2c2c2e" : "#e3e3e8");
    b.style.color = MainButton.isActive ? MainButton.textColor : theme.hint_color;
    mainEl.style.transform = MainButton.isVisible ? "none" : "translateY(110%)";
  }

  window.Telegram = { WebApp: {
    initData: M.initData || "", initDataUnsafe: {}, version: "8.0", platform: "ios", colorScheme: scheme, themeParams: theme,
    isVersionAtLeast: () => true, ready() { log("ready"); }, expand() { log("expand"); },
    disableVerticalSwipes() { log("disableVerticalSwipes"); },
    setHeaderColor(c) { log("setHeaderColor", c); }, setBackgroundColor(c) { log("setBackgroundColor", c); },
    setBottomBarColor(c) { log("setBottomBarColor", c); }, onEvent() {}, offEvent() {},
    HapticFeedback: { impactOccurred: (s) => log("haptic impact", s), notificationOccurred: (t) => log("haptic", t),
      selectionChanged: () => log("haptic selection") },
    BackButton: { isVisible: false, show() { this.isVisible = true; log("back show"); }, hide() { this.isVisible = false; log("back hide"); },
      onClick(f) { handlers.back.push(f); }, offClick() {} },
    MainButton,
    showConfirm(msg, cb) { log("confirm", msg); setTimeout(() => cb(M.confirm !== false), 0); },
    showAlert(msg, cb) { log("alert", msg); cb && cb(); },
    __back: () => handlers.back.forEach((f) => f()),
  } };
})();
