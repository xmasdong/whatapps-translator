/**
 * WhatsApp Web Translator - background (MV3 service worker)
 *
 * Translates chat messages via a configurable LLM provider.
 * Two providers are supported:
 *   - "openai"    : any OpenAI-compatible Chat Completions endpoint
 *                   (OpenAI, DeepSeek, Groq, local proxies, ...).
 *   - "anthropic" : the native Claude Messages API, called directly from the
 *                   service worker with the direct-browser-access header.
 *
 * Users supply their own API key via the options page. Nothing is sent
 * anywhere except the provider the user configured.
 */

const DEFAULTS = {
  provider: "deepseek",

  // OpenAI-compatible
  openaiApiKey: "",
  openaiBaseUrl: "https://api.openai.com/v1",
  openaiModel: "gpt-4o-mini",

  // DeepSeek (also OpenAI-compatible, kept as its own provider for convenience)
  deepseekApiKey: "",
  deepseekBaseUrl: "https://api.deepseek.com/v1",
  deepseekModel: "deepseek-chat",

  // Anthropic (Claude)
  anthropicApiKey: "",
  anthropicModel: "claude-haiku-4-5",

  // Translation target (what the OTHER party's messages get translated into)
  targetLang: "zh-CN",
  targetLabel: "中文",

  // Tone/register of the translation output
  tone: "natural"
};

// Register descriptors injected into the prompt.
const TONES = {
  natural: "natural and casual, the way people actually text friends — not formal or academic",
  friendly: "warm, friendly and approachable",
  professional: "polite and professional, while still sounding natural",
  playful: "playful and lively, with light humor where it fits",
  concise: "concise and to the point, with no filler"
};

const LANG_NAMES = {
  "zh-CN": "Chinese (Simplified)",
  "zh-TW": "Chinese (Traditional)",
  en: "English",
  ja: "Japanese",
  ko: "Korean",
  es: "Spanish",
  fr: "French",
  de: "German",
  ru: "Russian",
  pt: "Portuguese",
  it: "Italian",
  ar: "Arabic",
  hi: "Hindi",
  id: "Indonesian",
  th: "Thai",
  vi: "Vietnamese",
  tr: "Turkish"
};

function langName(code) {
  return LANG_NAMES[code] || code;
}

/**
 * Build the chat-tuned translation prompt.
 * mode "incoming": translate the other party's message into targetLang.
 * mode "outgoing": translate the user's draft into targetLang (the recipient's
 *                  language) so they can send it.
 */
function buildPrompt({ text, targetLang, mode, context, tone }) {
  const target = langName(targetLang);
  const toneDesc = TONES[tone] || TONES.natural;
  const roleLine =
    mode === "outgoing"
      ? `You are translating a chat message the user is about to SEND to their contact.`
      : `You are translating a chat message the user RECEIVED from their contact.`;

  let system = `You are a translation engine embedded in a WhatsApp chat. ${roleLine}

Translate the message into ${target}.

Rules:
- Output ONLY the translated ${target} text. No quotes, no notes, no labels, no explanations.
- Tone: render it in a ${toneDesc} register. Sound like a real person, adapted to the context — do not translate word-for-word.
- Preserve @mentions, URLs, phone numbers, code, hashtags, and emoji exactly as they appear.
- Keep the original meaning, tone, and any slang or humor.
- Do NOT translate proper names, brand names, or usernames.
- If the message is ALREADY in ${target}, or has no translatable text (only emoji / a URL / a number), return it unchanged.`;

  const ctx = (context || "").trim();
  if (ctx) {
    // The message is a reply that quotes an earlier message. Use it only to
    // resolve context (pronouns, what "it/that/name" refers to); still output
    // ONLY the translation of the reply itself.
    system += `

This message is a REPLY that quotes an earlier message: "${ctx.slice(0, 400)}"
Use that quoted message ONLY to understand context (what pronouns or references mean). Translate ONLY the reply below — do not translate or include the quoted message.`;
  }

  return { system, user: text };
}

