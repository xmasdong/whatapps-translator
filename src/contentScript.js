/**
 * WhatsApp Web Translator - content script
 *
 * Translates INCOMING (对方) text messages on web.whatsapp.com. Two modes,
 * switchable from a small in-chat control:
 *   - Auto: every incoming text message is translated as it appears, shown as a
 *           subtle line under the original bubble.
 *   - Click: nothing runs automatically; each incoming bubble gets a small
 *            "Translate" affordance (or Alt-click / long-press) to translate it.
 *
 * The actual LLM call happens in the background service worker (background.js).
 *
 * DOM strategy (WhatsApp obfuscates its CSS classes and rotates them per build,
 * so we depend only on semantic, stable signals):
 *  - A rendered message is a container carrying data-testid="conv-msg-<id>"
 *    (with a matching data-id). The data-id is the opaque dedup key.
 *  - `div.copyable-text[data-pre-plain-text]` is the single text gate: its
 *    presence means the message has real text/caption and excludes media,
 *    voice, stickers, system rows, and quoted-reply previews.
 *  - Direction: an OUTGOING (your own) message carries a delivery/read status
 *    icon (a data-icon inside its msg-meta) or an outgoing tail; an INCOMING
 *    message never does. This is per-message reliable and does not depend on
 *    the (now removed) .message-in class.
 *  - Source text is read from span.selectable-text with an emoji-preserving
 *    childNode walk (img.alt), never textContent.
 *  - Observe #main and RE-QUERY on each mutation (addedNodes cannot be trusted
 *    for messages). Mark-then-inject; the list is virtualized so injected DOM
 *    is disposable and the in-memory cache keyed by data-id re-injects for free.
 */

// ============ selector chains (most-specific -> most-robust) ============

const SEL = {
  listContainer: [
    '#main div[role="application"]',
    '#main .copyable-area',
    '#main [data-tab="8"]',
    '#main'
  ],
  // A rendered message bubble container. conv-msg testid is the stable anchor;
  // fall back to any [data-id] under #main.
  message: ['div[data-testid^="conv-msg-"]', 'div[data-id][data-testid]', 'div[data-id]'],
  // Co-primary text gate: presence => real user text/caption; absence => skip.
  textWrapper: ['div.copyable-text[data-pre-plain-text]', '.copyable-text[data-pre-plain-text]'],
  // Text-bearing span, ALWAYS queried inside a resolved textWrapper.
  textSpan: [
    'span.selectable-text.copyable-text',
    '[data-testid="selectable-text"]',
    'span.selectable-text',
    '.selectable-text'
  ],
  // Message metadata block; on OUTGOING messages it also holds a status tick.
  meta: ['[data-testid="msg-meta"]', '.x1rg5ohu'],
  // Extra outgoing markers (belt-and-suspenders alongside the meta-icon check).
  outgoingTail: ['[data-icon="tail-out"]', '[data-icon^="status"]'],
  deletedIcon: ['[data-icon^="recalled"]'],
  header: ['#main header'],
  // Optional compose feature (gated by settings.outgoingEnabled)
  composer: [
    '[data-testid="conversation-compose-box-input"]',
    'footer div[contenteditable="true"][data-lexical-editor="true"]',
    '.copyable-area div[contenteditable="true"][data-tab="10"]',
    '#main div[contenteditable="true"][role="textbox"][data-tab="10"]',
    '#main div[contenteditable="true"][role="textbox"]',
    '.copyable-area div[contenteditable="true"]',
    '#main footer div[contenteditable="true"]'
  ]
};

function firstEl(root, chain) {
  for (const s of chain) {
    const el = root.querySelector(s);
    if (el) return el;
  }
  return null;
}
function allEls(root, chain) {
  for (const s of chain) {
    const els = root.querySelectorAll(s);
    if (els.length) return Array.from(els);
  }
  return [];
}

// Outgoing (your own) messages carry a delivery/read status icon inside their
// meta block, or an outgoing tail. Incoming messages never do.
function isOutgoing(container) {
  const meta = firstEl(container, SEL.meta);
  if (meta && meta.querySelector("[data-icon]")) return true;
  return !!firstEl(container, SEL.outgoingTail);
}

// ============ module state ============

const WAT_DEFAULTS = {
  provider: "deepseek",
  openaiModel: "gpt-4o-mini",
  deepseekModel: "deepseek-chat",
  anthropicModel: "claude-haiku-4-5",
  targetLang: "zh-CN",
  targetLabel: "中文",
  tone: "natural",
  mode: "auto",
  outgoingEnabled: false,
  outgoingLang: "en",
  outgoingLabel: "English",
  dailyBudget: 0,
  kbEnabled: false
};

