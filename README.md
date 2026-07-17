# WhatsApp Web Translator

[English](README.md) | [中文](README_zh.md)

A low-intrusion Chrome extension that translates the messages you receive on
[WhatsApp Web](https://web.whatsapp.com) into your own language, powered by an LLM you
control. Bring your own API key. Nothing is uploaded anywhere except the LLM provider you
configure.

- **Real time or on click.** Auto-translate every incoming message, or leave it off and
  translate a single message by tapping it. A small in-chat control switches modes per session.
- **Only their messages.** Your own messages are never translated. Optionally, translate a
  draft you are writing into the recipient's language before you send it.
- **Context-aware.** Quoted replies pass the quoted message to the model as context, so
  references resolve correctly. You can also pick a tone (natural / friendly / professional / …).
- **Low intrusion.** The translation appears as a subtle line under the original bubble,
  matching WhatsApp's light and dark themes. Nothing is rewritten or hidden.
- **Cached, not re-billed.** Translations are cached (in-memory per session, and persistently)
  so scrolling, re-reading a chat, or reloading never re-calls the API for the same text.
- **Optional local knowledge base.** Capture every message to a local, exportable store to
  feed your own tools. Nothing leaves your machine unless you export it.

Providers: **DeepSeek** (default), any **OpenAI-compatible** endpoint, or **Anthropic (Claude)**.

---

## How it works

The content script watches the open conversation. When a message arrives (or when you tap
one, in manual mode), its text is sent to your configured LLM with a chat-tuned prompt, and
the result is shown as a second line beneath the original message. The actual network call
runs in the extension's background service worker, so your API key never touches the page.

WhatsApp Web obfuscates and frequently changes its CSS class names, so the extension keys off
stable, semantic signals only:

- A message is a container carrying `data-testid="conv-msg-<id>"`; its opaque `data-id` is the
  dedup/cache key.
- `div.copyable-text[data-pre-plain-text]` is the text gate — its presence means real text
  (excludes media, voice, stickers, system rows).
- Direction: an outgoing (your own) message carries a delivery/read status icon inside its
  `msg-meta`; an incoming one never does. This is how "theirs vs yours" is decided — no reliance
  on a class name.
- Text is read with an emoji-preserving walk (`img.alt`), quoted-reply previews excluded.

If WhatsApp changes its structure and nothing matches, the console prints
`[WAT] selector self-test: …` so breakage is visible rather than silent.

---

## Install

1. Download this repository (clone, or download the ZIP and extract).
2. Open Chrome and go to `chrome://extensions/`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the extension folder.
5. Open the extension's **Options** (right-click the icon, or via `chrome://extensions/`) and
   configure a provider and API key.

> After changing any extension code, click the **reload (↻)** button on the extension card in
> `chrome://extensions/`, then reload the WhatsApp Web tab. Changing only Options settings needs
> just a tab reload.

---

## Configuration

Open the Options page.

### Provider

| Provider | Fields | Notes |
|----------|--------|-------|
| **DeepSeek** (default) | Model, API key | Uses `https://api.deepseek.com/v1` with `deepseek-chat` — fast, cheap, good for chat. Just paste your key. |
| **OpenAI-compatible** | Base URL, Model, API key | Works with OpenAI, Groq, Azure, or any local/hosted OpenAI-compatible endpoint. A custom Base URL host asks for a one-time permission when you save. |
| **Anthropic (Claude)** | Model, API key | `claude-haiku-4-5` is fastest/cheapest and a good default; use `claude-sonnet-5` or `claude-opus-4-8` for higher quality. Called directly with the browser-access header. |

Your API key is stored locally (`chrome.storage.sync`) and is only ever sent to the provider
you chose. Get a DeepSeek key at [platform.deepseek.com](https://platform.deepseek.com).

### Style (tone)

| Tone | Effect |
|------|--------|
| Natural (default) | Casual, like texting a friend |
| Friendly | Warm and approachable |
| Professional | Polite, still natural |
| Playful | Lively, light humour |
| Concise | Short and to the point |

Applies to both the messages you read and the drafts you translate. The model adapts wording
to context instead of translating word-for-word.

### Reading (their messages)

| Setting | Description | Default |
|---------|-------------|---------|
| Translate into | The language you read in (16 languages listed; the model auto-detects the source) | Chinese (Simplified) |
| When to translate | `Automatic` (every incoming message) or `On click` (only messages you tap) | Automatic |
| Daily limit | Caps automatic translations per day so a busy group chat can't run up your bill (`0` = unlimited; click-to-translate is never capped) | 0 |

### Writing (your drafts) — optional, off by default

| Setting | Description | Default |
|---------|-------------|---------|
| Enable | Shows a floating translate button and enables the `Alt+T` shortcut | Off |
| Translate draft into | The recipient's language | English |

### Knowledge base — optional, off by default

Capture every text message (both directions) into a local store you can export as JSON. See
[Knowledge base](#knowledge-base) below.

---

## Usage

1. Open [web.whatsapp.com](https://web.whatsapp.com) and log in as usual.
2. Open a conversation.

**Reading.** In automatic mode, incoming messages are translated as they arrive; a small line
with the translation appears under each one. A compact control in the chat header
(`Translate: Auto → …` / `Translate: Off`) toggles automatic translation for the session. With
it off, tap any incoming message (or its small `Translate` affordance) to translate just that one;
tap again to hide/show.

**Writing (if enabled).** Type your draft in your own language, then press **`Alt+T`** (caret in
the message box) or click the floating **`译 → …`** button. The draft is replaced with the
translation for you to review and send. Press `Cmd/Ctrl+Z` to get your original back. Sending is
always manual — the extension never sends for you.

---

## Knowledge base

Turn on **Options → Knowledge base → Capture**. From then on, every text message you send or
receive is saved to a local store, deduplicated by message id, with the translation attached
when available.

- **Export JSON** downloads `whatsapp-kb.json`.
- **Clear** wipes the local store.
- **Saved** shows the current record count.

Each record:

```json
{
  "id": "3AB0F95BC932F1FE78DF",
  "chat": "Alice",
  "direction": "in",              // in = them, out = you
  "sender": "Alice",
  "text": "What's name",
  "quoted": "I also have one.",    // the quoted message, if it's a reply
  "translation": "你叫什么名字?",
  "time": "22:57, 2026年7月14日",
  "capturedAt": "2026-07-15T14:05:22.000Z"
}
```

Everything is **local only** — nothing is uploaded from the extension. Export the JSON and push
it into your own tool (Obsidian, Notion, Lark Base, …) with your own credentials, so no third-party
tokens live inside the browser extension. Chats can be sensitive; keep the export file safe.

---

## Privacy

- The extension has no backend. Message text is sent only to the LLM provider you configure
  (DeepSeek / OpenAI-compatible / Anthropic), using your key.
- Your API key and settings live in `chrome.storage.sync`. Translations and the optional
  knowledge base live in `chrome.storage.local` on your machine.
- Only messages you (or automatic mode) choose to translate are sent. Non-text messages, your own
  messages (unless you use draft translation), and system notices are ignored.
- Because message text leaves your machine for the provider, don't enable automatic translation
  on conversations you consider sensitive unless you're comfortable with your provider's data
  handling.

The extension reads and injects into `web.whatsapp.com` — it does not touch WhatsApp's protocol,
send messages on your behalf, or automate anything. It runs entirely client-side.

---

## Caching behaviour

| Scenario | Behaviour |
|----------|-----------|
| Scroll / re-render within a session | Re-injected from the in-memory cache (keyed by message id) — **no API call** |
| Switch chats and come back (no reload) | In-memory cache — **no API call** |
| Reload the tab | Persistent cache (keyed by text + tone + language + model, up to 100,000 phrases) — previously-seen text is **not re-called** |
| Forwarded / identical text across chats | Persistent cache hit — **no API call** |
| Change tone / language / model | Cache key changes, so it re-translates once with the new setting |

The persistent cache is held in memory and written to `chrome.storage.local` on a short debounce,
so heavy chatting doesn't thrash storage.

---

## Limitations

- WhatsApp Web changes its page structure from time to time. If translations stop appearing after
  a WhatsApp update, the selectors may need refreshing — the `[WAT]` self-test warning in the
  console is the signal.
- Only text is translated. Images, stickers, voice notes, documents, and deleted messages are skipped.
- Translation quality and speed depend on the model you choose.

---

## Development

The content-script pipeline (injection, direction detection, skip rules, emoji, quoted-reply
context, virtualization recycle, cache re-heal, click mode, draft replacement, and knowledge-base
capture) is verified against a mock WhatsApp DOM in a real headless Chrome — no WhatsApp login
required:

```bash
npm install        # installs playwright-core (uses your system Chrome)
npm test           # runs test/harness.mjs
```

`test/fixture.html` mirrors the real WhatsApp DOM (obfuscated classes, `conv-msg` containers,
`msg-meta` status-icon direction, quoted replies); `test/harness.mjs` drives it and asserts the
whole pipeline.

---

## Project structure

```
whatsapp-web-translator/
├── manifest.json          # Extension manifest (MV3)
├── src/
│   ├── contentScript.js   # Watches the chat: translate, inject, cache, capture
│   ├── background.js       # Service worker: calls the LLM provider
│   ├── options.html        # Settings page
│   └── options.js          # Settings logic + knowledge-base export/clear
├── test/
│   ├── fixture.html        # Mock WhatsApp DOM for offline verification
│   └── harness.mjs         # Headless driver (Playwright) that asserts the pipeline
├── README.md
├── README_zh.md
└── LICENSE
```

## Roadmap (optional, not yet built)

- **Push the knowledge base to Lark Base (飞书多维表格).** A table schema plus a `push-kb.mjs`
  script that reads the exported `whatsapp-kb.json` and upserts records by `id` into a Lark Base
  via `lark-cli` (fields: chat / sender / direction / text / quoted / translation / time / tags),
  so it's filterable and searchable in your own workspace. The extension stays credential-free —
  the push runs on your machine with your own Lark auth.

## License

[MIT](LICENSE)
