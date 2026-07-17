// Headless end-to-end verification of contentScript.js against a mock WhatsApp
// DOM, with chrome.* stubbed and a deterministic fake translator ("[T]" prefix).
// Proves injection / skip / dedup / emoji / recycle / click-mode / self-test
// without logging into WhatsApp.
//
// Run: node test/harness.mjs   (needs Google Chrome or a cached Playwright Chromium)

import { chromium } from "playwright-core";

const FIXTURE = new URL("./fixture.html", import.meta.url).href;

let failures = 0;
function check(name, cond) {
  const ok = !!cond;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failures++;
}

async function launch() {
  try {
    return await chromium.launch({ channel: "chrome", headless: true });
  } catch {
    return await chromium.launch({ headless: true });
  }
}

async function newPage(browser, hash = "") {
  const page = await browser.newPage({ viewport: { width: 1000, height: 4000 } });
  const warnings = [];
  page.on("console", (m) => {
    if (m.type() === "warning" || m.text().includes("[WAT]")) warnings.push(m.text());
  });
  await page.goto(FIXTURE + hash);
  await page.waitForTimeout(700); // rAF scan + async same-lang + fake fetch settle
  page._watWarnings = warnings;
  return page;
}

async function main() {
  const browser = await launch();

  // ---- 1. Auto mode: full pipeline ----
  {
    const page = await newPage(browser); // default #auto
    const r = await page.evaluate(() => ({
      A1: document.querySelector('[data-id="A1"] .wat-tr')?.textContent ?? null,
      A2: document.querySelector('[data-id="A2"] .wat-tr')?.textContent ?? null,
      OUT1: !!document.querySelector('[data-id="OUT1"] .wat-tr'),
      A3: !!document.querySelector('[data-id="A3"] .wat-tr'),
      A4: !!document.querySelector('[data-id="A4"] .wat-tr'),
      A5: !!document.querySelector('[data-id="A5"] .wat-tr'),
      A6: document.querySelector('[data-id="A6"] .wat-tr')?.textContent ?? null,
      A7: !!document.querySelector('[data-id="A7"] .wat-tr'),
      toggle: document.getElementById("wat-toggle")?.textContent ?? null,
      compose: !!document.querySelector(".wat-compose-btn"),
      calls: window.__watCalls
    }));

    check("auto: plain text translated", r.A1 === "[T]Hola, ¿cómo estás?");
    check("auto: emoji preserved in source", typeof r.A2 === "string" && r.A2.includes("😀") && r.A2.startsWith("[T]"));
    check("direction: outgoing (own) message ignored", r.OUT1 === false);
    check("skip: same-language (zh)", r.A3 === false);
    check("skip: deleted message", r.A4 === false);
    check("skip: media without caption", r.A5 === false);
    check(
      "quoted reply: translates the reply and passes the quote as context",
      typeof r.A6 === "string" && r.A6.startsWith("[T]see above") && r.A6.includes("«ctx:quoted junk»")
    );
    check("skip: emoji-only trivial", r.A7 === false);
    check("toggle docked and labelled", typeof r.toggle === "string" && r.toggle.includes("Auto"));
    check("compose affordance mounted", r.compose === true);
    // Only A1, A2, A6 should have hit the translator (3 calls).
    check("cost: exactly 3 API calls for 3 translatable messages", r.calls === 3);

    // ---- 2. Virtualization recycle: no re-translate ----
    const recycle = await page.evaluate(async () => {
      const before = window.__watCalls;
      const row = document.querySelector('[data-id="A1"]').closest('div[role="row"]');
      const parent = row.parentNode;
      parent.removeChild(row); // simulate scroll-out
      await new Promise((r) => setTimeout(r, 50));
      parent.appendChild(row); // simulate scroll back in (fresh mount, no .wat-tr)
      await new Promise((r) => setTimeout(r, 300));
      return {
        reinjected: document.querySelector('[data-id="A1"] .wat-tr')?.textContent ?? null,
        after: window.__watCalls,
        before
      };
    });
    check("recycle: translation re-injected from cache", recycle.reinjected === "[T]Hola, ¿cómo estás?");
    check("recycle: no extra API call", recycle.after === recycle.before);

    // ---- recycle where the container remounts BEFORE its text renders ----
    // (must not clobber the cached translation to "skip"; must reappear.)
    const emptyRecycle = await page.evaluate(async () => {
      const before = window.__watCalls;
      const bubble = document.querySelector('[data-id="A1"]');
      const span = bubble.querySelector('[data-testid="selectable-text"]');
      const saved = span.innerHTML;
      bubble.querySelector(".wat-tr")?.remove(); // fresh remount has no translation line
      span.innerHTML = ""; // ...and its text not rendered yet
      bubble.appendChild(document.createComment("m1")); // nudge the observer
      await new Promise((r) => setTimeout(r, 140));
      span.innerHTML = saved; // text finishes rendering
      bubble.appendChild(document.createComment("m2"));
      await new Promise((r) => setTimeout(r, 220));
      return {
        restored: document.querySelector('[data-id="A1"] .wat-tr')?.textContent ?? null,
        after: window.__watCalls,
        before
      };
    });
    check("empty-recycle: translation survives and reappears", emptyRecycle.restored === "[T]Hola, ¿cómo estás?");
    check("empty-recycle: no re-translation", emptyRecycle.after === emptyRecycle.before);

    // ---- React wipes the injected line -> it re-heals from cache, no re-call ----
    const wipe = await page.evaluate(async () => {
      const before = window.__watCalls;
      document.querySelector('[data-id="A2"] .wat-tr')?.remove();
      await new Promise((r) => setTimeout(r, 1400)); // past the safety-sweep interval
      return {
        back: document.querySelector('[data-id="A2"] .wat-tr')?.textContent ?? null,
        after: window.__watCalls,
        before
      };
    });
    check("react-wipe: line re-heals from cache", typeof wipe.back === "string" && wipe.back.startsWith("[T]Bien"));
    check("react-wipe: no re-translation", wipe.after === wipe.before);

    // ---- compose: translate my draft into the recipient's language ----
    await page.focus('[data-testid="conversation-compose-box-input"]');
    await page.keyboard.type("你好世界");
    await page.click(".wat-compose-btn");
    await page.waitForTimeout(200);
    const draft = await page.evaluate(() =>
      document.querySelector('[data-testid="conversation-compose-box-input"]').innerText.trim()
    );
    // Must REPLACE (box holds the translation, original Chinese gone), not append.
    check("compose: draft replaced not appended", draft.startsWith("EN[") && !draft.includes("你好世界"));

    await page.close();
  }

  // ---- 3. Click mode: nothing auto, button translates on demand ----
  {
    const page = await newPage(browser, "#mode=manual");
    const pre = await page.evaluate(() => ({
      anyTr: !!document.querySelector(".wat-tr"),
      btn: !!document.querySelector('[data-id="A1"] .wat-btn'),
      calls: window.__watCalls
    }));
    check("click: no auto translation", pre.anyTr === false);
    check("click: affordance present on incoming", pre.btn === true);
    check("click: no calls before clicking", pre.calls === 0);

    await page.click('[data-id="A1"] .wat-btn');
    await page.waitForTimeout(200);
    const post = await page.evaluate(() => document.querySelector('[data-id="A1"] .wat-tr')?.textContent ?? null);
    check("click: translation appears after click", post === "[T]Hola, ¿cómo estás?");
    await page.close();
  }

  // ---- 4. Self-test fires when message identity attributes disappear ----
  {
    const page = await newPage(browser, "#break");
    check(
      "self-test: warns on 0 matched messages under populated #main",
      page._watWarnings.some((w) => w.includes("[WAT]") && w.includes("self-test"))
    );
    await page.close();
  }

  // ---- 5. Knowledge-base capture (both directions, deduped, translation-linked) ----
  {
    const page = await newPage(browser, "#kb=1");
    await page.waitForTimeout(2900); // translations settle + debounced KB persist fires
    const kb = await page.evaluate(() => window.__watLocal["wat.kb"] || []);
    const byId = Object.fromEntries(kb.map((r) => [r.id, r]));
    check("kb: captures incoming + outgoing text messages (6)", kb.length === 6);
    check(
      "kb: outgoing record (direction/sender/text)",
      byId.OUT1 && byId.OUT1.direction === "out" && byId.OUT1.sender === "me" && byId.OUT1.text === "me too"
    );
    check("kb: incoming record fields", byId.A1 && byId.A1.direction === "in" && byId.A1.text === "Hola, ¿cómo estás?");
    check("kb: quoted reply stores reply + quote", byId.A6 && byId.A6.text === "see above" && byId.A6.quoted === "quoted junk");
    check("kb: deleted message not archived", !byId.A4);
    check("kb: translation linked when available", byId.A1 && byId.A1.translation === "[T]Hola, ¿cómo estás?");

    const again = await page.evaluate(async () => {
      document.querySelector('#main [role="application"]').appendChild(document.createComment("x"));
      await new Promise((r) => setTimeout(r, 2800));
      return (window.__watLocal["wat.kb"] || []).length;
    });
    check("kb: dedup by data-id (no duplicates on re-scan)", again === 6);
    await page.close();
  }

  await browser.close();

  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
