// The Lanes app in the browser (ADR-0029): one page, its script and its style, served by the server at /app.
// Kept as strings, not files, so they work the same under Node's TS runtime and inside the esbuild bundle.
// The page holds no data: its script reads the token from the URL fragment (or a GitHub sign-in, ADR-0031) and uses the
// normal token-checked API. The view functions live in app-view.ts and are re-exported here.
import { appView, splitMentions, avatarTone, initials, timeAgo, timeLeft, chatGroups, filterPeople, mentionTag, unreadSince, freshAlerts, shortcuts, keyAction, paletteItems, paletteFilter, suggest, timeline, faviconBadge } from "./app-view.ts";
export * from "./app-view.ts";

const MARK =`<svg class="mark" viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false"><rect width="32" height="32" rx="8" fill="#181c28"/><path d="M9 6v20M16 6v20M23 6v20" stroke="#6e7896" stroke-width="2.4" stroke-linecap="round"/><path d="M9 12h7" stroke="#4f8cff" stroke-width="3" stroke-linecap="round"/><path d="M16 20h7" stroke="#ff963c" stroke-width="3" stroke-linecap="round"/></svg>`;
const GITHUB = `<svg class="gh-mark" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`;
const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23181c28'/%3E%3Cpath d='M9 6v20M16 6v20M23 6v20' stroke='%236e7896' stroke-width='2.4' stroke-linecap='round'/%3E%3Cpath d='M9 12h7' stroke='%234f8cff' stroke-width='3' stroke-linecap='round'/%3E%3Cpath d='M16 20h7' stroke='%23ff963c' stroke-width='3' stroke-linecap='round'/%3E%3C/svg%3E";

// Icon paths, shared by the page markup and the script (16×16, stroked).
const PATHS: Record<string, string> = {
  search: "M7 12.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM11 11l3.5 3.5",
  bell: "M4 11.5V7a4 4 0 0 1 8 0v4.5l1.2 1.2H2.8zM6.5 14.2a1.6 1.6 0 0 0 3 0",
  chat: "M2.5 3.5h11v7.5H8l-3.2 2.6V11H2.5z",
  down: "M8 3v10M4 9l4 4 4-4",
  send: "M2 8h11M9 3.5 13.5 8 9 12.5",
  file: "M4 1.8h5l3.2 3.2v9.2H4zM9 1.8V5h3.2",
  repo: "M4.5 2.5v11M4.5 5.5c0 2.5 7 1.5 7 5M11.5 2.5v8M4.5 13.5a1.4 1.4 0 1 0 0-.1M11.5 13a1.4 1.4 0 1 0 0-.1",
  help: "M6 6a2 2 0 1 1 2.8 1.8C8.2 8.1 8 8.6 8 9.2M8 11.8v.2",
  check: "M3.5 8.5l3 3 6-7",
  grip: "M6 3.5h.01M10 3.5h.01M6 8h.01M10 8h.01M6 12.5h.01M10 12.5h.01",
  grid: "M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z",
};
const icon = (name: string) => `<svg class="i" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="${PATHS[name]}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_SEARCH = icon("search");
const ICON_BELL = icon("bell");
const ICON_CHAT = icon("chat");
const ICON_DOWN = icon("down");
const ICON_SEND = icon("send");
const ICON_GRIP = icon("grip");
const ICON_GRID = icon("grid");

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>Lanes</title>
<link id="favicon" rel="icon" href="${FAVICON}">
<link rel="stylesheet" href="/app.css">
<script src="/app.js" defer></script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="atmos" aria-hidden="true"></div>
<noscript><p class="noscript">The Lanes app needs JavaScript. Run <code>lanes status</code> in a terminal instead.</p></noscript>
<main id="signin" class="signin" hidden>
  <div class="signin-card">
    ${MARK}
    <h1>Lanes</h1>
    <p class="lead">Your team's coding agents, in one place.</p>
    <p id="signin-reason" class="reason" role="alert" hidden></p>
    <div id="gh" class="gh" hidden>
      <button id="gh-start" class="btn btn-github" type="button">${GITHUB}<span>Sign in with GitHub</span></button>
      <div id="gh-code" class="gh-code" hidden>
        <p class="step">Enter this code on GitHub, then come back here.</p>
        <div class="code-row">
          <output id="gh-user-code" class="user-code" aria-label="Your one-time code"></output>
          <button id="gh-copy" class="btn btn-quiet" type="button">Copy</button>
        </div>
        <a id="gh-link" class="btn btn-primary btn-block" href="https://github.com/login/device" target="_blank" rel="noopener noreferrer"><span id="gh-link-text">Open github.com/login/device</span></a>
        <p class="waiting-line"><span class="spinner" aria-hidden="true"></span>Waiting for GitHub…</p>
      </div>
      <div id="gh-error" class="gh-error" hidden>
        <p id="gh-error-text" role="alert"></p>
        <button id="gh-retry" class="btn btn-quiet" type="button">Try again</button>
      </div>
    </div>
    <p class="fallback">Or run <code>lanes app</code> in a terminal to open a signed-in link.</p>
  </div>
</main>
<div id="dash" class="dash" hidden>
  <header class="top">
    <div class="top-inner">
    <span class="brand">${MARK}<span class="brand-name">Lanes</span></span>
    <span class="slash" aria-hidden="true">/</span>
    <label class="picker"><span class="sr">Repository</span><select id="repo"></select></label>
    <span class="grow"></span>
    <button id="open-palette" class="cmdk" type="button" aria-keyshortcuts="Control+K Meta+K" aria-label="Search people, files and actions">${ICON_SEARCH}<span class="cmdk-text">Search or jump to…</span><kbd id="cmdk-key" class="kbd">Ctrl K</kbd></button>
    <button id="jump-chat" class="icon-btn jump-chat" type="button" aria-label="Go to the team chat">${ICON_CHAT}<span id="jump-count" class="dot-count" hidden></span></button>
    <button id="notify" class="icon-btn" type="button" aria-pressed="false" aria-label="Browser notifications for requests and mentions">${ICON_BELL}</button>
    <button id="layout-reset" class="icon-btn layout-btn" type="button" aria-label="Reset the panel layout" title="Reset the panel layout">${ICON_GRID}</button>
    <button id="open-help" class="icon-btn help-btn" type="button" aria-keyshortcuts="?" aria-label="Keyboard shortcuts">?</button>
    <span id="pill" class="pill connecting" role="status"><span class="pill-dot" aria-hidden="true"></span><span id="pill-text" class="pill-text">Connecting</span></span>
    <span class="me" id="me"><span id="me-avatar" class="avatar" aria-hidden="true"></span><span id="me-name" class="me-name"></span></span>
    </div>
  </header>
  <div class="shell">
  <div id="demo-banner" class="demo-banner" hidden><span class="demo-tag">Demo</span><span class="demo-text">A simulated team with demo data, nothing is saved. Approve the request, write in the chat, drag the panels. Yours: run <code>lanes app</code>.</span><span id="demo-hint" class="demo-hint"></span></div>
  <div id="banner" class="banner" role="alert" hidden><span id="banner-text" class="banner-text"></span><button id="banner-retry" class="btn btn-quiet btn-sm" type="button" hidden>Retry now</button></div>
  <p id="notice" class="notice" role="alert" hidden></p>
  <main id="main" class="grid" tabindex="-1" aria-busy="true">
    <div class="col col-main" id="col-main" data-col="main">
      <section id="p-lanes" class="panel" aria-labelledby="h-lanes" tabindex="-1" data-panel="lanes">
        <div class="panel-head"><button class="grip" type="button" aria-label="Drag to move this panel, or use the arrow keys">${ICON_GRIP}</button><span class="tag tag-blue" aria-hidden="true"></span><h2 id="h-lanes">Lanes</h2><span id="lanes-count" class="count" hidden></span><span class="panel-sub" id="lanes-sub">Files held and waited for, live</span><button class="fold" type="button" aria-expanded="true" aria-label="Collapse">${ICON_DOWN}</button></div>
        <div class="panel-body"><div id="lanes-map" class="lanes-map" role="img" aria-label="Lane map"></div><ul id="lanes-legend" class="lanes-legend" aria-label="Legend"><li><span class="lg lg-hold"></span>holds the file</li><li><span class="lg lg-wait"></span>waiting for it</li><li><span class="lg lg-quiet"></span>planned by a task</li></ul></div>
      </section>
      <section id="p-inbox" class="panel" aria-labelledby="h-inbox" tabindex="-1" data-panel="inbox">
        <div class="panel-head"><button class="grip" type="button" aria-label="Drag to move this panel, or use the arrow keys">${ICON_GRIP}</button><span class="tag tag-orange" aria-hidden="true"></span><h2 id="h-inbox">Inbox</h2><span id="inbox-count" class="count count-hot" hidden></span><span class="panel-sub" id="inbox-sub">Requests waiting for you</span><button class="fold" type="button" aria-expanded="true" aria-label="Collapse">${ICON_DOWN}</button></div>
        <div class="panel-body"><ul id="for-me" class="reqs reqs-inbox"></ul></div>
      </section>
      <section id="p-team" class="panel" aria-labelledby="h-people" tabindex="-1" data-panel="team">
        <div class="panel-head"><button class="grip" type="button" aria-label="Drag to move this panel, or use the arrow keys">${ICON_GRIP}</button><span class="tag tag-green" aria-hidden="true"></span><h2 id="h-people">Team</h2><span id="people-count" class="count"></span>
          <label class="filter"><span class="sr">Filter the team by name, task or file</span>${ICON_SEARCH}<input id="filter" type="search" class="filter-input" placeholder="Filter by name, task or file" autocomplete="off" spellcheck="false" aria-keyshortcuts="F" aria-describedby="filter-sum"></label>
        <button class="fold" type="button" aria-expanded="true" aria-label="Collapse">${ICON_DOWN}</button></div>
        <div class="panel-body"><p id="filter-sum" class="filter-sum" role="status" hidden></p><ul id="people" class="people"></ul></div>
      </section>
      <section id="p-sent" class="panel" aria-labelledby="h-sent" data-panel="sent">
        <div class="panel-head"><button class="grip" type="button" aria-label="Drag to move this panel, or use the arrow keys">${ICON_GRIP}</button><span class="tag tag-violet" aria-hidden="true"></span><h2 id="h-sent">Requests</h2><span class="panel-sub">Sent by you, and a new one</span><button class="fold" type="button" aria-expanded="true" aria-label="Collapse">${ICON_DOWN}</button></div>
        <div class="panel-body">
        <ul id="from-me" class="reqs reqs-sent"></ul>
        <form id="ask" class="ask" aria-labelledby="h-ask" novalidate>
          <h3 id="h-ask">Ask a teammate's agent</h3>
          <p class="hint">It reaches their agent only after they approve it. Read only unless you allow edits.</p>
          <div class="ask-row">
            <div class="field-wrap ask-to"><label class="field-label" for="ask-to">Teammate</label><input id="ask-to" class="field" maxlength="64" autocomplete="off" spellcheck="false" placeholder="Name" aria-describedby="ask-sugg"><div id="ask-sugg" class="sugg" aria-label="Teammates"></div></div>
            <div class="field-wrap ask-text"><div class="label-row"><label class="field-label" for="ask-text">Request</label><span id="ask-count" class="counter" aria-live="polite">0 / 1000</span></div><textarea id="ask-text" class="field" rows="2" maxlength="1000" autocomplete="off" placeholder="Explain how session expiry works" aria-describedby="ask-count"></textarea></div>
          </div>
          <div class="ask-foot">
            <label class="toggle"><input type="checkbox" id="ask-edit" class="switch" aria-describedby="ask-scope"><span>May edit files</span></label>
            <p id="ask-scope" class="scope-note"></p>
            <button id="ask-send" type="submit" class="btn btn-primary">Send request</button>
          </div>
        </form>
        </div>
      </section>
      <section id="p-activity" class="panel" aria-labelledby="h-activity" tabindex="-1" data-panel="activity">
        <div class="panel-head"><button class="grip" type="button" aria-label="Drag to move this panel, or use the arrow keys">${ICON_GRIP}</button><span class="tag tag-pink" aria-hidden="true"></span><h2 id="h-activity">Activity</h2><span class="panel-sub">Tasks, requests and waits in this repository</span><button class="fold" type="button" aria-expanded="true" aria-label="Collapse">${ICON_DOWN}</button></div>
        <div class="panel-body"><ol id="activity" class="activity"></ol></div>
      </section>
    </div>
    <div class="col col-side" id="col-side" data-col="side">
    <section id="p-chat" class="panel chat-panel" aria-labelledby="h-chat" tabindex="-1" data-panel="chat">
      <div class="panel-head"><button class="grip" type="button" aria-label="Drag to move this panel, or use the arrow keys">${ICON_GRIP}</button><span class="tag tag-teal" aria-hidden="true"></span><h2 id="h-chat">Team chat</h2><span id="chat-unread" class="count count-hot" hidden></span><span class="panel-sub">Agents read @mentions</span><button class="fold" type="button" aria-expanded="true" aria-label="Collapse">${ICON_DOWN}</button></div>
      <div class="panel-body chat-body">
      <ol id="chat" class="messages" aria-live="polite" aria-relevant="additions"></ol>
      <button id="new-msgs" class="new-pill" type="button" hidden><span id="new-msgs-text">New messages</span>${ICON_DOWN}</button>
      <form id="say" class="composer">
        <div class="composer-field">
          <textarea id="say-text" class="field" rows="1" aria-label="Message to the team" aria-keyshortcuts="/" placeholder="Message the team. @name or @team reaches agents" maxlength="500" autocomplete="off" aria-describedby="say-count"></textarea>
          <span id="say-count" class="counter counter-float" aria-live="polite" hidden></span>
        </div>
        <button id="say-send" type="submit" class="btn btn-primary btn-send" aria-label="Send message">${ICON_SEND}</button>
      </form>
      </div>
    </section>
    </div>
  </main>
  </div>
</div>
<div id="toasts" class="toasts" aria-live="polite"></div>
<dialog id="palette" class="palette" aria-label="Search people, files and actions">
  <div class="pal-search">${ICON_SEARCH}<input id="pal-input" class="pal-input" type="text" role="combobox" aria-expanded="true" aria-controls="pal-list" aria-autocomplete="list" autocomplete="off" spellcheck="false" placeholder="Jump to a person, ask a teammate, find a file…"><kbd class="kbd">Esc</kbd></div>
  <ul id="pal-list" class="pal-list" role="listbox" aria-label="Results"></ul>
  <p class="pal-foot"><span><kbd class="kbd">↑</kbd><kbd class="kbd">↓</kbd> move</span><span><kbd class="kbd">↵</kbd> open</span><span><kbd class="kbd">Esc</kbd> close</span></p>
</dialog>
<dialog id="help" class="help" aria-labelledby="h-help">
  <div class="help-head"><h2 id="h-help">Keyboard shortcuts</h2><button id="help-close" class="icon-btn" type="button" aria-label="Close">×</button></div>
  <dl id="help-list" class="help-list"></dl>
  <p class="help-foot">Drag a panel by its grip to move it; arrow keys on the grip do the same. The layout is kept in this browser.</p>
</dialog>
</body>
</html>
`;