const MARK = "data-wat-id";
const MAX_INFLIGHT = 3;

const WAT = {
  autoMode: false,
  settings: { ...WAT_DEFAULTS },
  mainNode: null,
  mem: new Map(), // dataId -> { status, sourceHash, translation?, retries? }
  msgObserver: null,
  structObserver: null,
  paused: false,
  budget: { date: null, count: 0 }
};

// ============ small utils ============

function today() {
  return new Date().toISOString().slice(0, 10);
}
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
function normSrc(s) {
  return s.trim().replace(/\s+/g, " ");
}
// Hash on the NORMALIZED text so a re-render that differs only in whitespace is
// not misread as an edit (which would trigger a needless re-translation).
function hashOf(s) {
  return fnv1a(normSrc(s));
}
function debounceRAF(fn) {
  let scheduled = false;
  return () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      fn();
    });
  };
}
function activeModel() {
  const s = WAT.settings;
  if (s.provider === "anthropic") return s.anthropicModel;
  if (s.provider === "deepseek") return s.deepseekModel;
  return s.openaiModel;
}

// ============ extraction ============

// The quoted-reply preview lives INSIDE the copyable-text wrapper (before the
// real text) as [data-testid="quoted-message"] with a span.quoted-mention, so
// the first selectable-text span is the QUOTE, not the message. Pick the first
// text span that is not part of a quote.
function mainTextSpan(wrapper) {
  const cands = wrapper.querySelectorAll(
    'span.selectable-text.copyable-text, [data-testid="selectable-text"], span.selectable-text, .selectable-text'
  );
  for (const s of cands) {
    if (s.classList.contains("quoted-mention")) continue;
    if (s.closest('[data-testid="quoted-message"], .quoted')) continue;
    return s;
  }
  return null;
}
function extractSource(container) {
  const wrapper = firstEl(container, SEL.textWrapper);
  if (!wrapper) return "";
  const span = mainTextSpan(wrapper); // skips the quoted-reply preview + timestamp
  if (!span) return "";
  return walk(span).trim();
}
// When the message is a reply that quotes an earlier message, return that quoted
// text (used as translation context so pronouns/references resolve). Else "".
function quotedContext(container) {
  const wrapper = firstEl(container, SEL.textWrapper);
  if (!wrapper) return "";
  const q = wrapper.querySelector('[data-testid="quoted-message"], .quoted');
  if (!q) return "";
  const span =
    q.querySelector(".quoted-mention") ||
    q.querySelector('[data-testid="selectable-text"], span.selectable-text, .selectable-text');
  if (!span) return "";
  return walk(span).trim().slice(0, 400);
}
function walk(node) {
  let out = "";
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) out += child.nodeValue;
    else if (child.tagName === "IMG") out += child.getAttribute("alt") || ""; // emoji/flag/skin-tone
    else if (child.nodeType === Node.ELEMENT_NODE) out += walk(child); // bold/italic/mono spans
  }
  return out;
}
function isTrivial(s) {
  const t = s.trim();
  if (!t) return true;
  if (/^https?:\/\/\S+$/i.test(t)) return true; // pure URL
  if (/^[\d\s.,:+\-()]+$/.test(t)) return true; // pure number/phone
  try {
    if (/^\p{Extended_Pictographic}[\p{Extended_Pictographic}️‍\s]*$/u.test(t)) return true; // emoji-only
  } catch {
    // Older engines without Unicode property escapes: skip this check.
  }
  return false;
}

const DELETED_PHRASES = [
  "This message was deleted",
  "You deleted this message",
  "此消息已被删除",
  "你删除了这条消息",
  "Se eliminó este mensaje",
  "Ce message a été supprimé"
];
function isDeletedPhrase(wrapper) {
  const t = (wrapper.textContent || "").trim();
  return DELETED_PHRASES.some((p) => t === p);
}

// ============ same-language short-circuit ============

const SCRIPT_RANGES = {
  "zh-CN": /\p{Script=Han}/u,
  "zh-TW": /\p{Script=Han}/u,
  ja: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u,
  ko: /\p{Script=Hangul}/u,
  ru: /\p{Script=Cyrillic}/u,
  ar: /\p{Script=Arabic}/u,
  th: /\p{Script=Thai}/u,
  hi: /\p{Script=Devanagari}/u
};
function targetScriptRatio(text, target) {
  const re = SCRIPT_RANGES[target];
  if (!re) return null; // Latin target -> undecidable client-side
  let letters = "";
  try {
    letters = text.replace(/[\s\d\p{P}\p{S}]/gu, "");
  } catch {
    return null;
  }
  if (!letters) return null;
  let hit = 0;
  for (const ch of letters) if (re.test(ch)) hit++;
  return hit / letters.length;
}
// True when the text already appears to be in the target language. Only decides
// for script-distinct targets; Latin-vs-Latin is left to the LLM (its "return
// unchanged" verdict is caught in runJob and cached).
function isSameLanguage(text) {
  const ratio = targetScriptRatio(text, WAT.settings.targetLang);
  if (ratio == null) return false;
  return ratio > 0.5;
}

