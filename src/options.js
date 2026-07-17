const DEFAULTS = {
  provider: "deepseek",

  openaiApiKey: "",
  openaiBaseUrl: "https://api.openai.com/v1",
  openaiModel: "gpt-4o-mini",

  deepseekApiKey: "",
  deepseekBaseUrl: "https://api.deepseek.com/v1",
  deepseekModel: "deepseek-chat",

  anthropicApiKey: "",
  anthropicModel: "claude-haiku-4-5",

  targetLang: "zh-CN",
  targetLabel: "中文",

  tone: "natural", // natural | friendly | professional | playful | concise

  mode: "auto", // "auto" | "manual"
  dailyBudget: 0,

  outgoingEnabled: false,
  outgoingLang: "en",
  outgoingLabel: "English",

  kbEnabled: false
};

const KB_KEY = "wat.kb";

// Short display labels shown on in-chat controls.
const SHORT_LABEL = {
  "zh-CN": "中文",
  "zh-TW": "繁體中文",
  en: "English",
  ja: "日本語",
  ko: "한국어",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  ru: "Русский",
  pt: "Português",
  it: "Italiano",
  ar: "العربية",
  hi: "हिन्दी",
  id: "Indonesian",
  th: "ไทย",
  vi: "Tiếng Việt",
  tr: "Türkçe"
};

function $(id) {
  return document.getElementById(id);
}

function setStatus(text) {
  $("status").textContent = text;
}

function syncProviderFields() {
  const p = $("provider").value;
  $("openaiFields").classList.toggle("hidden", p !== "openai");
  $("deepseekFields").classList.toggle("hidden", p !== "deepseek");
  $("anthropicFields").classList.toggle("hidden", p !== "anthropic");
}

function syncOutgoingFields() {
  $("outgoingLangRow").classList.toggle("hidden", !$("outgoingEnabled").checked);
}

async function load() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  $("provider").value = s.provider;
  $("openaiBaseUrl").value = s.openaiBaseUrl;
  $("openaiModel").value = s.openaiModel;
  $("openaiApiKey").value = s.openaiApiKey;
  $("deepseekModel").value = s.deepseekModel;
  $("deepseekApiKey").value = s.deepseekApiKey;
  $("anthropicModel").value = s.anthropicModel;
  $("anthropicApiKey").value = s.anthropicApiKey;
  $("targetLang").value = s.targetLang;
  $("tone").value = s.tone;
  $("mode").value = s.mode;
  $("dailyBudget").value = s.dailyBudget || 0;
  $("outgoingEnabled").checked = s.outgoingEnabled;
  $("outgoingLang").value = s.outgoingLang;
  $("kbEnabled").checked = s.kbEnabled;
  syncProviderFields();
  syncOutgoingFields();
  refreshKBCount();
}

async function refreshKBCount() {
  try {
    const arr = (await chrome.storage.local.get({ [KB_KEY]: [] }))[KB_KEY];
    $("kbCount").textContent = String((arr && arr.length) || 0);
  } catch {
    $("kbCount").textContent = "?";
  }
}

async function exportKB() {
  const arr = (await chrome.storage.local.get({ [KB_KEY]: [] }))[KB_KEY] || [];
  const blob = new Blob([JSON.stringify(arr, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "whatsapp-kb.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  setStatus(`Exported ${arr.length} records`);
}

async function clearKB() {
  if (!confirm("Clear all captured messages from the local knowledge base?")) return;
  // Signal the content script (sole writer) to wipe its in-memory copy too.
  await chrome.storage.local.set({ [KB_KEY]: [], "wat.kbClear": Date.now() });
  await refreshKBCount();
  setStatus("Knowledge base cleared");
}

// If the user points at a custom OpenAI-compatible host, request permission for it.
async function ensureHostPermission(baseUrl) {
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== "https:") return true; // only https hosts matter here
    const origin = `${u.origin}/*`;
    // Already granted at install time.
    if (u.hostname === "api.openai.com" || u.hostname === "api.anthropic.com") return true;
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (has) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch {
    return true; // don't block saving on a parse hiccup
  }
}

async function save() {
  setStatus("Saving...");

  const provider = $("provider").value;
  const openaiBaseUrl = $("openaiBaseUrl").value.trim() || DEFAULTS.openaiBaseUrl;

  if (provider === "openai") {
    const granted = await ensureHostPermission(openaiBaseUrl);
    if (!granted) {
      setStatus("Permission for that Base URL was denied - translation to it will fail.");
      return;
    }
  }

  const targetLang = $("targetLang").value;
  const outgoingLang = $("outgoingLang").value;

  const next = {
    provider,

    openaiBaseUrl,
    openaiModel: $("openaiModel").value.trim() || DEFAULTS.openaiModel,
    openaiApiKey: $("openaiApiKey").value.trim(),

    deepseekBaseUrl: DEFAULTS.deepseekBaseUrl,
    deepseekModel: $("deepseekModel").value.trim() || DEFAULTS.deepseekModel,
    deepseekApiKey: $("deepseekApiKey").value.trim(),

    anthropicModel: $("anthropicModel").value.trim() || DEFAULTS.anthropicModel,
    anthropicApiKey: $("anthropicApiKey").value.trim(),

    targetLang,
    targetLabel: SHORT_LABEL[targetLang] || targetLang,

    tone: $("tone").value,

    mode: $("mode").value,
    dailyBudget: Number($("dailyBudget").value) || 0,

    kbEnabled: $("kbEnabled").checked,

    outgoingEnabled: $("outgoingEnabled").checked,
    outgoingLang,
    outgoingLabel: SHORT_LABEL[outgoingLang] || outgoingLang
  };

  await chrome.storage.sync.set(next);
  setStatus("Saved. Reload your WhatsApp Web tab to apply.");
  setTimeout(() => setStatus(""), 4000);
}

document.addEventListener("DOMContentLoaded", async () => {
  await load();
  $("provider").addEventListener("change", syncProviderFields);
  $("outgoingEnabled").addEventListener("change", syncOutgoingFields);
  $("saveBtn").addEventListener("click", save);
  $("kbExportBtn").addEventListener("click", exportKB);
  $("kbClearBtn").addEventListener("click", clearKB);
});