function withTimeout(ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(id) };
}

// Generic caller for any OpenAI-compatible Chat Completions endpoint
// (OpenAI, DeepSeek, Groq, Azure, local proxies, ...).
async function chatCompletionsTranslate(config, payload) {
  const apiKey = (config.apiKey || "").trim();
  if (!apiKey) {
    return { ok: false, error: `Missing API key for ${config.label}. Set it in the extension Options page.` };
  }

  const baseUrl = (config.baseUrl || "").replace(/\/+$/, "");
  const model = config.model;
  const prompt = buildPrompt(payload);

  const t = withTimeout(25_000);
  try {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user }
        ],
        temperature: 0.3
      }),
      signal: t.signal
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { ok: false, error: `Provider error: HTTP ${resp.status} ${body || ""}`.trim() };
    }

    const data = await resp.json();
    const out = data?.choices?.[0]?.message?.content?.trim?.() || "";
    if (!out) return { ok: false, error: "Provider returned an empty result." };
    return { ok: true, text: out };
  } catch (e) {
    const msg = e?.name === "AbortError" ? "Translation timed out." : String(e?.message || e);
    return { ok: false, error: msg };
  } finally {
    t.clear();
  }
}

async function anthropicTranslate(settings, payload) {
  const apiKey = (settings.anthropicApiKey || "").trim();
  if (!apiKey) {
    return { ok: false, error: "Missing Anthropic API key. Set it in the extension Options page." };
  }

  const model = settings.anthropicModel || DEFAULTS.anthropicModel;
  const prompt = buildPrompt(payload);

  const t = withTimeout(25_000);
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        // Required to call the API directly from a browser / service-worker origin.
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user }]
      }),
      signal: t.signal
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { ok: false, error: `Provider error: HTTP ${resp.status} ${body || ""}`.trim() };
    }

    const data = await resp.json();
    const out = (data?.content || [])
      .filter((b) => b?.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!out) return { ok: false, error: "Provider returned an empty result." };
    return { ok: true, text: out };
  } catch (e) {
    const msg = e?.name === "AbortError" ? "Translation timed out." : String(e?.message || e);
    return { ok: false, error: msg };
  } finally {
    t.clear();
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "wat.translate") return;

  (async () => {
    const settings = await chrome.storage.sync.get(DEFAULTS);
    const p = msg.payload || {};

    if (!p.text || typeof p.text !== "string") {
      sendResponse({ ok: false, error: "Missing text." });
      return;
    }

    const payload = {
      text: p.text,
      targetLang: p.targetLang || settings.targetLang || DEFAULTS.targetLang,
      mode: p.mode === "outgoing" ? "outgoing" : "incoming",
      context: typeof p.context === "string" ? p.context : "",
      tone: settings.tone || DEFAULTS.tone
    };

    const provider = settings.provider || DEFAULTS.provider;
    if (provider === "anthropic") {
      sendResponse(await anthropicTranslate(settings, payload));
    } else if (provider === "deepseek") {
      sendResponse(
        await chatCompletionsTranslate(
          {
            label: "DeepSeek",
            apiKey: settings.deepseekApiKey,
            baseUrl: settings.deepseekBaseUrl || DEFAULTS.deepseekBaseUrl,
            model: settings.deepseekModel || DEFAULTS.deepseekModel
          },
          payload
        )
      );
    } else if (provider === "openai") {
      sendResponse(
        await chatCompletionsTranslate(
          {
            label: "OpenAI-compatible",
            apiKey: settings.openaiApiKey,
            baseUrl: settings.openaiBaseUrl || DEFAULTS.openaiBaseUrl,
            model: settings.openaiModel || DEFAULTS.openaiModel
          },
          payload
        )
      );
    } else {
      sendResponse({ ok: false, error: `Unsupported provider: ${provider}` });
    }
  })();

  return true; // keep the message channel open for the async response
});