// ============ persistent phrase cache (survives reload, dedups forwards) ============

const LRU_KEY = "wat.lru";
function textKey(source, context = "") {
  return (
    "wat:" +
    fnv1a(`${normSrc(source)}|${normSrc(context)}|${WAT.settings.targetLang}|${WAT.settings.tone}|${activeModel()}`)
  );
}
const LRU_CAP = 100000;
let LRU = { order: [], map: {} }; // in-memory mirror; storage is the durable copy
let lruDirty = false;
let lruTimer = null;

async function loadLRU() {
  try {
    const o = (await chrome.storage.local.get({ [LRU_KEY]: null }))[LRU_KEY];
    if (o && o.map && Array.isArray(o.order)) LRU = o;
  } catch {
    // start empty; the in-memory cache still works for the session
  }
}
function persistLRU() {
  lruTimer = null;
  if (!lruDirty) return;
  lruDirty = false;
  try {
    chrome.storage.local.set({ [LRU_KEY]: LRU });
  } catch {
    // quota or unavailable -> keep serving from memory this session
  }
}
function loadTextCache(k) {
  return LRU.map[k] || null; // synchronous read from the in-memory mirror
}
function saveTextCache(k, v) {
  if (!LRU.map[k]) LRU.order.push(k);
  LRU.map[k] = v;
  while (LRU.order.length > LRU_CAP) {
    const drop = LRU.order.shift();
    delete LRU.map[drop];
  }
  lruDirty = true;
  if (!lruTimer) lruTimer = setTimeout(persistLRU, 2000); // debounce writes to storage
}

// ============ personal knowledge base (optional local capture) ============
// Captures every text message (both directions) into a local, deduped store,
// which the user exports as JSON and pushes to their own tool (e.g. Lark Base).
// Nothing is uploaded from here.

const KB_KEY = "wat.kb";
const KB_CLEAR_KEY = "wat.kbClear";
const KB = { on: false, byId: new Map(), dirty: false, timer: null };

async function loadKB() {
  try {
    const arr = (await chrome.storage.local.get({ [KB_KEY]: [] }))[KB_KEY];
    if (Array.isArray(arr)) for (const r of arr) if (r && r.id) KB.byId.set(r.id, r);
  } catch {
    // start empty
  }
}
function kbPersist() {
  KB.timer = null;
  if (!KB.dirty) return;
  KB.dirty = false;
  try {
    chrome.storage.local.set({ [KB_KEY]: Array.from(KB.byId.values()) });
  } catch {
    // quota/unavailable -> keep in memory
  }
}
function kbSchedule() {
  if (!KB.timer) KB.timer = setTimeout(kbPersist, 2500); // debounce writes
}
function kbClear() {
  KB.byId.clear();
  KB.dirty = false;
  if (KB.timer) {
    clearTimeout(KB.timer);
    KB.timer = null;
  }
  try {
    chrome.storage.local.set({ [KB_KEY]: [] });
  } catch {}
}

function parsePrePlain(pre) {
  // "[22:57, 2026年7月14日] Alice: " -> { time, sender }
  const m = (pre || "").match(/^\[([^\]]+)\]\s*([\s\S]*?):\s*$/);
  return m ? { time: m[1].trim(), sender: m[2].trim() } : { time: "", sender: "" };
}
function currentChatName() {
  const h = firstEl(WAT.mainNode || document, [
    "#main header span[title]",
    '#main header span[dir="auto"]',
    "#main header"
  ]);
  return (h && (h.getAttribute("title") || h.textContent || "").trim()) || "";
}
function nowISO() {
  return new Date().toISOString();
}