const CSS = `:root {
  color-scheme: dark;
  --bg: #070a12; --bg-grid: rgba(150, 172, 235, .07);
  --surface: rgba(12, 18, 36, .74); --surface-2: rgba(16, 24, 48, .7); --surface-3: rgba(24, 34, 64, .8); --solid: #0c1224; --solid-2: #111a31;
  --line: rgba(150, 172, 235, .26); --line-s: rgba(150, 172, 235, .14); --line-strong: rgba(150, 172, 235, .42);
  --text: #eef1fa; --text-2: #c7cde0; --muted: #8e97b5; --faint: #6f7897; --ink: #0a0d18;
  --blue: #4f8cff; --blue-hover: #6a9dff; --blue-text: #8db4ff; --blue-soft: rgba(79, 140, 255, .16);
  --amber: #ff963c; --amber-text: #ffb877; --amber-soft: rgba(255, 150, 60, .1); --amber-line: rgba(255, 150, 60, .36);
  --green: #3ddc97; --green-text: #5fe6ab; --green-soft: rgba(61, 220, 151, .13);
  --red: #ff6b7a; --red-text: #ff8f9b; --red-soft: rgba(255, 107, 122, .12);
  --violet: #b69cff; --pink: #ff7ab6; --teal: #6fd6c8; --glow: rgba(79, 140, 255, .38); --scrim: rgba(2, 4, 10, .66);
  --head: rgba(7, 10, 18, .78);
  --shadow: 0 1px 0 rgba(255, 255, 255, .025) inset, 0 12px 32px -18px rgba(0, 0, 0, .7);
  --shadow-up: 0 1px 0 rgba(255, 255, 255, .04) inset, 0 18px 40px -16px rgba(0, 0, 0, .8), 0 0 0 1px var(--line-strong);
  --ring: 0 0 0 3px rgba(79, 140, 255, .4);
  --av-l: 24%; --av-s: 45%; --av-t: 82%;
  --ease: cubic-bezier(.2, .8, .2, 1); --spring: cubic-bezier(.34, 1.56, .64, 1);
  --mono: ui-monospace, "Cascadia Code", "SF Mono", Consolas, "Liberation Mono", monospace;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --dash: 1px dashed var(--line);
}
@media (prefers-color-scheme: light) {
  :root {
    color-scheme: light;
    --bg: #f3f5fb; --bg-grid: rgba(47, 76, 160, .08);
    --surface: rgba(255, 255, 255, .82); --surface-2: rgba(244, 246, 251, .9); --surface-3: #e9edf7; --solid: #ffffff; --solid-2: #f4f6fb;
    --line: rgba(47, 76, 160, .26); --line-s: rgba(47, 76, 160, .13); --line-strong: rgba(47, 76, 160, .45);
    --text: #0e1322; --text-2: #39405a; --muted: #5f6889; --faint: #8a92ad; --ink: #0e1322;
    --blue: #2f6bf0; --blue-hover: #255ddb; --blue-text: #2356c8; --blue-soft: rgba(47, 107, 240, .1);
    --amber: #d06a0c; --amber-text: #9a4a05; --amber-soft: #fff5e8; --amber-line: #f6d2a5;
    --green: #12a26a; --green-text: #0b7a4f; --green-soft: rgba(18, 162, 106, .12);
    --red: #d33b4c; --red-text: #b02a3a; --red-soft: rgba(211, 59, 76, .1);
    --violet: #7c5cff; --pink: #e0478f; --teal: #1a9e8f; --glow: rgba(47, 107, 240, .3); --scrim: rgba(14, 19, 34, .38);
    --head: rgba(243, 245, 251, .82);
    --shadow: 0 1px 2px rgba(16, 24, 48, .04), 0 8px 24px -14px rgba(16, 24, 48, .18);
    --shadow-up: 0 2px 4px rgba(16, 24, 48, .05), 0 14px 32px -14px rgba(16, 24, 48, .24), 0 0 0 1px var(--line-strong);
    --ring: 0 0 0 3px rgba(47, 107, 240, .32);
    --av-l: 92%; --av-s: 85%; --av-t: 34%;
  }
}
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; min-height: 100vh; color: var(--text); font: 14.5px/1.5 var(--sans); -webkit-font-smoothing: antialiased; overflow-x: hidden;
  background: var(--bg);
}
.atmos {
  position: fixed; inset: 0; z-index: -1; pointer-events: none;
  background:
    radial-gradient(900px 480px at 85% -140px, rgba(79, 140, 255, .18), transparent 70%),
    radial-gradient(700px 400px at -10% 100%, rgba(255, 150, 60, .07), transparent 70%),
    linear-gradient(var(--bg-grid) 1px, transparent 1px), linear-gradient(90deg, var(--bg-grid) 1px, transparent 1px);
  background-size: auto, auto, 48px 48px, 48px 48px;
  -webkit-mask-image: linear-gradient(#000 55%, rgba(0, 0, 0, .35)); mask-image: linear-gradient(#000 55%, rgba(0, 0, 0, .35));
}
::selection { background: var(--blue); color: #fff; }
a { color: var(--blue-text); text-underline-offset: 3px; }
code { font: .9em var(--mono); background: var(--surface-3); padding: 1px 6px; border-radius: 3px; overflow-wrap: anywhere; }
:focus-visible { outline: 2px solid var(--amber); outline-offset: 2px; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.skip { position: absolute; left: 12px; top: -96px; z-index: 50; background: var(--solid); color: var(--text); padding: 8px 14px; border: var(--dash); }
.skip:focus { top: 12px; }
.noscript { text-align: center; padding: 48px 16px; color: var(--muted); }
.mark { width: 26px; height: 26px; flex: none; border-radius: 7px; box-shadow: 0 0 0 1px var(--line), 0 4px 12px -4px rgba(79, 140, 255, .45); }

/* ---------- buttons and fields ---------- */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 36px; padding: 0 14px;
  font: 600 13.5px/1 var(--sans); color: var(--text); text-decoration: none; cursor: pointer; white-space: nowrap;
  background: var(--solid-2); border: 1px solid var(--line-strong); border-radius: 6px;
  transition: background-color .15s ease, border-color .15s ease, box-shadow .2s ease, transform .18s var(--ease), color .15s ease;
}
.btn:hover { background: var(--surface-3); border-color: var(--muted); transform: translateY(-1px); }
.btn:active { transform: translateY(0) scale(.97); transition-duration: .06s; }
.btn:focus-visible { outline: none; box-shadow: var(--ring); }
.btn:disabled { opacity: .55; cursor: default; transform: none; }
.btn-primary { background: #fff; border-color: #fff; color: var(--ink); }
.btn-primary:hover { background: #dfe8ff; border-color: #dfe8ff; color: var(--ink); }
@media (prefers-color-scheme: light) { .btn-primary { background: var(--blue); border-color: var(--blue); color: #fff; } .btn-primary:hover { background: var(--blue-hover); border-color: var(--blue-hover); color: #fff; } }
.btn-sm { min-height: 28px; padding: 0 10px; font-size: 12.5px; }
.btn-quiet { background: transparent; border-style: dashed; }
.btn-ghost { background: transparent; border-color: transparent; color: var(--muted); min-height: 30px; padding: 0 10px; font-weight: 500; }
.btn-ghost:hover { background: var(--surface-3); border-color: transparent; color: var(--text); transform: none; }
.btn-block { width: 100%; }
.field {
  width: 100%; min-width: 0; font: inherit; color: var(--text); background: var(--solid);
  border: var(--dash); border-radius: 4px; padding: 9px 12px;
  transition: border-color .15s ease, box-shadow .15s ease;
}
.field::placeholder { color: var(--faint); }
.field:hover { border-color: var(--line-strong); }
.field:focus { outline: none; border: 1px solid var(--blue); box-shadow: var(--ring); }
.field:disabled { opacity: .6; }
.switch {
  appearance: none; -webkit-appearance: none; flex: none; position: relative; width: 34px; height: 20px; margin: 0; cursor: pointer;
  border-radius: 999px; background: var(--line-strong); transition: background-color .18s ease;
}
.switch::before { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, .25); transition: transform .18s ease; }
.switch:checked { background: var(--amber); }
.switch:checked::before { transform: translateX(14px); }
.switch:focus-visible { outline: none; box-shadow: var(--ring); }

/* ---------- avatars ---------- */
.avatar {
  --h: 215; display: inline-grid; place-items: center; flex: none; width: 36px; height: 36px; border-radius: 50%;
  font: 650 13px/1 var(--mono); letter-spacing: .02em; user-select: none;
  background: hsl(var(--h) var(--av-s) var(--av-l)); color: hsl(var(--h) 70% var(--av-t));
  box-shadow: 0 0 0 1px hsl(var(--h) 60% 50% / .35) inset;
}
.avatar.sm { width: 28px; height: 28px; font-size: 11px; }
.t0 { --h: 218; } .t1 { --h: 26; } .t2 { --h: 156; } .t3 { --h: 266; } .t4 { --h: 336; } .t5 { --h: 188; } .t6 { --h: 44; } .t7 { --h: 4; }

/* ---------- header ---------- */
.top { position: sticky; top: 0; z-index: 20; background: var(--head); -webkit-backdrop-filter: saturate(1.4) blur(14px); backdrop-filter: saturate(1.4) blur(14px); border-bottom: var(--dash); }
.top-inner { display: flex; align-items: center; gap: 10px; max-width: 1320px; margin: 0 auto; padding: 0 24px; height: 58px; }
.brand { display: inline-flex; align-items: center; gap: 10px; font: 700 15px var(--mono); letter-spacing: -.02em; }
.slash { color: var(--line-strong); font-size: 20px; font-weight: 300; }
.picker { min-width: 0; }
.picker select {
  max-width: min(360px, 40vw); font: 500 13px/1 var(--mono); color: var(--text); background: transparent; border: 1px solid transparent;
  border-radius: 4px; padding: 7px 8px; cursor: pointer; text-overflow: ellipsis; transition: background-color .15s ease, border-color .15s ease;
}
.picker select:hover:not(:disabled) { background: var(--surface-3); }
.picker select:focus-visible { outline: none; box-shadow: var(--ring); }
.picker select:disabled { cursor: default; appearance: none; -webkit-appearance: none; opacity: 1; }
.grow { flex: 1; }
.pill {
  display: inline-flex; align-items: center; gap: 7px; height: 28px; padding: 0 11px; border-radius: 999px; flex: none;
  font: 600 11px/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--muted); background: transparent; border: var(--dash);
  transition: color .2s ease, background-color .2s ease, border-color .2s ease;
}
.pill-dot { position: relative; width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
.pill.running { color: var(--green-text); border-color: rgba(61, 220, 151, .5); border-style: solid; }
.pill.running .pill-dot::after { content: ""; position: absolute; inset: 0; border-radius: 50%; background: currentColor; animation: pulse 2.2s ease-out infinite; }
.pill.polling, .pill.paused { color: var(--amber-text); border-color: var(--amber-line); }
.pill.refused { color: var(--red-text); border-color: var(--red); }
@keyframes pulse { 0% { transform: scale(1); opacity: .55; } 80%, 100% { transform: scale(2.8); opacity: 0; } }
.me { display: inline-flex; align-items: center; gap: 8px; min-width: 0; padding-left: 6px; }
.me .avatar { width: 30px; height: 30px; font-size: 11.5px; }
.me-name { font: 600 13px var(--mono); max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---------- layout ---------- */
.shell { max-width: 1320px; margin: 0 auto; padding: 18px 24px 40px; }
.grid { display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr) minmax(320px, 420px); align-items: start; outline: none; }
.col { display: grid; gap: 16px; min-width: 0; min-height: 80px; align-content: start; }
.col.over { outline: 1px dashed var(--blue); outline-offset: 6px; }
.panel { background: var(--surface); border: var(--dash); min-width: 0; position: relative; transition: box-shadow .3s ease, opacity .2s ease; scroll-margin-top: 76px; }
.panel::before, .panel::after { content: "+"; position: absolute; top: -9px; font: 13px/1 var(--mono); color: var(--faint); background: var(--bg); padding: 0 3px; pointer-events: none; }
.panel::before { left: -5px; } .panel::after { right: -5px; }
.panel:focus { outline: none; }
.panel:focus-visible { box-shadow: var(--ring); }
.panel.dragging { opacity: .35; }
.panel.folded .panel-body { display: none; }
.panel.folded .fold svg { transform: rotate(-90deg); }
.drop-slot { height: 10px; border: 1px dashed var(--blue); background: var(--blue-soft); border-radius: 2px; }
.panel-head { display: flex; align-items: center; gap: 8px; padding: 12px 14px 12px 10px; border-bottom: var(--dash); }
.panel-body { padding: 0; }
h2, h3 { margin: 0; font: 600 11px/1.2 var(--mono); text-transform: uppercase; letter-spacing: .12em; color: var(--text); }
h3 { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; color: var(--blue-text); }
.grip { display: inline-grid; place-items: center; width: 22px; height: 24px; padding: 0; border: 0; background: transparent; color: var(--faint); cursor: grab; border-radius: 3px; flex: none; }
.grip:hover { color: var(--text); background: var(--surface-3); }
.grip:active { cursor: grabbing; }
.grip:focus-visible { outline: none; box-shadow: var(--ring); color: var(--text); }
.grip .i { width: 14px; height: 14px; }
.fold { margin-left: 2px; display: inline-grid; place-items: center; width: 26px; height: 26px; padding: 0; border: 0; background: transparent; color: var(--faint); cursor: pointer; border-radius: 3px; flex: none; }
.fold:hover { color: var(--text); background: var(--surface-3); }
.fold:focus-visible { outline: none; box-shadow: var(--ring); }
.fold svg { width: 14px; height: 14px; transition: transform .2s var(--ease); }
.count { display: inline-grid; place-items: center; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 999px; font: 600 11px/1 var(--mono); letter-spacing: 0; color: var(--muted); background: var(--surface-3); }
.count-hot { color: #fff; background: var(--amber); }
.demo-banner, .banner, .notice { display: flex; align-items: center; gap: 10px; margin: 0 0 16px; padding: 10px 14px; font-size: 13.5px; border: 1px dashed var(--amber-line); background: var(--amber-soft); color: var(--amber-text); }
.banner::before { content: ""; flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--amber); }
.notice { border-color: var(--line-strong); background: var(--surface); color: var(--text-2); }
.demo-banner { border-color: rgba(79, 140, 255, .5); background: var(--blue-soft); color: var(--text-2); flex-wrap: wrap; }
.demo-tag { font: 700 10.5px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--ink); background: var(--blue-text); padding: 5px 7px; }
.demo-hint { margin-left: auto; font: 12px var(--mono); color: var(--blue-text); }
.empty { list-style: none; display: flex; align-items: center; gap: 10px; padding: 18px 16px; border: var(--dash); color: var(--muted); font-size: 13.5px; margin: 14px 16px; }
.empty::before { content: ""; flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--line-strong); }

/* ---------- lane map ---------- */
.lanes-map { padding: 10px 16px 6px; }
.lanes-map svg { width: 100%; height: auto; display: block; }
.lane-row { cursor: pointer; }
.lane-row:focus { outline: none; }
.lane-row:focus-visible .lane-bar, .lane-row:hover .lane-bar { stroke: var(--blue); }
.lane-file { font: 12px var(--mono); fill: var(--text); }
.lane-row.quiet .lane-file { fill: var(--muted); }
.lane-bar { stroke: var(--line-strong); stroke-width: 10; stroke-linecap: round; fill: none; }
.lane-row.quiet .lane-bar { stroke: var(--line-s); stroke-dasharray: 2 6; }
.lane-flow { stroke: var(--blue-text); stroke-width: 2; stroke-dasharray: 3 9; stroke-linecap: round; fill: none; opacity: .75; animation: flow 1.4s linear infinite; }
.lane-row.quiet .lane-flow { display: none; }
@keyframes flow { to { stroke-dashoffset: -12; } }
.lane-dot { stroke: var(--bg); stroke-width: 2; }
.lane-dot.wait { fill: none; stroke: var(--amber); stroke-dasharray: 3 3; stroke-width: 1.8; animation: spin 6s linear infinite; transform-box: fill-box; transform-origin: center; }
.lane-ini { font: 650 9.5px var(--mono); fill: var(--ink); text-anchor: middle; pointer-events: none; }
.lane-ini.wait { fill: var(--amber-text); }
.lane-label { font: 11px var(--mono); fill: var(--muted); }
.lane-label.wait { fill: var(--amber-text); }
.lane-label.hold { fill: var(--green-text); }
.lanes-legend { list-style: none; margin: 0; padding: 0 16px 12px; display: flex; flex-wrap: wrap; gap: 14px; font: 11px var(--mono); color: var(--muted); letter-spacing: .04em; }
.lanes-legend li { display: inline-flex; align-items: center; gap: 6px; }
.lg { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
.lg-hold { background: var(--green); }
.lg-wait { border: 1.5px dashed var(--amber); }
.lg-quiet { border: 1.5px dashed var(--line-strong); }

/* ---------- people ---------- */
.people { list-style: none; margin: 0; padding: 14px 16px 16px; display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(270px, 1fr)); align-items: start; }
.people > .empty { grid-column: 1 / -1; margin: 0; }
.person {
  min-width: 0; border: var(--dash); background: var(--surface-2); padding: 14px;
  position: relative; transition: border-color .2s ease, box-shadow .25s ease, transform .25s var(--ease);
}
.person::before { content: ""; position: absolute; left: 0; right: 0; top: -1px; height: 2px; background: hsl(var(--h) 80% 60%); opacity: .9; }
.person:hover, .person:focus-within { border-style: solid; border-color: var(--line-strong); box-shadow: var(--shadow); transform: translateY(-2px); }
.person:focus { outline: none; box-shadow: var(--ring); }
.person.mine { background: linear-gradient(180deg, var(--blue-soft), transparent 70%), var(--surface-2); }
.person-head { display: flex; align-items: center; gap: 11px; }
.avatar-wrap { position: relative; flex: none; }
.presence { position: absolute; right: -1px; bottom: -1px; width: 11px; height: 11px; border-radius: 50%; border: 2px solid var(--solid); background: var(--muted); }
.presence.working { background: var(--green); }
.presence.waiting { background: var(--amber); }
.presence.blocked { background: var(--red); }
.person-id { min-width: 0; flex: 1; }
.person-name { display: flex; align-items: center; gap: 6px; font-weight: 650; font-size: 14.5px; }
.person-name .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.you { font: 600 10px/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--blue-text); border: 1px dashed var(--blue-text); padding: 3px 5px; }
.person-sub { color: var(--muted); font-size: 12.5px; }
.agents { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 8px; }
.agent { background: var(--solid); border: var(--dash); padding: 10px 12px; min-width: 0; }
.agent.is-waiting { border-color: var(--amber-line); background: linear-gradient(180deg, var(--amber-soft), var(--solid)); }
.agent-top { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 12.5px; color: var(--muted); }
.where { font-family: var(--mono); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.state { display: inline-flex; align-items: center; gap: 5px; flex: none; font: 600 10.5px/1 var(--mono); letter-spacing: .06em; text-transform: uppercase; padding: 4px 8px 4px 7px; border-radius: 999px; color: var(--muted); background: var(--surface-3); }
.state::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.s-working { color: var(--green-text); background: var(--green-soft); }
.s-waiting { color: var(--amber-text); background: var(--amber-soft); box-shadow: 0 0 0 1px var(--amber-line) inset; }
.s-blocked { color: var(--red-text); background: var(--red-soft); }
.task { margin-top: 7px; font-weight: 550; overflow-wrap: anywhere; }
.task.quiet { font-weight: 400; color: var(--muted); }
.wait { margin-top: 7px; font-size: 13px; color: var(--amber-text); overflow-wrap: anywhere; }
.wait code { background: var(--amber-soft); box-shadow: 0 0 0 1px var(--amber-line) inset; color: inherit; }
.chips { list-style: none; margin: 9px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 5px; }
.chips > li { max-width: 100%; min-width: 0; }
.chip { display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 11.5px/1 var(--mono); padding: 5px 7px; color: var(--text-2); background: transparent; border: var(--dash); }
button.chip { cursor: pointer; transition: border-color .15s ease, color .15s ease, background-color .15s ease, transform .18s var(--ease); }
button.chip:hover { border-color: var(--blue); color: var(--blue-text); background: var(--blue-soft); transform: translateY(-1px); }
button.chip:active { transform: scale(.96); }
button.chip:focus-visible { outline: none; box-shadow: var(--ring); }
.chip.hit { border-color: var(--blue); color: var(--blue-text); background: var(--blue-soft); }
.chip.more { color: var(--muted); }
.person-foot { margin-top: 10px; display: flex; justify-content: flex-end; }

/* ---------- requests ---------- */
.panel-sub { margin-left: auto; font: 11.5px var(--mono); color: var(--faint); letter-spacing: .02em; }
.reqs { list-style: none; margin: 0; padding: 14px 16px 16px; display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); align-items: start; }
.reqs > .empty { grid-column: 1 / -1; margin: 0; }
.reqs-sent { padding-bottom: 4px; }
.req { position: relative; border: var(--dash); padding: 12px 14px; background: var(--surface-2); min-width: 0; transition: border-color .2s ease, box-shadow .25s ease, transform .25s var(--ease); }
.req.inbox { background: var(--solid); border: 1px solid var(--amber-line); box-shadow: 0 0 24px -12px var(--amber); }
.req.inbox:hover, .req.inbox:focus-within { border-color: var(--amber); transform: translateY(-2px); }
.req.inbox:focus { outline: none; box-shadow: var(--ring); }
.req-head { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; font-size: 13.5px; }
.req-who { flex: 1; min-width: 0; color: var(--text-2); }
.req-who strong { color: var(--text); }
.req-text { margin: 8px 0 0; font-size: 14px; white-space: pre-wrap; overflow-wrap: anywhere; }
.req-foot { display: flex; align-items: center; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
.left { font: 12px var(--mono); color: var(--muted); margin-right: auto; font-variant-numeric: tabular-nums; }
.left.soon { color: var(--amber-text); }
.badge { display: inline-flex; align-items: center; flex: none; font: 600 10px/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; padding: 4px 7px; color: var(--muted); border: var(--dash); }
.scope-read { color: var(--blue-text); border-color: var(--blue-text); }
.scope-edit { color: var(--amber-text); border-color: var(--amber); }
.st-pending { color: var(--blue-text); border-color: var(--blue-text); }
.st-approved, .st-delivered { color: var(--green-text); border-color: var(--green); }
.st-denied { color: var(--red-text); border-color: var(--red); }
.when { font: 12px var(--mono); color: var(--muted); }
.reply { margin: 10px 0 0; padding: 8px 12px; border-left: 2px solid var(--green); background: var(--solid); }
.reply-label { display: block; font: 10.5px var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin-bottom: 4px; }
.reply p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.ask { margin: 14px 16px 16px; padding: 16px; background: var(--surface-2); border: var(--dash); }
.ask h3 { margin-bottom: 2px; }
.hint { margin: 0 0 12px; color: var(--muted); font-size: 12.5px; }
.ask-row { display: grid; gap: 10px; grid-template-columns: minmax(120px, 180px) minmax(0, 1fr); }
.field-wrap { display: grid; gap: 5px; min-width: 0; }
.field-label { font: 600 10.5px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
.ask-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 12px; flex-wrap: wrap; }
.toggle { display: inline-flex; align-items: center; gap: 9px; font-size: 13px; color: var(--text-2); cursor: pointer; }

/* ---------- chat ---------- */
.chat-panel { position: sticky; top: 76px; display: flex; flex-direction: column; }
.chat-body { display: flex; flex-direction: column; height: calc(100vh - 150px); min-height: 400px; overflow: hidden; }
.chat-panel.folded .chat-body { display: none; }
.messages { list-style: none; margin: 0; padding: 14px 16px; flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; overscroll-behavior: contain; }
.messages > :first-child { margin-top: auto; }
.messages > .empty { margin: 0 0 auto; }
.msg { display: flex; gap: 10px; align-items: flex-start; min-width: 0; }
.msg-body { min-width: 0; flex: 1; display: flex; flex-direction: column; align-items: flex-start; gap: 3px; }
.msg-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 1px; }
.msg-who { font: 650 12.5px var(--mono); }
.msg-time { font: 11px var(--mono); color: var(--faint); }
.bubble { margin: 0; max-width: 100%; padding: 7px 11px; background: var(--surface-2); border: var(--dash); white-space: pre-wrap; overflow-wrap: anywhere; }
.msg.mine { flex-direction: row-reverse; }
.msg.mine .msg-body { align-items: flex-end; }
.msg.mine .msg-head { flex-direction: row-reverse; }
.msg.mine .bubble { background: var(--blue-soft); border-color: rgba(79, 140, 255, .5); }
.mention { font-weight: 600; color: var(--blue-text); background: var(--blue-soft); padding: 0 3px; }
.msg.mine .mention { background: var(--solid); }
.mention.to-me { color: var(--amber-text); background: var(--amber-soft); box-shadow: 0 0 0 1px var(--amber-line) inset; }
.composer { position: sticky; bottom: 0; display: flex; align-items: flex-end; gap: 8px; padding: 12px; border-top: var(--dash); background: var(--solid); }
.composer-field { position: relative; flex: 1; min-width: 0; display: flex; }
.composer .field { resize: none; field-sizing: content; min-height: 40px; max-height: 140px; line-height: 1.45; }
.btn-send { width: 40px; height: 40px; padding: 0; flex: none; }
.btn-send svg { width: 16px; height: 16px; }

/* ---------- sign-in ---------- */
.signin { min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; }
.signin-card { width: min(420px, 100%); padding: 36px 32px 28px; text-align: center; background: var(--surface); border: var(--dash); box-shadow: var(--shadow); }
.signin-card .mark { width: 52px; height: 52px; border-radius: 14px; margin: 0 auto 18px; }
.signin-card h1 { margin: 0; font: 700 22px var(--mono); letter-spacing: -.02em; }
.lead { margin: 8px 0 22px; color: var(--muted); }
.reason { margin: 0 0 18px; padding: 10px 12px; font-size: 13.5px; color: var(--red-text); background: var(--red-soft); text-align: left; border: 1px dashed var(--red); }
.gh { display: grid; gap: 12px; margin-bottom: 20px; }
.btn-github { min-height: 44px; font-size: 14.5px; background: #1f2328; border-color: #1f2328; color: #fff; }
.btn-github:hover { background: #32383f; border-color: #32383f; color: #fff; }
.gh-mark { width: 18px; height: 18px; }
.gh-code { display: grid; gap: 12px; }
.step { margin: 0; font-size: 13px; color: var(--muted); }
.code-row { display: flex; align-items: center; gap: 8px; }
.user-code { flex: 1; display: block; padding: 12px; font: 650 26px/1.1 var(--mono); letter-spacing: .14em; background: var(--solid); border: 1px dashed var(--line-strong); user-select: all; }
.code-row .btn { min-height: 52px; }
.btn-block { min-height: 42px; }
.waiting-line { display: flex; align-items: center; justify-content: center; gap: 9px; margin: 2px 0 0; font-size: 13px; color: var(--muted); }
.spinner { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--line-strong); border-top-color: var(--blue); animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.gh-error { display: grid; gap: 10px; }
.gh-error p { margin: 0; padding: 10px 12px; font-size: 13.5px; color: var(--red-text); background: var(--red-soft); text-align: left; overflow-wrap: anywhere; }
.fallback { margin: 0; padding-top: 18px; border-top: var(--dash); font-size: 13px; color: var(--muted); }

/* ---------- header tools ---------- */
.i { width: 16px; height: 16px; flex: none; }
.kbd { display: inline-grid; place-items: center; min-width: 20px; height: 20px; padding: 0 5px; font: 600 11px/1 var(--mono); color: var(--muted); background: var(--solid); border: 1px solid var(--line-strong); border-bottom-width: 2px; white-space: nowrap; }
.cmdk {
  display: inline-flex; align-items: center; gap: 8px; height: 36px; padding: 0 6px 0 11px; min-width: 0; cursor: pointer;
  font: 500 13px/1 var(--sans); color: var(--muted); background: transparent; border: var(--dash);
  transition: border-color .15s ease, color .15s ease;
}
.cmdk:hover { color: var(--text); border-color: var(--line-strong); }
.cmdk:focus-visible, .icon-btn:focus-visible { outline: none; box-shadow: var(--ring); }
.cmdk-text { padding-right: 24px; }
.icon-btn {
  position: relative; display: inline-grid; place-items: center; flex: none; width: 36px; height: 36px; padding: 0; cursor: pointer;
  font: 650 15px/1 var(--mono); color: var(--muted); background: transparent; border: 1px solid transparent;
  transition: background-color .15s ease, color .15s ease, transform .18s var(--ease);
}
.icon-btn:hover { background: var(--surface-3); color: var(--text); }
.icon-btn:active { transform: scale(.92); }
.icon-btn .i { width: 18px; height: 18px; }
#notify[aria-pressed="true"] { color: var(--blue-text); background: var(--blue-soft); }
#notify.ring .i { animation: ring .7s var(--ease); transform-origin: 50% 10%; }
@keyframes ring { 0%, 100% { transform: rotate(0); } 20% { transform: rotate(16deg); } 40% { transform: rotate(-12deg); } 60% { transform: rotate(8deg); } 80% { transform: rotate(-4deg); } }
.jump-chat { display: none; }
.dot-count { position: absolute; top: 2px; right: 1px; display: grid; place-items: center; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px; font: 700 10px/1 var(--mono); color: #fff; background: var(--pink); box-shadow: 0 0 0 2px var(--bg); animation: pop .35s var(--spring); }
.pill.pop { animation: pop .4s var(--spring); }
@keyframes pop { 0% { transform: scale(.8); } 60% { transform: scale(1.08); } 100% { transform: scale(1); } }

/* ---------- panel accents, filter ---------- */
.tag { flex: none; width: 8px; height: 8px; border-radius: 2px; }
.tag-blue { background: var(--blue); box-shadow: 0 0 10px var(--blue); }
.tag-green { background: var(--green); box-shadow: 0 0 10px var(--green); }
.tag-orange { background: var(--amber); box-shadow: 0 0 10px var(--amber); }
.tag-violet { background: var(--violet); box-shadow: 0 0 10px var(--violet); }
.tag-pink { background: var(--pink); box-shadow: 0 0 10px var(--pink); }
.tag-teal { background: var(--teal); box-shadow: 0 0 10px var(--teal); }
.filter { position: relative; display: flex; align-items: center; margin-left: auto; min-width: 0; color: var(--muted); }
.filter .i { position: absolute; left: 10px; width: 14px; height: 14px; pointer-events: none; }
.filter-input { width: 220px; height: 30px; padding: 0 10px 0 31px; font: 12.5px/1 var(--mono); color: var(--text); background: var(--solid); border: var(--dash); transition: width .25s var(--ease), border-color .15s ease, box-shadow .15s ease; }
.filter-input::placeholder { color: var(--faint); }
.filter-input:hover { border-color: var(--line-strong); }
.filter-input:focus { outline: none; width: 280px; border: 1px solid var(--blue); box-shadow: var(--ring); }
.filter-input:not(:placeholder-shown) { border-color: var(--blue); background: var(--blue-soft); }
.filter-sum { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 12px 16px -4px; font-size: 13px; color: var(--text-2); }
.filter-sum code { color: var(--blue-text); background: var(--blue-soft); }
.empty .btn { margin-left: auto; }
.empty-q { overflow-wrap: anywhere; }

/* ---------- person actions ---------- */
.person-actions { display: flex; gap: 2px; margin-left: auto; transition: opacity .2s ease; }
.person-actions .btn-ghost { min-height: 28px; padding: 0 8px; font-size: 12.5px; }
@media (hover: hover) {
  .person:not(:hover):not(:focus-within) .person-actions .btn-ghost:not(.keep) { opacity: 0; }
  .person-actions .btn-ghost { transition: opacity .2s ease, background-color .15s ease, color .15s ease; }
}

/* ---------- motion: enter, live change, leave ---------- */
.enter { animation: enter .42s var(--ease) both; }
.d1 { animation-delay: 40ms; } .d2 { animation-delay: 80ms; } .d3 { animation-delay: 120ms; } .d4 { animation-delay: 160ms; } .d5 { animation-delay: 200ms; } .d6 { animation-delay: 240ms; } .d7 { animation-delay: 280ms; } .d8 { animation-delay: 320ms; }
@keyframes enter { from { opacity: 0; transform: translateY(10px) scale(.985); } to { opacity: 1; transform: none; } }
.flash { position: relative; }
.flash::after { content: ""; position: absolute; inset: -1px; pointer-events: none; box-shadow: 0 0 0 2px var(--blue), 0 0 24px 2px var(--glow); opacity: 0; animation: flash 1.6s ease-out; }
@keyframes flash { 0% { opacity: 0; } 12% { opacity: 1; } 100% { opacity: 0; } }
.gone { pointer-events: none; animation: leave .5s var(--ease) .55s both; }
.gone-deny { animation-name: leave-left; animation-delay: .25s; }
.gone-approve { border-color: var(--green) !important; }
@keyframes leave { to { opacity: 0; transform: translateY(-6px) scale(.96); } }
@keyframes leave-left { to { opacity: 0; transform: translateX(-24px); } }
.btn-ok { background: var(--green); border-color: var(--green); color: var(--ink); animation: pop .45s var(--spring); }
.btn-ok:disabled { opacity: 1; }
.check { width: 16px; height: 16px; }
.check path { stroke-dasharray: 16; stroke-dashoffset: 16; animation: draw .4s var(--ease) .08s forwards; }
@keyframes draw { to { stroke-dashoffset: 0; } }
.busy::before { content: ""; width: 12px; height: 12px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: spin .7s linear infinite; }

/* ---------- skeletons ---------- */
.skel { list-style: none; position: relative; overflow: hidden; border: var(--dash); background: var(--surface-2); padding: 14px; display: grid; gap: 9px; margin: 14px 16px 0; }
.skel span { display: block; height: 10px; background: var(--surface-3); }
.skel span:nth-child(1) { width: 40%; height: 12px; } .skel span:nth-child(2) { width: 85%; } .skel span:nth-child(3) { width: 62%; }
.skel::after { content: ""; position: absolute; inset: 0; transform: translateX(-100%); background: linear-gradient(90deg, transparent, rgba(150, 172, 235, .08), transparent); animation: shimmer 1.4s ease-in-out infinite; }
@keyframes shimmer { to { transform: translateX(100%); } }

/* ---------- activity ---------- */
.activity { list-style: none; margin: 0; padding: 12px 16px 16px; display: grid; gap: 2px; }
.act { position: relative; display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; gap: 10px; align-items: start; padding: 7px 8px; transition: background-color .15s ease; }
.act:hover { background: var(--surface-2); }
.act::before { content: ""; position: absolute; left: 21px; top: 36px; bottom: -6px; width: 0; border-left: 1px dashed var(--line); }
.act:last-child::before { display: none; }
.act .avatar { position: relative; }
.act-ico { position: absolute; left: 28px; top: 26px; width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--solid); background: var(--muted); }
.a-start { background: var(--blue); } .a-done { background: var(--green); } .a-wait { background: var(--amber); } .a-problem { background: var(--red); }
.a-ask { background: var(--violet); } .a-approved { background: var(--green); } .a-declined { background: var(--red); } .a-reply { background: var(--pink); }
.act-text { margin: 0; padding-top: 4px; font-size: 13.5px; color: var(--text-2); overflow-wrap: anywhere; }
.act-text strong { color: var(--text); font-weight: 650; }
.act-subject { color: var(--text); }
.act-time { padding-top: 5px; font: 11.5px var(--mono); color: var(--faint); white-space: nowrap; }
.activity > .empty { margin: 0; }

/* ---------- chat extras ---------- */
.bubble.enter { animation: bubble .38s var(--spring) both; transform-origin: 0 0; }
.msg.mine .bubble.enter { transform-origin: 100% 0; }
@keyframes bubble { from { opacity: 0; transform: translateY(6px) scale(.94); } to { opacity: 1; transform: none; } }
.new-pill { position: absolute; left: 50%; bottom: 78px; z-index: 2; display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px 0 14px; border-radius: 999px; border: 0; cursor: pointer; font: 600 12px/1 var(--mono); color: var(--ink); background: #fff; transform: translateX(-50%); animation: rise .3s var(--spring); }
.new-pill:hover { background: #dfe8ff; }
.new-pill:focus-visible { outline: none; box-shadow: var(--ring); }
.new-pill .i { width: 14px; height: 14px; }
@keyframes rise { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translateX(-50%); } }
.counter { font: 11px var(--mono); color: var(--faint); font-variant-numeric: tabular-nums; }
.counter.near { color: var(--amber-text); font-weight: 600; }
.counter-float { position: absolute; right: 10px; bottom: -18px; }
.composer { padding-bottom: 20px; }
.btn-send .i { width: 16px; height: 16px; transition: transform .2s var(--ease); }
.btn-send:hover .i { transform: translateX(2px); }
.btn-send.sent .i { animation: fly .45s var(--ease); }
@keyframes fly { 0% { transform: none; } 45% { transform: translate(12px, -10px); opacity: 0; } 55% { transform: translate(-10px, 8px); opacity: 0; } 100% { transform: none; opacity: 1; } }

/* ---------- request composer ---------- */
.label-row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.ask textarea.field { resize: none; field-sizing: content; min-height: 40px; max-height: 160px; line-height: 1.45; }
.sugg { display: flex; flex-wrap: wrap; gap: 5px; min-height: 0; }
.sugg:empty { display: none; }
.sugg-btn { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 9px 0 3px; border-radius: 999px; cursor: pointer; font: 500 12.5px/1 var(--sans); color: var(--text-2); background: transparent; border: var(--dash); transition: border-color .15s ease, transform .18s var(--ease), background-color .15s ease; }
.sugg-btn .avatar { width: 20px; height: 20px; font-size: 9px; }
.sugg-btn:hover { border-color: var(--blue); background: var(--blue-soft); transform: translateY(-1px); }
.sugg-btn:focus-visible { outline: none; box-shadow: var(--ring); }
.scope-note { flex: 1; min-width: 180px; margin: 0; font-size: 12.5px; color: var(--muted); }
.scope-note strong { color: var(--text-2); }
.scope-note.edit strong { color: var(--amber-text); }

/* ---------- toasts ---------- */
.toasts { position: fixed; z-index: 60; left: 24px; bottom: 24px; width: min(420px, calc(100vw - 32px)); display: grid; gap: 8px; pointer-events: none; }
.toast { pointer-events: auto; display: flex; align-items: center; gap: 10px; padding: 10px 10px 10px 14px; font-size: 13.5px; color: var(--text); background: var(--solid); border: 1px solid var(--line-strong); box-shadow: 0 18px 40px -16px rgba(0, 0, 0, .55); animation: toast-in .32s var(--spring); }
.toast::before { content: ""; flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--blue); box-shadow: 0 0 10px var(--blue); }
.toast.ok::before { background: var(--green); box-shadow: 0 0 10px var(--green); }
.toast.error { border-color: var(--red); }
.toast.error::before { background: var(--red); box-shadow: 0 0 10px var(--red); }
.toast-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.toast .btn { min-height: 28px; padding: 0 10px; font-size: 12.5px; }
.toast-x { width: 28px; height: 28px; font-size: 16px; }
.toast.out { animation: toast-out .2s ease-in forwards; }
@keyframes toast-in { from { opacity: 0; transform: translateY(14px) scale(.96); } to { opacity: 1; transform: none; } }
@keyframes toast-out { to { opacity: 0; transform: translateY(8px) scale(.97); } }

/* ---------- dialogs: palette and shortcuts ---------- */
dialog { padding: 0; border: 1px solid var(--line-strong); color: var(--text); background: var(--solid); box-shadow: 0 30px 80px -24px rgba(0, 0, 0, .6); max-width: calc(100vw - 32px); }
dialog::backdrop { background: var(--scrim); -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px); }
dialog[open] { animation: dialog-in .24s var(--ease); }
@keyframes dialog-in { from { opacity: 0; transform: translateY(-8px) scale(.98); } to { opacity: 1; transform: none; } }
.palette { width: 580px; margin: 12vh auto auto; overflow: hidden; }
.pal-search { display: flex; align-items: center; gap: 10px; padding: 0 14px; border-bottom: var(--dash); color: var(--muted); }
.pal-search .i { width: 18px; height: 18px; }
.pal-input { flex: 1; min-width: 0; height: 54px; border: 0; outline: none; font: 15px/1 var(--sans); color: var(--text); background: transparent; }
.pal-input::placeholder { color: var(--faint); }
.pal-list { list-style: none; margin: 0; padding: 6px; max-height: min(420px, 56vh); overflow-y: auto; }
.pal-item { display: flex; align-items: center; gap: 10px; padding: 9px 10px; cursor: pointer; font-size: 14px; transition: background-color .12s ease, transform .15s var(--ease); }
.pal-item .avatar { width: 24px; height: 24px; font-size: 10px; }
.pal-ico { display: inline-grid; place-items: center; width: 24px; height: 24px; flex: none; color: var(--muted); border: var(--dash); }
.pal-ico .i { width: 14px; height: 14px; }
.pal-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pal-hint { font: 11px var(--mono); letter-spacing: .06em; text-transform: uppercase; color: var(--faint); }
.pal-item.active { background: var(--blue-soft); transform: translateX(2px); }
.pal-item.active .pal-hint { color: var(--blue-text); }
.pal-empty { padding: 18px 12px; color: var(--muted); font-size: 13.5px; }
.pal-foot { display: flex; gap: 16px; margin: 0; padding: 9px 14px; border-top: var(--dash); font: 12px var(--mono); color: var(--faint); }
.pal-foot .kbd { margin-right: 3px; }
.help { width: 460px; margin: 10vh auto auto; padding: 18px 20px 16px; }
.help-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.help-head h2 { font: 650 16px/1.2 var(--sans); text-transform: none; letter-spacing: -.01em; color: var(--text); }
.help-list { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px 16px; margin: 0; align-items: center; }
.help-list dt { display: flex; gap: 4px; justify-content: flex-end; }
.help-list dd { margin: 0; font-size: 13.5px; color: var(--text-2); }
.help-foot { margin: 14px 0 0; padding-top: 12px; border-top: var(--dash); font-size: 12.5px; color: var(--muted); }

/* ---------- small screens ---------- */
@media (max-width: 960px) {
  .grid { grid-template-columns: minmax(0, 1fr); }
  .chat-panel { position: relative; top: auto; }
  .chat-body { height: auto; min-height: 0; overflow: visible; }
  .jump-chat { display: inline-grid; }
  .messages { max-height: 65vh; }
  .composer { position: static; }
  .grip { display: none; }
  .layout-btn { display: none; }
}
@media (max-width: 640px) {
  .top-inner { padding: 0 16px; gap: 8px; height: 56px; }
  .brand-name, .me-name, .slash, .cmdk-text, .cmdk .kbd, .help-btn { display: none; }
  .cmdk, .icon-btn { width: 34px; height: 34px; padding: 0; justify-content: center; }
  .cmdk { border-color: transparent; }
  .picker select { max-width: 30vw; padding: 7px 4px; }
  .me { padding-left: 0; }
  .person-head { flex-wrap: wrap; }
  .person-actions { flex-basis: 100%; margin: 2px 0 -6px 39px; }
  .person-actions .btn-ghost { opacity: 1 !important; }
  .pill { width: 28px; padding: 0; justify-content: center; }
  .pill-text { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .panel-head { flex-wrap: wrap; }
  .filter { order: 9; flex: 1 0 100%; margin: 6px 0 0; }
  .filter-input, .filter-input:focus { width: 100%; }
  .toasts { left: 16px; right: 16px; bottom: 16px; transform: none; width: auto; }
  .scope-note { order: 3; flex-basis: 100%; }
  .shell { padding: 14px 12px 32px; }
  .grid, .col { gap: 14px; }
  .panel-head { padding: 12px 12px 12px 8px; }
  .people { padding: 12px 12px 14px; grid-template-columns: minmax(0, 1fr); }
  .reqs { padding: 12px 12px 14px; grid-template-columns: minmax(0, 1fr); }
  .panel-sub { display: none; }
  .ask { margin: 12px; padding: 14px; }
  .ask-row { grid-template-columns: minmax(0, 1fr); }
  .ask-foot .btn { flex: 1; }
  .messages { padding: 12px; }
  .signin-card { padding: 28px 20px 22px; }
  .user-code { font-size: 22px; letter-spacing: .1em; }
  .demo-hint { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
  .btn:hover, .btn:active, .person:hover, .person:focus-within, .req.inbox:hover, .req.inbox:focus-within, button.chip:hover, .icon-btn:hover, .cmdk:hover { transform: none !important; }
  .gone { opacity: .5; }
  .flash { outline: 2px solid var(--glow); outline-offset: 2px; }
}
`;