function kbScan() {
  if (!KB.on || !WAT.mainNode) return;
  const chat = currentChatName();
  for (const container of allEls(WAT.mainNode, SEL.message)) {
    const id = container.dataset.id;
    if (!id) continue;
    const wrapper = firstEl(container, SEL.textWrapper); // text/caption only
    if (!wrapper) continue;
    if (container.querySelector(SEL.deletedIcon[0]) || isDeletedPhrase(wrapper)) continue; // don't archive deleted
    const text = extractSource(container);
    if (!text) continue;
    const out = isOutgoing(container);
    const quoted = quotedContext(container);
    const h = hashOf(text);
    const prev = KB.byId.get(id);
    const translation = out ? "" : LRU.map[textKey(text, quoted)] || (prev && prev.translation) || "";
    if (prev && prev.hash === h && prev.translation === translation && prev.chat === chat) continue;
    const { time, sender } = parsePrePlain(wrapper.getAttribute("data-pre-plain-text"));
    KB.byId.set(id, {
      id,
      chat,
      direction: out ? "out" : "in",
      sender: out ? "me" : sender,
      text,
      quoted,
      translation,
      time,
      capturedAt: (prev && prev.capturedAt) || nowISO(),
      hash: h
    });
    KB.dirty = true;
  }
  if (KB.dirty) kbSchedule();
}

// ============ translate transport (calls the background worker) ============

async function translateSingle(text, mode = "incoming", targetLang = WAT.settings.targetLang, context = "") {
  const rt = globalThis.chrome?.runtime;
  if (!rt?.sendMessage) throw new Error("Extension not ready");
  const r = await rt.sendMessage({ type: "wat.translate", payload: { text, mode, targetLang, context } });
  if (!r || r.ok !== true) throw new Error(r?.error || "Translation failed");
  return r.text;
}

// ============ styles ============

function injectStyles() {
  if (document.getElementById("wat-styles")) return;
  const s = document.createElement("style");
  s.id = "wat-styles";
  s.textContent = `
    .wat-tr{
      display:block; margin-top:3px; padding-top:3px;
      font-size:.92em; line-height:1.35;
      color:inherit; opacity:.62;
      border-top:1px solid; border-top-color:color-mix(in srgb, currentColor 12%, transparent);
      user-select:text; white-space:pre-wrap; overflow-wrap:anywhere;
    }
    .wat-btn{
      all:unset; box-sizing:border-box; cursor:pointer;
      font-size:.8em; color:inherit; opacity:0;
      margin-left:6px; padding:1px 4px; border-radius:4px;
      transition:opacity .12s ease;
    }
    .wat-in:hover .wat-btn, .wat-in:focus-within .wat-btn{ opacity:.5; }
    .wat-btn:hover, .wat-btn:focus-visible{ opacity:.9; outline:none; }
    .wat-btn[data-loading]::after{ content:"…"; }
    .wat-err{ font-size:.8em; opacity:.6; color:inherit; margin-top:2px; cursor:pointer; }
    .wat-strip{
      position:absolute; top:8px; left:50%; transform:translateX(-50%);
      z-index:1000; font-size:12px; padding:5px 12px; border-radius:6px;
      color:inherit; opacity:.9; background:color-mix(in srgb, currentColor 12%, transparent);
      border:1px solid color-mix(in srgb, currentColor 22%, transparent); cursor:default;
    }
    .wat-toggle{ all:unset; cursor:pointer; font-size:13px; opacity:.7;
      padding:4px 8px; margin-right:4px; border-radius:6px; }
    .wat-toggle:hover{ opacity:1; background:color-mix(in srgb, currentColor 10%, transparent); }
    .wat-compose-btn{
      all:unset; box-sizing:border-box; cursor:pointer;
      position:fixed; right:18px; bottom:82px; z-index:2000;
      display:inline-flex; align-items:center;
      font-size:12px; font-weight:600; color:#fff;
      padding:6px 14px; border-radius:9999px;
      background:#128c7e; box-shadow:0 1px 4px rgba(0,0,0,.25);
    }
    .wat-compose-btn:hover{ background:#075e54; }
    .wat-compose-btn[data-loading]{ opacity:.6; }
  `;
  document.head.appendChild(s);
}

// ============ injection ============

function injectLine(container, id, text) {
  container.setAttribute(MARK, id); // attributes are not observed -> no feedback loop from this
  const wrapper = firstEl(container, SEL.textWrapper);
  if (!wrapper) return;
  let line = container.querySelector(".wat-tr");
  if (line && line.textContent === text) return; // idempotent: nothing to mutate, breaks the loop
  if (!line) {
    line = document.createElement("div");
    line.className = "wat-tr";
    line.setAttribute("dir", "auto");
    wrapper.insertAdjacentElement("afterend", line);
  }
  line.textContent = text;
}

function findMessageById(id) {
  if (!WAT.mainNode) return null;
  return WAT.mainNode.querySelector(`[data-id="${id.replace(/"/g, '\\"')}"]`);
}
function reinject(id, text) {
  const node = findMessageById(id);
  if (node) injectLine(node, id, text);
}

// Safety net: WhatsApp's React re-renders (heaviest around sending / new
// messages) can wipe an injected translation line. The MutationObserver usually
// re-adds it, but a low-frequency sweep guarantees any "done" message missing
// its line gets it back from cache — never a new API call.
function reinjectSweep() {
  if (!WAT.mainNode) return;
  for (const container of allEls(WAT.mainNode, SEL.message)) {
    const id = container.dataset.id;
    if (!id) continue;
    const c = WAT.mem.get(id);
    if (c && c.status === "done" && !container.querySelector(".wat-tr")) {
      const src = extractSource(container);
      if (src && hashOf(src) === c.sourceHash) injectLine(container, id, c.translation);
    }
  }
}

// ============ request queue (concurrency + budget) ============

const QUEUE = [];
let inflight = 0;

function enqueue(id, source, sourceHash, context = "") {
  QUEUE.push({ id, source, sourceHash, context });
  pump();
}
function pump() {
  while (!WAT.paused && inflight < MAX_INFLIGHT && QUEUE.length) {
    const job = QUEUE.shift();
    if (!withinBudget(1)) {
      QUEUE.unshift(job);
      pauseGlobal("Daily translation limit reached.");
      return;
    }
    inflight++;
    runJob(job).finally(() => {
      inflight--;
      pump();
    });
  }
}
async function runJob(job) {
  try {
    const out = await translateSingle(job.source, "incoming", WAT.settings.targetLang, job.context);
    bumpBudget(1);
    if (normSrc(out) === normSrc(job.source)) {
      WAT.mem.set(job.id, { status: "same-lang", sourceHash: job.sourceHash });
    } else {
      WAT.mem.set(job.id, { status: "done", sourceHash: job.sourceHash, translation: out });
      saveTextCache(textKey(job.source, job.context), out);
      reinject(job.id, out);
    }
  } catch (e) {
    onJobError(job, e);
  }
}

// ============ per-message pipeline ============

function scanMessages() {
  if (!WAT.mainNode) return;
  for (const container of allEls(WAT.mainNode, SEL.message)) processMessage(container);
  ensureComposeButton(); // idempotent; shows/hides the floating draft button
  kbScan(); // capture into the local knowledge base (no-op unless enabled)
}

function markSkip(id) {
  WAT.mem.set(id, { status: "skip" });
}
// On virtualization recycle a message container can mount BEFORE its text is
// rendered. Don't permanently skip a maybe-text container on a transient empty
// read: re-check on the next few scans, only skipping once it's clearly not text.
function deferOrSkip(id) {
  const c = WAT.mem.get(id) || {};
  const tries = (c.tries || 0) + 1;
  if (tries >= 6) WAT.mem.set(id, { status: "skip" });
  else WAT.mem.set(id, { status: "recheck", tries });
}

function processMessage(container) {
  const id = container.dataset.id;
  if (!id) return; // cannot dedup safely -> skip

  const c = WAT.mem.get(id);
  if (c) {
    if (c.status === "done") {
      const src = extractSource(container);
      if (!src) return; // recycled but text not rendered yet -> keep the cache, wait
      if (hashOf(src) === c.sourceHash) {
        injectLine(container, id, c.translation); // free re-inject after virtualization recycle
        return;
      }
      // else: edited message (same id, new text) -> fall through and re-translate
    } else if (c.status === "skip" || c.status === "same-lang") {
      return;
    } else if (c.status === "pending" || c.status === "checking") {
      return; // auto translation already in flight
    } else if (c.status === "error" && WAT.autoMode) {
      return; // retry is handled by the queue
    }
    // "recheck" and click-mode "error" fall through to be re-evaluated below
  }

  const wrapper = firstEl(container, SEL.textWrapper); // THE gate: text/caption only
  if (!wrapper) return deferOrSkip(id); // not text yet, or genuinely media
  if (isOutgoing(container)) return markSkip(id); // your own message (对方 only)
  if (container.querySelector(SEL.deletedIcon[0]) || isDeletedPhrase(wrapper)) return markSkip(id);

  const source = extractSource(container);
  if (!source) return deferOrSkip(id); // empty: text may not be rendered yet
  if (isTrivial(source)) return markSkip(id); // has content but nothing to translate
  const sourceHash = hashOf(source);
  const context = quotedContext(container); // quoted reply -> translation context

  container.classList.add("wat-in"); // enables the hover affordance styling

  if (WAT.autoMode) {
    WAT.mem.set(id, { status: "checking", sourceHash });
    handleAuto(container, id, source, sourceHash, context);
  } else {
    attachClickAffordance(container, id, source, sourceHash, context); // idempotent
  }
}