// The browser side. No template literals or backslashes in it (it sits inside one); teammate text only ever goes into
// textContent or text nodes, never markup.
const BROWSER = `
var KEY = "lanes-app";
var PATHS = ${JSON.stringify(PATHS)};
var SVG_NS = "http://www.w3.org/2000/svg";
var $ = function (id) { return document.getElementById(id); };
var session = {};
try { session = JSON.parse(sessionStorage.getItem(KEY) || "{}") || {}; } catch (e) {}
var hash = new URLSearchParams(location.hash.slice(1));
if (hash.has("token") || hash.has("user")) {
  // The fragment never reaches the server; keep it for this tab only and take it out of the address bar and history.
  session = { token: hash.get("token") || "", user: hash.get("user") || "", repo: hash.get("repo") || "" };
  save();
  history.replaceState(null, "", location.pathname + location.search);
}
function save() { try { sessionStorage.setItem(KEY, JSON.stringify(session)); } catch (e) {} }
var token = "", me = "", picked = "", snapshot = null, skew = 0, repo = "", repoList = "";

function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function txt(s) { return document.createTextNode(s); }
function same(a, b) { return String(a).toLowerCase() === String(b).toLowerCase(); }
function avatar(name, size) {
  var a = el("span", "avatar t" + avatarTone(name) + (size ? " " + size : ""), initials(name));
  a.setAttribute("aria-hidden", "true");
  return a;
}
function empty(text) { return el("li", "empty", text); }
function notice(text) { $("notice").textContent = text; $("notice").hidden = !text; }
function auth() { return { authorization: "Bearer " + token }; }

// ---------- connection status: never silent about coordination being off (M6) ----------
var PILL = { connecting: "Connecting", running: "Running", polling: "Reconnecting", paused: "Paused", refused: "Refused" };
var BANNER = {
  polling: "Live updates paused, retrying…",
  paused: "Coordination paused: the Lanes server can't be reached. Edits go ahead uncoordinated."
};
var lastStatus = "";
function setStatus(s) {
  $("pill").className = "pill " + s + (lastStatus && lastStatus !== s ? " pop" : "");
  lastStatus = s;
  $("pill-text").textContent = PILL[s];
  $("pill").title = s === "running" ? "Coordination running" : BANNER[s] || PILL[s];
  $("banner-text").textContent = BANNER[s] || "";
  $("banner").hidden = !BANNER[s];
  $("banner-retry").hidden = s !== "paused";
  if (s === "paused") offline();
}

var ws = null, failures = 0, retryTimer = 0, pollTimer = 0, stopped = true;
function connect() {
  if (DEMO) return demoConnect();
  ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/v1/events?token=" + encodeURIComponent(token));
  ws.onopen = function () { failures = 0; stopPolling(); setStatus("running"); };
  ws.onmessage = function (e) {
    var m;
    try { m = JSON.parse(e.data); } catch (x) { return; }
    if (m && m.type === "snapshot") take(m.snapshot);
  };
  ws.onclose = function () {
    ws = null;
    if (stopped) return;
    failures++;
    check();
    retryTimer = setTimeout(connect, Math.min(1000 * Math.pow(2, failures - 1), 30000));
  };
}
// A browser hides why a WebSocket closed: ask over HTTP. 401/403 is the token; 200 means the server is fine and only the
// live stream is down (e.g. its stream limit), so poll every 5 s until the socket is back.
function check() {
  if (DEMO) return Promise.resolve();
  return fetch("/v1/state", { headers: auth() }).then(function (r) {
    if (stopped || (ws && ws.readyState === 1)) return;
    if (r.status === 401 || r.status === 403) return refused();
    if (!r.ok) return setStatus("paused");
    return r.json().then(function (s) {
      if (stopped || (ws && ws.readyState === 1)) return;
      take(s);
      setStatus("polling");
      if (!pollTimer) pollTimer = setInterval(check, 5000);
    });
  }).catch(function () { if (!stopped) setStatus("paused"); });
}
function stopPolling() { clearInterval(pollTimer); pollTimer = 0; }
function take(s) { if (!s || !s.agents) return; snapshot = s; skew = (s.serverTime || Date.now()) - Date.now(); render(); }
function refused() {
  stopped = true;
  stopPolling();
  clearTimeout(retryTimer);
  if (ws) ws.close();
  session.token = "";
  save();
  showSignIn("The Lanes server refused this page's token. Sign in again, or run lanes app for a fresh link.");
}

function post(route, extra) {
  var body = Object.assign({ user: me, sessionId: "app-" + me, repo: repo }, extra);
  if (DEMO) return demoPost(route, body);
  return fetch(route, { method: "POST", headers: Object.assign({ "content-type": "application/json" }, auth()), body: JSON.stringify(body) })
    .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || "the server answered " + r.status); notice(""); return d; }); })
    .catch(function (err) { toast("Could not send: " + (err.message === "Failed to fetch" ? "the Lanes server can't be reached." : err.message), { kind: "error" }); return null; });
}

// ---------- rendering ----------
var STATE = { working: "Working", idle: "Idle", blocked: "Blocked", waiting: "Waiting" };
var RANK = { waiting: 4, blocked: 3, working: 2, idle: 1 };
var REQUEST_STATUS = { pending: "Waiting", approved: "Approved", delivered: "Delivered", denied: "Declined", expired: "Expired" };
var REQUEST_TITLE = { pending: "Waiting for their answer", approved: "Approved", delivered: "Approved and sent to their agent", denied: "Declined", expired: "Expired before an answer" };
var SHORTCUTS = shortcuts();
var MAC = /Mac|iPhone|iPad/.test(navigator.platform || "");
// sigs: what each section last drew, so an unchanged section is left alone (hover and focus survive a snapshot).
// known: item key -> item signature from the last draw, to animate new items in and flash changed ones.
var sigs = {}, known = {}, decided = {}, filterQ = "", readAt = 0, readRepo = null, seenAlerts = null, lastView = null;
var chatSeen = true, sentJustNow = false, lastDecidedIndex = 0, badgeN = -1, suggSig = "";

function motion() { return !matchMedia("(prefers-reduced-motion: reduce)").matches; }
function smooth() { return motion() ? "smooth" : "auto"; }
function changed(sec, sig) { if (sigs[sec] === sig) return false; sigs[sec] = sig; return true; }
function mark(fresh, sec, li, k, sig, i) {
  li.setAttribute("data-k", k);
  var old = known[sec];
  if (!old) li.classList.add("enter", "d" + Math.min(i, 8));
  else if (!(k in old)) li.classList.add("enter");
  else if (old[k] !== sig) li.classList.add("flash");
  fresh[k] = sig;
}
function flash(node) {
  node.classList.remove("flash");
  void node.offsetWidth;
  node.classList.add("flash");
  setTimeout(function () { node.classList.remove("flash"); }, 1700);
}
function byKey(list, k) { return Array.prototype.find.call(list.children, function (c) { return c.getAttribute("data-k") === k; }); }
function focusKey(key) {
  var hit = Array.prototype.find.call(document.querySelectorAll("[data-key]"), function (b) { return b.getAttribute("data-key") === key; });
  if (!hit) return;
  if (hit.disabled && hit.closest(".req")) hit = hit.closest(".req");
  hit.focus({ preventScroll: true });
}
function svgIcon(name, cls) {
  var s = document.createElementNS(SVG_NS, "svg");
  s.setAttribute("viewBox", "0 0 16 16");
  s.setAttribute("class", cls || "i");
  s.setAttribute("aria-hidden", "true");
  s.setAttribute("focusable", "false");
  var p = document.createElementNS(SVG_NS, "path");
  p.setAttribute("d", PATHS[name]);
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "currentColor");
  p.setAttribute("stroke-width", name === "check" ? "2.2" : "1.7");
  p.setAttribute("stroke-linecap", "round");
  p.setAttribute("stroke-linejoin", "round");
  s.appendChild(p);
  return s;
}
function button(cls, text, label, key, run) {
  var b = el("button", cls, text);
  b.type = "button";
  if (label) b.setAttribute("aria-label", label);
  if (key) b.setAttribute("data-key", key);
  b.onclick = run;
  return b;
}

// ---------- toasts: what an action did, with Undo only for page state (the server's state is never undone here) ----------
function toast(text, o) {
  o = o || {};
  var t = el("div", "toast " + (o.kind || "info"));
  if (o.kind === "error") t.setAttribute("role", "alert");
  t.appendChild(el("span", "toast-text", text));
  var timer = 0;
  var close = function () {
    clearTimeout(timer);
    if (!t.parentNode || t.classList.contains("out")) return;
    t.classList.add("out");
    setTimeout(function () { t.remove(); }, motion() ? 200 : 0);
  };
  if (o.action) t.appendChild(button("btn btn-quiet", o.action, "", "", function () { close(); o.run(); }));
  t.appendChild(button("icon-btn toast-x", "×", "Dismiss", "", close));
  var box = $("toasts");
  box.appendChild(t);
  while (box.children.length > 3) box.firstChild.remove();
  var wait = o.action ? 5000 : o.kind === "error" ? 7000 : 4000;
  timer = setTimeout(close, wait);
  t.onmouseenter = function () { clearTimeout(timer); };
  t.onmouseleave = function () { timer = setTimeout(close, 2000); };
  return t;
}
function copyText(text, done) {
  if (!navigator.clipboard) return toast("Copying needs https or localhost.", { kind: "error" });
  navigator.clipboard.writeText(text).then(function () { toast(done, { kind: "ok" }); }, function () { toast("The browser did not allow copying.", { kind: "error" }); });
}

function presence(agents) {
  var best = "idle";
  agents.forEach(function (a) { var s = a.waitingFor ? "waiting" : a.status; if (RANK[s] > RANK[best]) best = s; });
  return best;
}

function agentItem(p, a) {
  var s = a.waitingFor ? "waiting" : a.status;
  var li = el("li", "agent" + (a.waitingFor ? " is-waiting" : ""));
  var top = el("div", "agent-top");
  top.appendChild(el("span", "state s-" + s, STATE[s] || s));
  top.appendChild(el("span", "", p.user + "'s agent"));
  var where = el("span", "where", a.label);
  where.title = a.label;
  top.appendChild(where);
  li.appendChild(top);
  if (a.task) li.appendChild(el("div", "task", a.task));
  else li.appendChild(el("div", "task quiet", a.status === "working" ? "Editing " + (a.lastPath || "files") : "No active task"));
  if (a.waitingFor) {
    var w = el("div", "wait");
    w.appendChild(txt("Waiting for "));
    w.appendChild(el("code", "", a.waitingFor.path));
    w.appendChild(txt(a.waitingFor.holder ? ", held by " + a.waitingFor.holder + "'s agent" : ""));
    li.appendChild(w);
  }
  if (a.files.length) {
    var q = filterQ.trim().toLowerCase();
    var hit = function (f) { return !!q && f.toLowerCase().indexOf(q) >= 0; };
    // Matching files first, so a filter never hides the file it matched behind "+N more".
    var files = a.files.filter(hit).concat(a.files.filter(function (f) { return !hit(f); }));
    var chips = el("ul", "chips");
    chips.setAttribute("aria-label", "Files");
    files.slice(0, 4).forEach(function (f) {
      var c = el("li");
      var b = button("chip" + (hit(f) ? " hit" : ""), f, "Show everyone on " + f, "file:" + p.user + ":" + a.label + ":" + f, function () { setFilter(f); });
      b.title = "Who is on " + f;
      c.appendChild(b);
      chips.appendChild(c);
    });
    if (files.length > 4) {
      var more = el("li", "chip more", "+" + (files.length - 4) + " more");
      more.title = files.slice(4).join(", ");
      chips.appendChild(more);
    }
    li.appendChild(chips);
  }
  return li;
}

function clearButton() { return button("btn btn-quiet btn-sm", "Clear filter", "", "clear-filter", clearFilter); }

function renderPeople(v) {
  if (!changed("people", JSON.stringify([v.people, filterQ]))) return;
  var shown = filterPeople(v.people, filterQ);
  var list = $("people"), fresh = {}, q = filterQ.trim();
  list.replaceChildren();
  $("people-count").textContent = v.people.length ? String(v.people.length) : "";
  $("people-count").hidden = !v.people.length;
  var sum = $("filter-sum");
  sum.replaceChildren();
  sum.hidden = !q || !v.people.length || !shown.length;
  if (!sum.hidden) {
    var file = q.indexOf("/") >= 0 || q.indexOf(".") >= 0;
    var n = shown.length;
    sum.appendChild(txt(file ? (n === 1 ? "1 person on " : n + " people on ") : n + " of " + v.people.length + (v.people.length === 1 ? " person matches " : " people match ")));
    sum.appendChild(el("code", "", q));
    sum.appendChild(clearButton());
  }
  if (!v.people.length) {
    list.appendChild(empty("No agents here yet. They appear as soon as a teammate starts one."));
    known.people = fresh;
    return;
  }
  if (!shown.length) {
    var none = empty("");
    none.appendChild(el("span", "empty-q", "Nobody here matches “" + q + "”."));
    none.appendChild(clearButton());
    list.appendChild(none);
    return;
  }
  shown.forEach(function (p, i) {
    var card = el("li", "person t" + avatarTone(p.user) + (p.mine ? " mine" : ""));
    card.tabIndex = -1;
    var head = el("div", "person-head");
    var wrap = el("span", "avatar-wrap");
    var state = presence(p.agents);
    wrap.appendChild(avatar(p.user));
    var dot = el("span", "presence " + state);
    dot.title = STATE[state];
    wrap.appendChild(dot);
    head.appendChild(wrap);
    var id = el("div", "person-id");
    var name = el("div", "person-name");
    name.appendChild(el("span", "name", p.user));
    if (p.mine) name.appendChild(el("span", "you", "You"));
    id.appendChild(name);
    id.appendChild(el("div", "person-sub", p.agents.length === 1 ? "1 agent · " + STATE[state].toLowerCase() : p.agents.length + " agents · " + STATE[state].toLowerCase()));
    head.appendChild(id);
    // Ask last, so the one always shown stays at the edge while Copy and Mention fade in on hover.
    if (!p.mine) {
      var acts = el("div", "person-actions");
      acts.appendChild(button("btn btn-ghost", "Copy", "Copy the name " + p.user, "copy:" + p.user, function () { copyText(p.user, "Copied “" + p.user + "”."); }));
      acts.appendChild(button("btn btn-ghost", "Mention", "Mention " + p.user + " in the chat", "mention:" + p.user, function () { mentionPrefill(p.user); }));
      acts.appendChild(button("btn btn-ghost keep", "Ask", "Ask " + p.user + "'s agent", "ask:" + p.user, function () { askPrefill(p.user); }));
      head.appendChild(acts);
    }
    card.appendChild(head);
    var agents = el("ul", "agents");
    p.agents.forEach(function (a) { agents.appendChild(agentItem(p, a)); });
    card.appendChild(agents);
    // Signed by the unfiltered person, so narrowing the filter never reads as a live change.
    var full = v.people.find(function (x) { return x.user === p.user; });
    mark(fresh, "people", card, "p:" + p.user.toLowerCase(), JSON.stringify(full.agents), i);
    list.appendChild(card);
  });
  known.people = fresh;
}

function scopeBadge(scope) { return el("span", "badge scope-" + scope, scope === "edit" ? "May edit files" : "Read only"); }
function checkIcon() { return svgIcon("check", "check"); }

function renderInbox(v, now) {
  var rows = v.forMe.slice();
  Object.keys(decided).forEach(function (id) {
    var d = decided[id];
    if (d.state === "done" && d.until < Date.now()) return delete decided[id];
    // Keep a card being answered in its place until its leave animation is over, even if the snapshot already dropped it.
    if (!rows.some(function (r) { return r.id === id; })) rows.splice(Math.min(d.index, rows.length), 0, d.r);
  });
  var live = rows.filter(function (r) { return !decided[r.id] || decided[r.id].state !== "done"; }).length;
  $("inbox-count").textContent = String(live);
  $("inbox-count").hidden = !live;
  $("inbox-sub").textContent = live && matchMedia("(hover: hover)").matches ? "j to select · a approve · d decline" : "Requests waiting for you";
  var sig = JSON.stringify([rows.map(function (r) { return [r.id, r.from, r.text, r.scope, timeLeft(r.expiresAt, now)]; }), Object.keys(decided).map(function (id) { return id + decided[id].kind + decided[id].state; })]);
  if (!changed("inbox", sig)) return;
  var list = $("for-me"), fresh = {};
  list.replaceChildren();
  if (!rows.length) {
    list.appendChild(empty("Nothing waiting for you. Requests from teammates show up here."));
    known.inbox = fresh;
    return;
  }
  rows.forEach(function (r, i) {
    var d = decided[r.id];
    var li = el("li", "req inbox" + (d && d.state === "done" ? " gone gone-" + d.kind : ""));
    li.tabIndex = 0;
    li.setAttribute("data-key", "req:" + r.id);
    li.setAttribute("data-id", r.id);
    li.setAttribute("aria-label", "Request from " + r.from + ", " + (r.scope === "edit" ? "may edit files" : "read only") + ": " + r.text);
    var head = el("div", "req-head");
    head.appendChild(avatar(r.from, "sm"));
    var who = el("span", "req-who");
    who.appendChild(el("strong", "", r.from));
    who.appendChild(txt(" asks your agent"));
    head.appendChild(who);
    head.appendChild(scopeBadge(r.scope));
    li.appendChild(head);
    li.appendChild(el("p", "req-text", r.text));
    var foot = el("div", "req-foot");
    foot.appendChild(el("span", "left" + (r.expiresAt - now < 120000 ? " soon" : ""), timeLeft(r.expiresAt, now)));
    [["Decline", "deny", "btn"], ["Approve", "approve", "btn btn-primary"]].forEach(function (b) {
      var btn = button(b[2], b[0], b[0] + " " + r.from + "'s request", r.id + ":" + b[1], function () { decide(r, b[1]); });
      btn.setAttribute("aria-keyshortcuts", b[1] === "approve" ? "A" : "D");
      if (d) {
        btn.disabled = true;
        if (d.kind === b[1] && d.state === "busy") btn.classList.add("busy");
        if (d.kind === b[1] && d.state === "done") {
          btn.className = b[1] === "approve" ? "btn btn-ok" : "btn btn-quiet";
          btn.replaceChildren();
          if (b[1] === "approve") btn.appendChild(checkIcon());
          btn.appendChild(txt(b[1] === "approve" ? "Approved" : "Declined"));
        }
      }
      foot.appendChild(btn);
    });
    li.appendChild(foot);
    mark(fresh, "inbox", li, "r:" + r.id, "", i);
    list.appendChild(li);
  });
  known.inbox = fresh;
}

function decide(r, kind) {
  if (decided[r.id]) return;
  var order = Array.prototype.map.call($("for-me").querySelectorAll(".req.inbox"), function (x) { return x.getAttribute("data-id"); });
  decided[r.id] = { r: r, kind: kind, state: "busy", index: Math.max(0, order.indexOf(r.id)) };
  render();
  post("/v1/team/decide", { id: r.id, decision: kind }).then(function (d) {
    if (!d) {
      delete decided[r.id];
      render();
      return focusKey(r.id + ":" + kind);
    }
    decided[r.id].state = "done";
    decided[r.id].until = Date.now() + (motion() ? 1100 : 600);
    lastDecidedIndex = decided[r.id].index;
    toast(kind === "approve" ? "Approved. Your agent gets it with your next prompt." : "Declined. " + r.from + " sees it in their sent requests.", { kind: "ok" });
    render();
    setTimeout(function () {
      render();
      // The answered card is gone: keep the keyboard in the inbox, on the next request.
      if (document.activeElement === document.body) {
        var cards = $("for-me").querySelectorAll(".req.inbox:not(.gone)");
        if (cards.length) cards[Math.min(lastDecidedIndex, cards.length - 1)].focus({ preventScroll: true });
        else $("p-inbox").focus({ preventScroll: true });
      }
    }, motion() ? 1150 : 650);
  });
}

function renderSent(v, now) {
  if (!changed("sent", JSON.stringify([v.fromMe, Math.floor(now / 30000)]))) return;
  var list = $("from-me"), fresh = {};
  list.replaceChildren();
  if (!v.fromMe.length) {
    list.appendChild(empty("You haven't asked anyone yet. Use the form below."));
    known.sent = fresh;
    return;
  }
  v.fromMe.forEach(function (r, i) {
    var li = el("li", "req");
    var head = el("div", "req-head");
    var who = el("span", "req-who");
    who.appendChild(txt("To "));
    who.appendChild(el("strong", "", r.to));
    head.appendChild(who);
    var st = el("span", "badge st-" + r.status, REQUEST_STATUS[r.status] || r.status);
    st.title = REQUEST_TITLE[r.status] || r.status;
    head.appendChild(st);
    li.appendChild(head);
    li.appendChild(el("p", "req-text", r.text));
    if (r.reply) {
      var q = el("blockquote", "reply");
      q.appendChild(el("span", "reply-label", r.to + "'s agent replied"));
      q.appendChild(el("p", "", r.reply));
      li.appendChild(q);
    }
    var foot = el("div", "req-foot");
    foot.appendChild(el("span", "when", timeAgo(r.decidedAt || r.createdAt, now)));
    foot.appendChild(scopeBadge(r.scope));
    li.appendChild(foot);
    mark(fresh, "sent", li, "s:" + r.id, r.status + "|" + (r.reply || ""), i);
    list.appendChild(li);
  });
  known.sent = fresh;
}

function renderActivity(now) {
  var items = timeline(snapshot, repo, 15);
  if (!changed("activity", JSON.stringify([items, Math.floor(now / 30000)]))) return;
  var list = $("activity"), fresh = {};
  list.replaceChildren();
  if (!items.length) {
    list.appendChild(empty("Nothing has happened here yet. Tasks, requests and waits show up as they happen."));
    known.activity = fresh;
    return;
  }
  items.forEach(function (it, i) {
    var li = el("li", "act");
    li.appendChild(avatar(it.who, "sm"));
    var ico = el("span", "act-ico a-" + it.tone);
    ico.setAttribute("aria-hidden", "true");
    li.appendChild(ico);
    var p = el("p", "act-text");
    p.appendChild(el("strong", "", it.who + (it.agent ? "'s agent" : "")));
    p.appendChild(txt(" " + it.text));
    if (it.subject) {
      p.appendChild(txt(" "));
      p.appendChild(it.tone === "wait" || it.tone === "problem" ? el("code", "", it.subject) : el("span", "act-subject", "“" + it.subject + "”"));
    }
    li.appendChild(p);
    var t = el("time", "act-time", timeAgo(it.at, now));
    t.dateTime = new Date(it.at).toISOString();
    t.title = new Date(it.at).toLocaleString();
    li.appendChild(t);
    mark(fresh, "activity", li, it.tone + ":" + it.who + ":" + it.at, "", i);
    list.appendChild(li);
  });
  known.activity = fresh;
}

function nearBottom(chat) { return chat.scrollHeight - chat.scrollTop - chat.clientHeight < 60; }
function scrollChat(behavior) { var chat = $("chat"); chat.scrollTo({ top: chat.scrollHeight, behavior: behavior }); }

function renderChat(v, now) {
  var chat = $("chat");
  var newest = v.chat.length ? v.chat[v.chat.length - 1].at : 0;
  // Switching repository (or the first snapshot) starts read: only what arrives from now on counts as new.
  if (readRepo !== repo) { readRepo = repo; readAt = newest; known.chat = null; }
  if (!changed("chat", JSON.stringify([v.chat.map(function (m) { return m.id; }), Math.floor(now / 30000), me]))) return;
  var atBottom = nearBottom(chat), first = !known.chat, fresh = {};
  var myTag = mentionTag(me || "").toLowerCase();
  chat.replaceChildren();
  if (!v.chat.length) chat.appendChild(empty("No messages yet. Say hello to the team."));
  chatGroups(v.chat).forEach(function (g) {
    var li = el("li", "msg" + (same(g.user, me) ? " mine" : ""));
    li.appendChild(avatar(g.user, "sm"));
    var body = el("div", "msg-body");
    var head = el("div", "msg-head");
    head.appendChild(el("span", "msg-who", g.user));
    var t = el("time", "msg-time", timeAgo(g.at, now));
    t.dateTime = new Date(g.at).toISOString();
    t.title = new Date(g.at).toLocaleString();
    head.appendChild(t);
    body.appendChild(head);
    g.messages.forEach(function (m) {
      var p = el("p", "bubble");
      splitMentions(m.text).forEach(function (part) {
        if (!part.mention) return p.appendChild(txt(part.text));
        var tag = part.text.toLowerCase();
        p.appendChild(el("span", "mention" + (me && (tag === myTag || tag === "@team") ? " to-me" : ""), part.text));
      });
      if (!first && !(m.id in known.chat)) p.classList.add("enter");
      fresh[m.id] = 1;
      body.appendChild(p);
    });
    li.appendChild(body);
    chat.appendChild(li);
  });
  known.chat = fresh;
  if (first || atBottom || sentJustNow) scrollChat(first ? "auto" : smooth());
  sentJustNow = false;
}

// Unread: messages from others that arrived while the chat was scrolled up, off screen, or the tab was hidden.
function updateUnread() {
  var v = lastView;
  if (!v) return;
  var chat = $("chat"), bottom = nearBottom(chat);
  var newest = v.chat.length ? v.chat[v.chat.length - 1].at : 0;
  if (bottom && chatSeen && document.visibilityState === "visible") readAt = Math.max(readAt, newest);
  var u = unreadSince(v.chat, readAt, me);
  $("chat-unread").textContent = u.count + " new";
  $("chat-unread").hidden = !u.count;
  $("jump-count").textContent = u.count > 9 ? "9+" : String(u.count);
  $("jump-count").hidden = !u.count;
  $("jump-chat").setAttribute("aria-label", u.count ? "Go to the team chat, " + u.count + " new" : "Go to the team chat");
  $("new-msgs").hidden = !u.count || bottom;
  $("new-msgs-text").textContent = u.count === 1 ? "1 new message" : u.count + " new messages";
  var waiting = v.forMe.filter(function (r) { return !decided[r.id]; }).length;
  var n = waiting + u.mentions;
  document.title = (n ? "(" + n + ") " : "") + "Lanes";
  if (n !== badgeN) { badgeN = n; $("favicon").href = faviconBadge(n); }
}

// ---------- notifications: opt-in, asked for on a click only ----------
var NOTIFY_KEY = "lanes-app-notify";
function notifyStored(on) { try { localStorage.setItem(NOTIFY_KEY, on ? "1" : "0"); } catch (e) {} }
function notifyOn() {
  try { return "Notification" in window && Notification.permission === "granted" && localStorage.getItem(NOTIFY_KEY) === "1"; } catch (e) { return false; }
}
function paintNotify() {
  var on = notifyOn();
  $("notify").setAttribute("aria-pressed", String(on));
  $("notify").title = on ? "Notifications are on for requests to you and @mentions" : "Get a browser notification for requests to you and @mentions";
}
function ring() { var b = $("notify"); b.classList.remove("ring"); void b.offsetWidth; b.classList.add("ring"); }
function toggleNotify() {
  if (!window.isSecureContext) return toast("Browser notifications need https or localhost.", { kind: "error" });
  if (!("Notification" in window)) return toast("This browser can't show notifications.", { kind: "error" });
  if (notifyOn()) {
    notifyStored(false);
    paintNotify();
    return toast("Notifications off.", { action: "Undo", run: function () { notifyStored(true); paintNotify(); } });
  }
  if (Notification.permission === "denied") return toast("Notifications are blocked for this page. Allow them in the browser's site settings.", { kind: "error" });
  Notification.requestPermission().then(function (p) {
    if (p !== "granted") return toast("Notifications stay off.");
    notifyStored(true);
    paintNotify();
    ring();
    toast("Notifications on: one for each request to you and each @mention while this tab is in the background.", { kind: "ok" });
  });
}
function alerts(v) {
  if (!me) return;
  var fresh = freshAlerts(v, me, seenAlerts || {});
  if (!seenAlerts) {
    // The first snapshot of a repository: what is already there is not news.
    seenAlerts = {};
    return fresh.forEach(function (a) { seenAlerts[a.id] = true; });
  }
  fresh.forEach(function (a) {
    seenAlerts[a.id] = true;
    var isRequest = a.id.indexOf("r:") === 0;
    if (notifyOn() && document.visibilityState !== "visible") {
      try {
        var n = new Notification(a.title, { body: a.body, tag: a.id });
        n.onclick = function () { window.focus(); n.close(); if (isRequest) focusRequest(a.id.slice(2)); else run("go-chat"); };
      } catch (e) {}
    } else if (isRequest) toast(a.title + ".", { action: "Review", run: function () { focusRequest(a.id.slice(2)); } });
  });
  if (fresh.length) ring();
}
function focusRequest(id) {
  var card = byKey($("for-me"), "r:" + id);
  if (!card) return goPanel("p-inbox");
  card.scrollIntoView({ block: "center", behavior: smooth() });
  card.focus({ preventScroll: true });
  flash(card);
}

// ---------- filter, prefill and navigation ----------
function setFilter(q, scroll) {
  filterQ = q;
  $("filter").value = q;
  render();
  if (scroll) $("p-team").scrollIntoView({ block: "start", behavior: smooth() });
}
function clearFilter() {
  var was = filterQ;
  if (!was) return;
  setFilter("");
  toast("Filter cleared.", { action: "Undo", run: function () { setFilter(was); } });
}
function goPanel(id) {
  var p = $(id);
  p.scrollIntoView({ block: "start", behavior: smooth() });
  p.focus({ preventScroll: true });
}
function goPerson(user) {
  var k = "p:" + user.toLowerCase();
  if (filterQ && !byKey($("people"), k)) setFilter("");
  var card = byKey($("people"), k);
  if (!card) return;
  card.scrollIntoView({ block: "center", behavior: smooth() });
  card.focus({ preventScroll: true });
  flash(card);
}
function askPrefill(user) {
  $("ask-to").value = user;
  paintAsk();
  $("ask").scrollIntoView({ block: "center", behavior: smooth() });
  $("ask-text").focus({ preventScroll: true });
  flash($("ask"));
}
function focusChat() {
  var t = $("say-text");
  t.focus({ preventScroll: true });
  t.scrollIntoView({ block: "nearest", behavior: smooth() });
}
function mentionPrefill(user) {
  var t = $("say-text"), tag = mentionTag(user) + " ", v = t.value;
  if (v.indexOf(tag) < 0) t.value = v + (v && v.slice(-1) !== " " ? " " : "") + tag;
  focusChat();
  t.setSelectionRange(t.value.length, t.value.length);
  paintCount($("say-text"), $("say-count"), 500, false);
}
function switchRepo(r, quiet) {
  var was = repo;
  if (!r || r === was) return;
  picked = r;
  seenAlerts = null;
  render();
  if (!quiet) toast("Showing " + r + ".", { action: "Undo", run: function () { switchRepo(was, true); } });
}

// ---------- the request composer ----------
function paintCount(input, out, max, always) {
  var n = input.value.length;
  out.textContent = always ? n + " / " + max : (max - n === 1 ? "1 character left" : max - n + " characters left");
  out.classList.toggle("near", n > max * 0.9);
  if (!always) out.hidden = n < max * 0.8;
}
function paintAsk() {
  var edit = $("ask-edit").checked, to = $("ask-to").value.trim();
  var note = $("ask-scope");
  note.className = "scope-note" + (edit ? " edit" : "");
  note.replaceChildren(el("strong", "", edit ? "May edit files: " : "Read only: "), txt(edit ? "their agent may change files in this repository once " + (to ? to + " approves." : "they approve.") : "their agent can read and answer, but not change files."));
  paintCount($("ask-text"), $("ask-count"), 1000, true);
  renderSugg();
}
function renderSugg() {
  var names = lastView ? lastView.people.filter(function (p) { return !p.mine; }).map(function (p) { return p.user; }) : [];
  var list = suggest(names, $("ask-to").value);
  if (list.join("|") === suggSig) return;
  suggSig = list.join("|");
  var box = $("ask-sugg");
  box.replaceChildren();
  list.forEach(function (n) {
    var b = button("sugg-btn", "", "Ask " + n, "sugg:" + n, function () { $("ask-to").value = n; paintAsk(); $("ask-text").focus(); });
    b.appendChild(avatar(n));
    b.appendChild(txt(n));
    box.appendChild(b);
  });
}

// ---------- command palette ----------
var palItems = [], palShown = [], palActive = 0;
var PAL_ICON = { chat: "chat", file: "file", filter: "search", repo: "repo", help: "help", notify: "bell", clear: "search" };
function openPalette() {
  if (!lastView || $("dash").hidden) return;
  if ($("help").open) $("help").close();
  palItems = paletteItems(lastView, me);
  palItems.splice(1, 0, { action: "notify", value: "", label: notifyOn() ? "Turn off browser notifications" : "Turn on browser notifications", hint: "Setting" });
  if (filterQ) palItems.splice(1, 0, { action: "clear", value: "", label: "Clear the team filter", hint: "Filter" });
  $("pal-input").value = "";
  palActive = 0;
  paintPalette();
  if (!$("palette").open) $("palette").showModal();
  $("pal-input").focus();
}
function paintPalette() {
  var q = $("pal-input").value.trim();
  palShown = paletteFilter(palItems, q, 12);
  if (q) palShown.push({ action: "filter", value: q, label: "Filter the team by “" + q + "”", hint: "Filter" });
  palActive = Math.max(0, Math.min(palActive, palShown.length - 1));
  var list = $("pal-list");
  list.replaceChildren();
  palShown.forEach(function (it, i) {
    var li = el("li", "pal-item");
    li.id = "pal-o-" + i;
    li.setAttribute("role", "option");
    if (it.action === "person" || it.action === "ask" || it.action === "mention") li.appendChild(avatar(it.value, "sm"));
    else { var ico = el("span", "pal-ico"); ico.appendChild(svgIcon(PAL_ICON[it.action] || "search")); li.appendChild(ico); }
    li.appendChild(el("span", "pal-label", it.label));
    li.appendChild(el("span", "pal-hint", it.hint));
    li.onmousemove = function () { if (palActive !== i) { palActive = i; markActive(); } };
    li.onclick = function () { runItem(it); };
    list.appendChild(li);
  });
  if (!palShown.length) list.appendChild(el("li", "pal-empty", "Nothing to show in this repository yet."));
  markActive();
}
function markActive() {
  Array.prototype.forEach.call($("pal-list").querySelectorAll(".pal-item"), function (c, i) {
    c.classList.toggle("active", i === palActive);
    c.setAttribute("aria-selected", String(i === palActive));
  });
  var a = $("pal-o-" + palActive);
  if (a) { $("pal-input").setAttribute("aria-activedescendant", a.id); a.scrollIntoView({ block: "nearest" }); }
  else $("pal-input").removeAttribute("aria-activedescendant");
}
function runItem(it) {
  $("palette").close();
  var a = it.action;
  if (a === "chat") focusChat();
  else if (a === "person") goPerson(it.value);
  else if (a === "ask") askPrefill(it.value);
  else if (a === "mention") mentionPrefill(it.value);
  else if (a === "file" || a === "filter") setFilter(it.value, true);
  else if (a === "repo") switchRepo(it.value);
  else if (a === "help") openHelp();
  else if (a === "notify") toggleNotify();
  else if (a === "clear") clearFilter();
}
$("pal-input").oninput = function () { palActive = 0; paintPalette(); };
$("pal-input").onkeydown = function (e) {
  var n = palShown.length;
  if ((e.key === "ArrowDown" || e.key === "ArrowUp") && n) {
    e.preventDefault();
    palActive = (palActive + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
    markActive();
  } else if (e.key === "Enter" && !e.isComposing) {
    e.preventDefault();
    if (palShown[palActive]) runItem(palShown[palActive]);
  }
};
// A click on the backdrop lands on the dialog itself.
$("palette").onclick = function (e) { if (e.target === $("palette")) $("palette").close(); };
$("help").onclick = function (e) { if (e.target === $("help")) $("help").close(); };
$("open-palette").onclick = openPalette;

// ---------- keyboard shortcuts ----------
function keyCaps(keys) { return keys === "Ctrl K" && MAC ? ["⌘", "K"] : keys.split(" "); }
(function () {
  var dl = $("help-list");
  SHORTCUTS.forEach(function (s) {
    var dt = el("dt");
    keyCaps(s.keys).forEach(function (k) { dt.appendChild(el("kbd", "kbd", k)); });
    dl.appendChild(dt);
    dl.appendChild(el("dd", "", s.label));
  });
  $("cmdk-key").textContent = MAC ? "⌘ K" : "Ctrl K";
})();
function openHelp() {
  if ($("palette").open) $("palette").close();
  if (!$("help").open) $("help").showModal();
  $("help-close").focus();
}
$("open-help").onclick = openHelp;
$("help-close").onclick = function () { $("help").close(); };
function moveReq(step) {
  var cards = Array.prototype.slice.call($("for-me").querySelectorAll(".req.inbox:not(.gone)"));
  if (!cards.length) return toast("Nothing waiting for you.");
  var at = cards.indexOf(document.activeElement && document.activeElement.closest(".req.inbox"));
  var next = at < 0 ? (step > 0 ? 0 : cards.length - 1) : Math.max(0, Math.min(cards.length - 1, at + step));
  cards[next].focus({ preventScroll: true });
  cards[next].scrollIntoView({ block: "nearest", behavior: smooth() });
}
function decideFocused(kind) {
  var card = document.activeElement && document.activeElement.closest(".req.inbox");
  if (!card || card.classList.contains("gone")) return toast(lastView && lastView.forMe.length ? "Press j to pick a request first." : "Nothing waiting for you.");
  var id = card.getAttribute("data-id");
  var r = lastView.forMe.find(function (x) { return x.id === id; });
  if (r) decide(r, kind);
}
function run(action) {
  if (action === "palette") openPalette();
  else if (action === "chat") focusChat();
  else if (action === "filter") { $("filter").focus(); $("filter").select(); }
  else if (action === "next") moveReq(1);
  else if (action === "prev") moveReq(-1);
  else if (action === "approve") decideFocused("approve");
  else if (action === "decline") decideFocused("deny");
  else if (action === "go-inbox") goPanel("p-inbox");
  else if (action === "go-team") goPanel("p-team");
  else if (action === "go-activity") goPanel("p-activity");
  else if (action === "go-chat") { goPanel("p-chat"); scrollChat(smooth()); }
  else if (action === "help") openHelp();
}
var pending = "", pendingTimer = 0;
document.addEventListener("keydown", function (e) {
  if ($("dash").hidden) return;
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "k" || e.key === "K")) {
    e.preventDefault();
    return $("palette").open ? $("palette").close() : openPalette();
  }
  if ($("palette").open || $("help").open) return;
  var t = e.target;
  var typing = t && (t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable || (t.tagName === "INPUT" && t.type !== "checkbox"));
  if (e.key === "Escape") {
    if (typing && t.blur) t.blur();
    else if (filterQ) clearFilter();
    return;
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
  var r = keyAction(SHORTCUTS, pending, e.key);
  pending = r.pending;
  clearTimeout(pendingTimer);
  if (pending) pendingTimer = setTimeout(function () { pending = ""; }, 1500);
  if (!r.action) return;
  e.preventDefault();
  run(r.action);
});

// ---------- skeleton and offline placeholders ----------
function skeleton() {
  [["for-me", 1], ["people", 2], ["activity", 3], ["chat", 3]].forEach(function (s) {
    var list = $(s[0]);
    list.replaceChildren();
    for (var i = 0; i < s[1]; i++) {
      var li = el("li", "skel");
      li.setAttribute("aria-hidden", "true");
      li.appendChild(el("span"));
      li.appendChild(el("span"));
      li.appendChild(el("span"));
      list.appendChild(li);
    }
  });
  $("from-me").replaceChildren();
  $("main").setAttribute("aria-busy", "true");
  sigs = {};
  known = {};
  seenAlerts = null;
  readRepo = null;
}
function offline() {
  if (snapshot) return;
  $("main").removeAttribute("aria-busy");
  $("people").replaceChildren(empty("Nothing to show until the Lanes server answers. Use Retry now above, or run lanes status in a terminal to check it."));
  ["for-me", "activity", "chat"].forEach(function (id) { $(id).replaceChildren(empty("Waiting for the Lanes server.")); });
}

function render() {
  if (!snapshot) return;
  var focused = document.activeElement && document.activeElement.getAttribute("data-key");
  var now = Date.now() + skew;
  var v = appView(snapshot, me, picked || session.repo || "");
  if (lastView && v.repo !== repo) { sigs = {}; known = {}; }
  lastView = v;
  repo = v.repo;
  var select = $("repo");
  if (v.repos.join("|") !== repoList) {
    repoList = v.repos.join("|");
    select.replaceChildren.apply(select, v.repos.map(function (r) { var o = el("option", "", r); o.value = r; return o; }));
  }
  select.value = repo;
  select.title = repo;
  select.disabled = v.repos.length < 2;
  $("main").removeAttribute("aria-busy");
  renderInbox(v, now);
  renderLanes(v);
  renderPeople(v);
  renderSent(v, now);
  renderActivity(now);
  renderChat(v, now);
  $("say-text").disabled = !repo || !me;
  renderSugg();
  alerts(v);
  updateUnread();
  // A redrawn section replaced the focused button: give focus back to the same one.
  if (focused && (!document.activeElement || document.activeElement === document.body)) focusKey(focused);
}

$("repo").onchange = function (e) { switchRepo(e.target.value); };
$("filter").oninput = function (e) { filterQ = e.target.value; render(); };
$("filter").onkeydown = function (e) {
  if (e.key !== "Escape") return;
  e.stopPropagation();
  if (filterQ) clearFilter(); else e.target.blur();
};
$("say").onsubmit = function (e) {
  e.preventDefault();
  var input = $("say-text"), text = input.value.trim(), send = $("say-send");
  if (!text) return;
  send.disabled = true;
  post("/v1/team/say", { text: text }).then(function (d) {
    send.disabled = false;
    if (!d) return;
    input.value = "";
    paintCount(input, $("say-count"), 500, false);
    sentJustNow = true;
    send.classList.remove("sent");
    void send.offsetWidth;
    send.classList.add("sent");
    toast(d.mentions && d.mentions.length ? "Sent. The agents you mentioned see it with their next prompt." : "Sent to the team chat.", { kind: "ok" });
    scrollChat(smooth());
  });
};
$("say-text").onkeydown = function (e) {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("say").requestSubmit(); }
};
$("say-text").oninput = function () { paintCount($("say-text"), $("say-count"), 500, false); };
$("chat").onscroll = updateUnread;
$("new-msgs").onclick = function () { scrollChat(smooth()); };
$("jump-chat").onclick = function () { run("go-chat"); };
$("notify").onclick = toggleNotify;
$("banner-retry").onclick = function () { clearTimeout(retryTimer); failures = 0; if (!ws) { setStatus("connecting"); connect(); } };
document.addEventListener("visibilitychange", updateUnread);
if ("IntersectionObserver" in window) new IntersectionObserver(function (es) { chatSeen = es[es.length - 1].isIntersecting; updateUnread(); }).observe($("chat"));
// Delivered to their agent only after they approve it (ADR-0028).
$("ask").onsubmit = function (e) {
  e.preventDefault();
  var to = $("ask-to").value.trim().replace(/^@/, ""), input = $("ask-text"), text = input.value.trim();
  if (!to) { $("ask-to").focus(); return toast("Pick a teammate to ask.", { kind: "error" }); }
  if (!text) { input.focus(); return toast("Write what their agent should do.", { kind: "error" }); }
  var send = $("ask-send");
  send.disabled = true;
  send.classList.add("busy");
  post("/v1/team/ask", { to: to, text: text, scope: $("ask-edit").checked ? "edit" : "read" }).then(function (d) {
    send.disabled = false;
    send.classList.remove("busy");
    if (!d) return;
    input.value = "";
    $("ask-to").value = "";
    $("ask-edit").checked = false;
    paintAsk();
    toast("Request sent to " + d.to + ". It reaches their agent only after " + d.to + " approves it.", { kind: "ok" });
  });
};
$("ask-text").onkeydown = function (e) {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $("ask").requestSubmit(); }
};
$("ask-text").oninput = paintAsk;
$("ask-to").oninput = paintAsk;
$("ask-edit").onchange = paintAsk;

function showDashboard() {
  token = session.token || "";
  me = session.user || "";
  $("signin").hidden = true;
  $("dash").hidden = false;
  $("me-name").textContent = me || "Signed in";
  $("me").title = me ? "Signed in as " + me : "";
  var av = avatar(me || "?");
  av.id = "me-avatar";
  $("me-avatar").replaceWith(av);
  notice(me ? "" : "Open this page with lanes app: it adds your name and the token to the link.");
  skeleton();
  initLayout();
  paintNotify();
  paintAsk();
  stopped = false;
  failures = 0;
  setStatus("connecting");
  connect();
}

// ---------- sign-in (ADR-0031): GitHub device flow through the Lanes server ----------
var login = null;
function ghStep(step, text) {
  $("gh-start").hidden = step !== "start";
  $("gh-code").hidden = step !== "code";
  $("gh-error").hidden = step !== "error";
  $("gh-error-text").textContent = step === "error" ? text : "";
}
function showSignIn(reason) {
  $("dash").hidden = true;
  $("signin").hidden = false;
  document.title = "Sign in · Lanes";
  $("signin-reason").textContent = reason || "";
  $("signin-reason").hidden = !reason;
  login = null;
  $("gh").hidden = true;
  ghStep("start");
  // Older servers, or ones without a GitHub client id, have no such route: the manual way below stays.
  fetch("/v1/login/config").then(function (r) { return r.ok ? r.json() : {}; }).then(function (c) { $("gh").hidden = !(c && c.github === true); }, function () {});
}
function loginPost(route, body) {
  return fetch(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (d) {
      if (r.status === 404 || r.status === 501) throw new Error("GitHub sign-in is not available on this server.");
      if (!r.ok) throw new Error(d.error || "The Lanes server answered " + r.status + ".");
      return d;
    });
  }, function () { throw new Error("The Lanes server can't be reached."); });
}
$("gh-start").onclick = function () {
  var b = $("gh-start");
  b.disabled = true;
  loginPost("/v1/login/github/start", {}).then(function (d) {
    b.disabled = false;
    if (!d.loginId || !d.userCode) throw new Error("The Lanes server sent an incomplete answer.");
    $("gh-user-code").textContent = d.userCode;
    // Only ever an https link: the page never follows a javascript: or other scheme it was handed.
    var uri = typeof d.verificationUri === "string" && d.verificationUri.indexOf("https://") === 0 ? d.verificationUri : "https://github.com/login/device";
    $("gh-link").href = uri;
    $("gh-link-text").textContent = "Open " + uri.slice(8);
    ghStep("code");
    login = { id: d.loginId, every: Math.max(Number(d.interval) || 5, 1) * 1000, until: Date.now() + (Number(d.expiresIn) || 900) * 1000 };
    setTimeout(pollLogin, login.every);
  }).catch(function (err) { b.disabled = false; ghStep("error", err.message); });
};
function pollLogin() {
  var l = login;
  if (!l) return;
  if (Date.now() > l.until) { login = null; return ghStep("error", "The code expired before it was approved."); }
  loginPost("/v1/login/github/poll", { loginId: l.id }).then(function (d) {
    if (login !== l) return;
    if (d.status === "done" && d.token) {
      login = null;
      session = { token: d.token, user: d.name || "", repo: session.repo || "" };
      save();
      showDashboard();
    } else if (d.status === "denied") {
      login = null;
      ghStep("error", d.error || "GitHub sign-in was refused.");
    } else setTimeout(pollLogin, l.every);
  }).catch(function (err) { if (login === l) { login = null; ghStep("error", err.message); } });
}
$("gh-retry").onclick = function () { ghStep("start"); $("gh-start").focus(); };
$("gh-copy").onclick = function () {
  var code = $("gh-user-code").textContent, b = $("gh-copy");
  var done = function () { b.textContent = "Copied"; setTimeout(function () { b.textContent = "Copy"; }, 1600); };
  var pick = function () { var r = document.createRange(); r.selectNodeContents($("gh-user-code")); getSelection().removeAllRanges(); getSelection().addRange(r); };
  if (navigator.clipboard) navigator.clipboard.writeText(code).then(done, pick); else pick();
};


// ---------- the lane map: every file held or waited for in this repository, as a lane ----------
function laneRows(s, repoId, people) {
  var rows = {}, order = [];
  var add = function (path, kind, user) {
    if (!rows[path]) { rows[path] = { path: path, holder: null, waiters: [], quiet: true }; order.push(path); }
    var r = rows[path];
    if (kind === "hold") { r.holder = user; r.quiet = false; }
    else if (kind === "wait") { if (r.waiters.indexOf(user) < 0) r.waiters.push(user); r.quiet = false; }
  };
  s.leases.forEach(function (l) { if (l.repo === repoId) add(l.path, "hold", l.user); });
  s.agents.forEach(function (a) { if (a.repo === repoId && a.status === "waiting" && a.blockedOn) add(a.blockedOn, "wait", a.user); });
  s.tasks.forEach(function (t) {
    if (t.repo !== repoId || t.status !== "active") return;
    (t.touched.length ? t.touched : t.predicted).slice(0, 3).forEach(function (p) { add(p, "plan", t.user); });
  });
  // live lanes first, then the planned ones, at most 8 in all
  return order.map(function (p) { return rows[p]; }).sort(function (a, b) { return Number(a.quiet) - Number(b.quiet); }).slice(0, 8);
}
function svgEl(tag, attrs, cls) {
  var e = document.createElementNS(SVG_NS, tag);
  Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, String(attrs[k])); });
  if (cls) e.setAttribute("class", cls);
  return e;
}
function renderLanes(v) {
  var rows = laneRows(snapshot, repo, v.people);
  var sig = JSON.stringify(rows);
  var live = rows.filter(function (r) { return !r.quiet; }).length;
  $("lanes-count").textContent = String(live);
  $("lanes-count").hidden = !live;
  $("lanes-sub").textContent = live ? (live === 1 ? "1 file held or waited for" : live + " files held or waited for") : "Nothing held right now";
  if (!changed("lanes", sig)) return;
  var box = $("lanes-map");
  box.replaceChildren();
  if (!rows.length) {
    var none = el("div", "empty", "No lanes yet. Files appear here the moment an agent takes one.");
    box.appendChild(none);
    return;
  }
  var W = 640, H = rows.length * 38 + 6, L = 236, R = W - 24;
  var svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, width: W, height: H, role: "list" });
  svg.setAttribute("aria-label", "Lane map, one lane per file");
  rows.forEach(function (r, i) {
    var y = 22 + i * 38;
    var g = svgEl("g", { tabindex: "0", role: "listitem" }, "lane-row" + (r.quiet ? " quiet" : ""));
    var what = r.holder ? "held by " + r.holder + "'s agent" : r.waiters.length ? "waited for" : "planned";
    g.setAttribute("aria-label", r.path + ", " + what + (r.waiters.length ? ", " + r.waiters.join(" and ") + " waiting" : ""));
    var label = svgEl("text", { x: 0, y: y + 4 }, "lane-file");
    var name = r.path.length > 30 ? "…" + r.path.slice(-29) : r.path;
    label.appendChild(txt(name));
    g.appendChild(label);
    g.appendChild(svgEl("line", { x1: L, y1: y, x2: R, y2: y }, "lane-bar"));
    if (r.holder) g.appendChild(svgEl("line", { x1: L + 14, y1: y, x2: R - 14, y2: y }, "lane-flow"));
    var hx = R - 36;
    if (r.holder) {
      var tone = avatarTone(r.holder);
      var dot = svgEl("circle", { cx: hx, cy: y, r: 12 }, "lane-dot t" + tone);
      dot.setAttribute("fill", "hsl(" + [218, 26, 156, 266, 336, 188, 44, 4][tone] + " 70% 62%)");
      g.appendChild(dot);
      var ini = svgEl("text", { x: hx, y: y + 3.5 }, "lane-ini");
      ini.appendChild(txt(initials(r.holder)));
      g.appendChild(ini);
      var hl = svgEl("text", { x: hx + 12, y: y - 13, "text-anchor": "end" }, "lane-label hold");
      hl.appendChild(txt("lease: " + r.holder));
      g.appendChild(hl);
    }
    r.waiters.slice(0, 3).forEach(function (w, k) {
      var wx = (r.holder ? hx - 118 : hx) - k * 30;
      g.appendChild(svgEl("circle", { cx: wx, cy: y, r: 11 }, "lane-dot wait"));
      var wi = svgEl("text", { x: wx, y: y + 3.5 }, "lane-ini wait");
      wi.appendChild(txt(initials(w)));
      g.appendChild(wi);
      if (k === 0) {
        var wl = svgEl("text", { x: wx + 11, y: y - 13, "text-anchor": "end" }, "lane-label wait");
        wl.appendChild(txt("queued: " + w));
        g.appendChild(wl);
      }
    });
    if (r.quiet) {
      var ql = svgEl("text", { x: R, y: y + 4, "text-anchor": "end" }, "lane-label");
      ql.appendChild(txt("planned"));
      g.appendChild(ql);
    }
    var open = function () { setFilter(r.path, true); };
    g.onclick = open;
    g.onkeydown = function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } };
    svg.appendChild(g);
  });
  box.appendChild(svg);
}

// ---------- the layout: panels can be dragged between the two columns, folded, and the result is kept in this browser ----------
var LAYOUT_KEY = "lanes-app-layout";
var DEFAULT_LAYOUT = { main: ["lanes", "inbox", "team", "sent", "activity"], side: ["chat"], folded: [] };
function loadLayout() {
  try {
    var l = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "null");
    if (l && Array.isArray(l.main) && Array.isArray(l.side)) return { main: l.main, side: l.side, folded: Array.isArray(l.folded) ? l.folded : [] };
  } catch (e) {}
  return null;
}
function saveLayout() {
  var l = { main: [], side: [], folded: [] };
  Array.prototype.forEach.call($("col-main").querySelectorAll(".panel"), function (p) { l.main.push(p.getAttribute("data-panel")); });
  Array.prototype.forEach.call($("col-side").querySelectorAll(".panel"), function (p) { l.side.push(p.getAttribute("data-panel")); });
  Array.prototype.forEach.call(document.querySelectorAll(".panel.folded"), function (p) { l.folded.push(p.getAttribute("data-panel")); });
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(l)); } catch (e) {}
}
function applyLayout(l) {
  var all = {};
  Array.prototype.forEach.call(document.querySelectorAll(".panel[data-panel]"), function (p) { all[p.getAttribute("data-panel")] = p; });
  var placed = {};
  [["main", $("col-main")], ["side", $("col-side")]].forEach(function (c) {
    l[c[0]].forEach(function (id) { if (all[id] && !placed[id]) { c[1].appendChild(all[id]); placed[id] = true; } });
  });
  Object.keys(all).forEach(function (id) { if (!placed[id]) $("col-main").appendChild(all[id]); });
  Object.keys(all).forEach(function (id) { fold(all[id], l.folded.indexOf(id) >= 0); });
}
function fold(panel, on) {
  panel.classList.toggle("folded", on);
  var b = panel.querySelector(".fold");
  b.setAttribute("aria-expanded", String(!on));
  b.setAttribute("aria-label", on ? "Expand" : "Collapse");
}
var dragged = null;
function slotFor(col, y) {
  var panels = Array.prototype.filter.call(col.querySelectorAll(".panel"), function (p) { return p !== dragged; });
  for (var i = 0; i < panels.length; i++) {
    var r = panels[i].getBoundingClientRect();
    if (y < r.top + r.height / 2) return panels[i];
  }
  return null;
}
function clearSlots() { Array.prototype.forEach.call(document.querySelectorAll(".drop-slot"), function (s) { s.remove(); }); Array.prototype.forEach.call(document.querySelectorAll(".col.over"), function (c) { c.classList.remove("over"); }); }
function initLayout() {
  var saved = loadLayout();
  if (saved) applyLayout(saved);
  Array.prototype.forEach.call(document.querySelectorAll(".panel[data-panel]"), function (panel) {
    var grip = panel.querySelector(".grip"), foldBtn = panel.querySelector(".fold");
    foldBtn.onclick = function () { fold(panel, !panel.classList.contains("folded")); saveLayout(); };
    grip.setAttribute("draggable", "true");
    grip.ondragstart = function (e) {
      dragged = panel;
      panel.classList.add("dragging");
      try { e.dataTransfer.setData("text/plain", panel.getAttribute("data-panel")); e.dataTransfer.effectAllowed = "move"; } catch (x) {}
    };
    grip.ondragend = function () { if (dragged) dragged.classList.remove("dragging"); dragged = null; clearSlots(); };
    // keyboard: move the panel within its column, or across with Shift
    grip.onkeydown = function (e) {
      var col = panel.parentNode, other = col.id === "col-main" ? $("col-side") : $("col-main");
      if (e.key === "ArrowUp" && panel.previousElementSibling) col.insertBefore(panel, panel.previousElementSibling);
      else if (e.key === "ArrowDown" && panel.nextElementSibling) col.insertBefore(panel.nextElementSibling, panel);
      else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && e.shiftKey) other.appendChild(panel);
      else return;
      e.preventDefault();
      saveLayout();
      grip.focus({ preventScroll: true });
      toast("Moved " + panel.querySelector("h2").textContent + ".");
    };
  });
  [$("col-main"), $("col-side")].forEach(function (col) {
    col.ondragover = function (e) {
      if (!dragged) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = "move"; } catch (x) {}
      clearSlots();
      col.classList.add("over");
      var slot = el("div", "drop-slot"), before = slotFor(col, e.clientY);
      if (before) col.insertBefore(slot, before); else col.appendChild(slot);
    };
    col.ondragleave = function (e) { if (!col.contains(e.relatedTarget)) clearSlots(); };
    col.ondrop = function (e) {
      if (!dragged) return;
      e.preventDefault();
      var before = slotFor(col, e.clientY);
      if (before) col.insertBefore(dragged, before); else col.appendChild(dragged);
      dragged.classList.remove("dragging");
      var name = dragged.querySelector("h2").textContent;
      dragged = null;
      clearSlots();
      saveLayout();
      toast("Moved " + name + ". The layout is kept in this browser.", { action: "Reset layout", run: resetLayout });
    };
  });
  $("layout-reset").onclick = function () { resetLayout(); toast("Layout reset.", { kind: "ok" }); };
}
function resetLayout() {
  applyLayout(DEFAULT_LAYOUT);
  try { localStorage.removeItem(LAYOUT_KEY); } catch (e) {}
}

// ---------- demo: a simulated team in this tab, for the public page. Nothing leaves the browser. ----------
var DEMO = location.hash === "#demo" || !!document.querySelector('meta[name="lanes-demo"]');
var demo = null;
function demoConnect() {
  var now = Date.now(), R = "github.com/acme/checkout-app";
  var min = function (m) { return now - m * 60000; };
  var agent = function (user, id, status, task, path, blockedOn, startedMin) {
    return { user: user, sessionId: id, repo: R, label: id, status: status, lastPath: path, blockedOn: blockedOn, edits: 3, startedAt: min(startedMin), lastSeen: now };
  };
  demo = {
    agents: [
      agent("Ana", "ana-1", "working", "Add a settings page", "src/settings.ts", undefined, 14),
      agent("Bea", "bea-1", "working", "Add refresh tokens to the session", "src/session.ts", undefined, 22),
      agent("Carl", "carl-1", "working", "Speed up the cart query", "src/cart.ts", undefined, 9),
      agent("Dan", "dan-1", "waiting", "Log out expired sessions", "src/session.ts", "src/session.ts", 4)
    ],
    leases: [
      { repo: R, path: "src/session.ts", holder: "bea-1", user: "Bea", acquiredAt: min(2), expiresAt: now + 300000 },
      { repo: R, path: "src/cart.ts", holder: "carl-1", user: "Carl", acquiredAt: min(1), expiresAt: now + 300000 }
    ],
    tasks: [
      { id: "t1", repo: R, user: "Ana", sessionId: "ana-1", title: "Add a settings page", predicted: ["src/settings.ts", "src/routes.ts"], touched: ["src/settings.ts"], status: "active", createdAt: min(14) },
      { id: "t2", repo: R, user: "Bea", sessionId: "bea-1", title: "Add refresh tokens to the session", predicted: ["src/session.ts", "src/auth/oauth.ts"], touched: ["src/session.ts"], status: "active", createdAt: min(22) },
      { id: "t3", repo: R, user: "Carl", sessionId: "carl-1", title: "Speed up the cart query", predicted: ["src/cart.ts", "src/db.ts"], touched: ["src/cart.ts"], status: "active", createdAt: min(9) },
      { id: "t4", repo: R, user: "Dan", sessionId: "dan-1", title: "Log out expired sessions", predicted: ["src/session.ts"], touched: [], status: "active", createdAt: min(4) },
      { id: "t0", repo: R, user: "Carl", sessionId: "carl-0", title: "Rename getUser to fetchUser", predicted: ["src/session.ts"], touched: ["src/session.ts", "src/auth/oauth.ts"], status: "done", createdAt: min(58), doneAt: min(41) }
    ],
    editors: {},
    events: [{ at: min(3), kind: "wait-overrun", user: "Dan", sessionId: "dan-1", repo: R, path: "src/session.ts", waitedMs: 64000 }],
    team: {
      chat: [
        { id: "m1", repo: R, user: "Bea", text: "@ana the rename of getUser lands in ten minutes, your settings page should call fetchUser", mentions: ["ana"], at: min(12) },
        { id: "m2", repo: R, user: "Ana", text: "@dan Carl does, ask his agent", mentions: ["dan"], at: min(7) },
        { id: "m3", repo: R, user: "Dan", text: "Who owns src/db.ts this week? I need a new index on sessions", mentions: [], at: min(8) },
        { id: "m4", repo: R, user: "Carl", text: "Cart query is 4x faster on staging, merging after lunch", mentions: [], at: min(1) }
      ],
      requests: [
        { id: "r1", repo: R, from: "Bea", to: "Ana", text: "Explain how session expiry works, and where the refresh happens.", scope: "read", status: "pending", createdAt: min(2), expiresAt: now + 28 * 60000 },
        { id: "r2", repo: R, from: "Ana", to: "Carl", text: "Which queries in src/db.ts does the cart page run on load?", scope: "read", status: "delivered", createdAt: min(31), expiresAt: min(1), decidedAt: min(29), reply: "Two: getCart, then one items lookup per line. The second one is what I'm folding into a join.", repliedAt: min(26) }
      ]
    },
    serverTime: now
  };
  demo.agents.forEach(function (a, i) { a.label = ["feat/settings", "feat/session", "perf/cart", "fix/expiry"][i]; });
  var tick = 0, ids = 10;
  var push = function () { demo.serverTime = Date.now(); take(JSON.parse(JSON.stringify(demo))); };
  setStatus("running");
  push();
  $("demo-banner").hidden = false;
  // a slow script: the lease on session.ts moves from Bea to Dan, Carl asks something, chat goes on
  setInterval(function () {
    tick++;
    var t = Date.now();
    if (tick === 2) {
      demo.leases = demo.leases.filter(function (l) { return l.path !== "src/session.ts"; });
      demo.leases.push({ repo: R, path: "src/session.ts", holder: "dan-1", user: "Dan", acquiredAt: t, expiresAt: t + 300000 });
      demo.agents.forEach(function (a) { if (a.user === "Dan") { a.status = "working"; a.blockedOn = undefined; } if (a.user === "Bea") { a.status = "idle"; a.lastPath = "src/session.ts"; } });
      demo.tasks.forEach(function (x) { if (x.id === "t2") { x.status = "done"; x.doneAt = t; } if (x.id === "t4") x.touched = ["src/session.ts"]; });
      demo.team.chat.push({ id: "m" + ids++, repo: R, user: "Bea", text: "Refresh tokens are in. @team session.ts is free again", mentions: ["team"], at: t });
      $("demo-hint").textContent = "Bea finished: Dan's agent took session.ts";
    } else if (tick === 5) {
      demo.team.requests.push({ id: "r" + ids++, repo: R, from: "Carl", to: "Ana", text: "Run the cart tests against the new join and tell me which ones fail.", scope: "edit", status: "pending", createdAt: t, expiresAt: t + 30 * 60000 });
      $("demo-hint").textContent = "A new request from Carl: it needs your approval";
    } else if (tick === 8) {
      demo.agents.forEach(function (a) { if (a.user === "Bea") { a.status = "working"; a.lastPath = "src/auth/oauth.ts"; } });
      demo.leases.push({ repo: R, path: "src/auth/oauth.ts", holder: "bea-1", user: "Bea", acquiredAt: t, expiresAt: t + 300000 });
      demo.tasks.push({ id: "t" + ids++, repo: R, user: "Bea", sessionId: "bea-1", title: "OAuth refresh on expiry", predicted: ["src/auth/oauth.ts"], touched: ["src/auth/oauth.ts"], status: "active", createdAt: t });
      $("demo-hint").textContent = "Bea started a new task";
    } else if (tick === 11) {
      demo.team.chat.push({ id: "m" + ids++, repo: R, user: "Dan", text: "@" + (me.replace(/ +/g, "")) + " expiry is one function now, review when you can", mentions: [me.toLowerCase().replace(/ +/g, "")], at: t });
      $("demo-hint").textContent = "Dan mentioned you in the chat";
    } else if (tick === 14) {
      tick = 0;
    }
    push();
  }, 6000);
}
function demoPost(route, body) {
  var t = Date.now();
  var reply = function (d) { return Promise.resolve(d); };
  if (route === "/v1/team/say") {
    var mentions = (body.text.match(/@[A-Za-z0-9_.-]+/g) || []).map(function (m) { return m.slice(1).toLowerCase(); });
    demo.team.chat.push({ id: "m" + t, repo: demo.agents[0].repo, user: me, text: body.text, mentions: mentions, at: t });
    demo.serverTime = t; take(JSON.parse(JSON.stringify(demo)));
    return reply({ mentions: mentions });
  }
  if (route === "/v1/team/ask") {
    var r = { id: "r" + t, repo: demo.agents[0].repo, from: me, to: body.to, text: body.text, scope: body.scope, status: "pending", createdAt: t, expiresAt: t + 30 * 60000 };
    demo.team.requests.push(r);
    demo.serverTime = t; take(JSON.parse(JSON.stringify(demo)));
    setTimeout(function () { r.status = "delivered"; r.decidedAt = Date.now(); take(JSON.parse(JSON.stringify(demo))); }, 4000);
    setTimeout(function () { r.reply = "Done. " + (body.scope === "edit" ? "Changed two files on branch lanes/request-" + r.id.slice(1, 5) + "." : "Short answer: it is in src/session.ts, verifySession."); r.repliedAt = Date.now(); take(JSON.parse(JSON.stringify(demo))); }, 9000);
    return reply({ to: body.to });
  }
  if (route === "/v1/team/decide") {
    var req = demo.team.requests.filter(function (x) { return x.id === body.id; })[0];
    if (!req) return reply(null);
    req.status = body.decision === "approve" ? "approved" : "denied";
    req.decidedAt = t;
    demo.serverTime = t; take(JSON.parse(JSON.stringify(demo)));
    if (body.decision === "approve") setTimeout(function () { req.status = "delivered"; take(JSON.parse(JSON.stringify(demo))); $("demo-hint").textContent = "Your agent got " + req.from + "'s request with its next prompt"; }, 3000);
    return reply({ ok: true });
  }
  return reply({});
}

if (DEMO) { session = { token: "demo", user: "Ana", repo: "" }; showDashboard(); } else if (session.token) showDashboard(); else showSignIn("");
// Keeps "4 min ago" and "~3 min left" current between snapshots.
setInterval(function () { if (!stopped) render(); }, 30000);
`;

const BROWSER_HELPERS = { appView, splitMentions, avatarTone, initials, timeAgo, timeLeft, chatGroups, filterPeople, mentionTag, unreadSince, freshAlerts, shortcuts, keyAction, paletteItems, paletteFilter, suggest, timeline, faviconBadge };
export const APP_JS = `"use strict";\n${Object.entries(BROWSER_HELPERS).map(([name, f]) => `const ${name} = (${f.toString()});`).join("\n")}\n${BROWSER}`;

const SECURITY = {
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

/** Path → response headers and body. No token needed: none of these hold data. */
export const APP_FILES: Record<string, { headers: Record<string, string>; body: string }> = {
  "/app": { headers: { "content-type": "text/html; charset=utf-8", ...SECURITY }, body: HTML },
  "/app.js": { headers: { "content-type": "text/javascript; charset=utf-8", ...SECURITY }, body: APP_JS },
  "/app.css": { headers: { "content-type": "text/css; charset=utf-8", ...SECURITY }, body: CSS },
};