async function handleAuto(container, id, source, sourceHash, context) {
  if (isSameLanguage(source)) {
    WAT.mem.set(id, { status: "same-lang", sourceHash });
    return;
  }
  const hit = await loadTextCache(textKey(source, context));
  if (hit) {
    WAT.mem.set(id, { status: "done", sourceHash, translation: hit });
    reinject(id, hit);
    return;
  }
  WAT.mem.set(id, { status: "pending", sourceHash, retries: 0 });
  enqueue(id, source, sourceHash, context);
}

// ============ click / hover affordance ============

function attachClickAffordance(container, id, source, sourceHash, context = "") {
  if (container.querySelector(".wat-btn")) return;
  const wrapper = firstEl(container, SEL.textWrapper);
  if (!wrapper) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "wat-btn";
  btn.textContent = "Translate";
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onManualTranslate(container, id, source, sourceHash, btn, context);
  });
  wrapper.insertAdjacentElement("afterend", btn);

  // Secondary gesture for touch / power users, guarded against text selection.
  let t;
  container.addEventListener("pointerdown", (e) => {
    if (e.altKey) {
      onManualTranslate(container, id, source, sourceHash, btn, context);
      return;
    }
    t = setTimeout(() => onManualTranslate(container, id, source, sourceHash, btn, context), 550);
  });
  const cancel = () => clearTimeout(t);
  container.addEventListener("pointerup", cancel);
  container.addEventListener("pointermove", cancel);
}

async function onManualTranslate(container, id, source, sourceHash, btn, context = "") {
  const c = WAT.mem.get(id);
  if (c?.status === "done") {
    const line = container.querySelector(".wat-tr");
    if (line) line.style.display = line.style.display === "none" ? "" : "none";
    else injectLine(container, id, c.translation);
    return;
  }
  if (c?.status === "same-lang") return;
  btn.setAttribute("data-loading", "");
  const label = btn.textContent;
  btn.textContent = "";
  try {
    const res = await translateSingle(source, "incoming", WAT.settings.targetLang, context);
    if (normSrc(res) === normSrc(source)) {
      WAT.mem.set(id, { status: "same-lang", sourceHash });
    } else {
      WAT.mem.set(id, { status: "done", sourceHash, translation: res });
      saveTextCache(textKey(source, context), res);
      injectLine(container, id, res);
      btn.remove();
      return;
    }
  } catch (err) {
    showRetry(container, id, source, sourceHash, context);
  } finally {
    btn.removeAttribute("data-loading");
    if (document.body.contains(btn)) btn.textContent = label || "Translate";
  }
}

function showRetry(container, id, source, sourceHash, context = "") {
  const wrapper = firstEl(container, SEL.textWrapper);
  if (!wrapper) return;
  let err = container.querySelector(".wat-err");
  if (!err) {
    err = document.createElement("div");
    err.className = "wat-err";
    wrapper.insertAdjacentElement("afterend", err);
  }
  err.textContent = "Translation failed - tap to retry";
  err.onclick = () => {
    err.remove();
    WAT.mem.delete(id);
    let btn = container.querySelector(".wat-btn");
    if (!btn) {
      attachClickAffordance(container, id, source, sourceHash, context);
      btn = container.querySelector(".wat-btn");
    }
    if (btn) onManualTranslate(container, id, source, sourceHash, btn, context);
  };
}
function markErrorAffordance(id) {
  const node = findMessageById(id);
  if (node) showRetry(node, id, "", "", "");
}

// ============ in-chat toggle ============

function paintToggle(btn) {
  btn.textContent = WAT.autoMode ? `Translate: Auto → ${WAT.settings.targetLabel}` : "Translate: Off";
}
function dockToggle(main) {
  const hdr = firstEl(main, SEL.header);
  if (!hdr) return;
  removeToggle();
  const btn = document.createElement("button");
  btn.className = "wat-toggle";
  btn.type = "button";
  btn.id = "wat-toggle";
  paintToggle(btn);
  btn.addEventListener("click", () => {
    setAuto(!WAT.autoMode);
    paintToggle(btn);
  });
  hdr.insertAdjacentElement("afterbegin", btn);
}
function removeToggle() {
  document.getElementById("wat-toggle")?.remove();
}
function setAuto(on) {
  WAT.autoMode = on;
  try {
    chrome.storage.local.set({ "wat.autoMode": on });
  } catch {}
  if (on) scanMessages(); // translate what is currently on screen; leave existing lines when turned off
}

// ============ compose (optional) ============

// The draft-translate control is a single body-level FIXED button. It lives
// outside WhatsApp's React tree so React re-renders can't wipe it, and it's
// shown only when the compose feature is on and a composer is present.
function ensureComposeButton() {
  let btn = document.getElementById("wat-compose");
  if (!WAT.settings.outgoingEnabled) {
    btn?.remove();
    return;
  }
  const composer = firstEl(document, SEL.composer);
  if (!composer) {
    if (btn) btn.style.display = "none";
    return;
  }
  if (!btn) {
    btn = document.createElement("button");
    btn.id = "wat-compose";
    btn.type = "button";
    btn.className = "wat-compose-btn";
    btn.title = "Alt+T";
    btn.addEventListener("click", () => translateDraft(btn));
    document.body.appendChild(btn);
  }
  btn.textContent = `译 → ${WAT.settings.outgoingLabel}`;
  btn.style.display = "";
}

// Read the current draft, translate it into the recipient's language, and put
// the result back into the composer. Shared by the button and the Alt+T hotkey.
async function translateDraft(btn) {
  const composer = firstEl(document, SEL.composer);
  if (!composer) return;
  const src = (walk(composer) || composer.innerText || "").trim();
  if (!src) return;
  btn?.setAttribute("data-loading", "");
  try {
    const out = await translateSingle(src, "outgoing", WAT.settings.outgoingLang);
    await setComposerText(composer, out);
  } catch (e) {
    console.warn("[WAT] draft translate failed:", String(e?.message || e));
  } finally {
    btn?.removeAttribute("data-loading");
  }
}

// Replace the Lexical composer's content with `text`. Lexical keeps its own
// editor state, so setting innerText/innerHTML is ignored (or lost on send);
// the reliable path is to drive it through the input pipeline it listens to:
// select-all, then execCommand insertText (fires a real beforeinput Lexical
// applies); fall back to a synthetic paste (Lexical has a first-class paste
// handler) if that doesn't take.
async function setComposerText(el, text) {
  const before = (el.innerText || "").trim();
  const probe = text.slice(0, 8);
  // Replaced = the box holds the translation and the old draft is gone. For
  // cross-language translation the source never appears inside the result.
  const replaced = () => {
    const now = (el.innerText || "").trim();
    return now.includes(probe) && (before === "" || !now.includes(before));
  };
  const selectAll = () => {
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  };
  // Yield a frame so Lexical's selectionchange handler adopts the DOM range
  // before we mutate; without it the insert lands at the caret (append).
  const tick = () => new Promise((res) => requestAnimationFrame(() => res()));

  // 1) Paste over a full selection — Lexical's paste handler replaces it.
  selectAll();
  await tick();
  try {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  } catch {}
  await tick();
  if (replaced()) return;

  // 2) Select all, delete the draft, then insert the translation.
  selectAll();
  await tick();
  try {
    document.execCommand("delete", false);
  } catch {}
  try {
    document.execCommand("insertText", false, text);
  } catch {}
  await tick();
  if (replaced()) return;

  // 3) Last resort: copy to clipboard so the user can select-all + paste.
  try {
    await navigator.clipboard?.writeText(text);
  } catch {}
}

// ============ global error handling + budget ============

let backoff = 1000;
function showStrip(reason) {
  hideStrip();
  const main = WAT.mainNode || document.body;
  const strip = document.createElement("div");
  strip.className = "wat-strip";
  strip.id = "wat-strip";
  strip.textContent = reason;
  main.appendChild(strip);
}
function hideStrip() {
  document.getElementById("wat-strip")?.remove();
}
function pauseGlobal(reason) {
  if (WAT.paused) return;
  WAT.paused = true;
  showStrip(reason);
  const retry = () => {
    if (!WAT.paused) return;
    WAT.paused = false;
    hideStrip();
    backoff = Math.min(backoff * 2, 60000);
    pump();
  };
  setTimeout(retry, backoff);
  window.addEventListener("online", retry, { once: true });
}
function onJobError(job, e) {
  const m = String(e?.message || e);
  console.warn("[WAT] translate error:", m);
  if (/401|403|missing api key/i.test(m)) return pauseGlobal("Set your API key in the extension Options.");
  if (/429|quota|rate|insufficient|402/i.test(m)) return pauseGlobal("Provider rejected the request (rate limit or balance).");
  if (!navigator.onLine) return pauseGlobal("Offline - translation paused.");
  const c = WAT.mem.get(job.id) || {};
  c.retries = (c.retries || 0) + 1;
  c.status = "error";
  WAT.mem.set(job.id, c);
  if (c.retries <= 2) enqueue(job.id, job.source, job.sourceHash);
  else markErrorAffordance(job.id);
}

function withinBudget(n) {
  const cap = WAT.settings.dailyBudget || 0;
  if (!cap) return true;
  if (WAT.budget.date !== today()) WAT.budget = { date: today(), count: 0 };
  return WAT.budget.count + n <= cap;
}
function bumpBudget(n) {
  if (WAT.budget.date !== today()) WAT.budget = { date: today(), count: 0 };
  WAT.budget.count += n;
  try {
    chrome.storage.local.set({ "wat.budget": WAT.budget });
  } catch {}
}

// ============ self-test ============

function selfTest(main) {
  const rows = main.querySelectorAll('div[role="row"]').length;
  const hits = allEls(main, SEL.message).filter((el) => firstEl(el, SEL.textWrapper)).length;
  if (rows > 3 && hits === 0) {
    console.warn("[WAT] selector self-test: 0 text messages matched under a populated #main - WhatsApp DOM may have changed.");
  }
}

// ============ lifecycle ============

function setupChat(main) {
  WAT.msgObserver = new MutationObserver(debounceRAF(scanMessages));
  WAT.msgObserver.observe(main, { childList: true, subtree: true });
  dockToggle(main);
  ensureComposeButton();
  scanMessages();
  selfTest(main);
}
function teardownChat() {
  WAT.msgObserver?.disconnect();
  WAT.msgObserver = null;
  QUEUE.length = 0; // do not burn the key on a chat the user left
  removeToggle();
  document.getElementById("wat-compose")?.style.setProperty("display", "none");
  hideStrip();
  // Keep WAT.mem (keyed by opaque, chat-unique data-id) so returning re-injects for free.
}
function onStructureChanged() {
  const main = document.querySelector("#main");
  if (main === WAT.mainNode) return;
  if (WAT.mainNode) teardownChat();
  WAT.mainNode = main;
  if (main) setupChat(main);
}
function waitForMain() {
  const root = document.getElementById("app") || document.body;
  WAT.structObserver = new MutationObserver(debounceRAF(onStructureChanged));
  WAT.structObserver.observe(root, { childList: true, subtree: true });
  onStructureChanged();
}

async function boot() {
  injectStyles();
  try {
    window.__WAT = WAT; // dev aid: inspect state from the console
  } catch {}
  try {
    WAT.settings = await chrome.storage.sync.get(WAT_DEFAULTS);
    const p = await chrome.storage.local.get({ "wat.autoMode": null, "wat.budget": null });
    WAT.autoMode = p["wat.autoMode"] != null ? p["wat.autoMode"] : WAT.settings.mode === "auto";
    WAT.budget =
      p["wat.budget"] && p["wat.budget"].date === today() ? p["wat.budget"] : { date: today(), count: 0 };
  } catch {
    WAT.autoMode = WAT.settings.mode === "auto";
  }

  WAT.settings.kbEnabled = !!WAT.settings.kbEnabled;
  KB.on = WAT.settings.kbEnabled;

  try {
    chrome.storage.onChanged.addListener((chg, area) => {
      if (area === "sync") {
        for (const k of Object.keys(chg)) WAT.settings[k] = chg[k].newValue;
        KB.on = !!WAT.settings.kbEnabled;
        const tog = document.getElementById("wat-toggle");
        if (tog) paintToggle(tog);
        ensureComposeButton(); // apply outgoing-enable / label changes live
        if (KB.on) kbScan();
      } else if (area === "local" && chg[KB_CLEAR_KEY]) {
        kbClear(); // Options requested a wipe
      }
    });
  } catch {}

  // Alt+T translates the current draft into the recipient's language, whenever
  // the caret is in the composer (works regardless of the button's placement).
  document.addEventListener("keydown", (e) => {
    if (!e.altKey || (e.key !== "t" && e.key !== "T")) return;
    if (!WAT.settings.outgoingEnabled) return;
    const composer = firstEl(document, SEL.composer);
    const active = document.activeElement;
    if (!composer || !(composer === active || composer.contains(active))) return;
    e.preventDefault();
    translateDraft(document.querySelector(".wat-compose-btn"));
  });

  await loadLRU(); // persistent phrase cache into memory before the first scan
  await loadKB(); // knowledge-base records into memory before the first scan

  setInterval(reinjectSweep, 1200); // re-heal translation lines wiped by React

  waitForMain();
}

boot();

console.log("[WAT] WhatsApp Web Translator loaded");
