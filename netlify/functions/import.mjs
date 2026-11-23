// Reads a recipe from a link. POST { url, categories } with the family password.
// Returns a filled-in draft (not saved): the page shows it in the form for a final check.
//
// 1. Fetch the page and pull out its schema.org Recipe data (most recipe sites embed it).
// 2. With GEMINI_API_KEY set (a free Google AI Studio key), Gemini turns that data (or the
//    page text, when there is none) into Hebrew fields and picks the category. Without a
//    key, or when Gemini is slow or over its free quota, the recipe data is mapped directly
//    and the category is guessed from keywords.
import { json, checkPassword } from "../lib/auth.mjs";
import { plainHebrew } from "../lib/text.mjs";

const CATS = ["עיקריות", "מנות ראשונות", "סלטים", "מרקים", "תוספות", "מאפים ולחמים", "עוגות וקינוחים", "נשנושים", "ארוחת בוקר", "רטבים וממרחים", "משקאות"];

// Each step has its own deadline so a slow site or model ends with a clear message.
const FETCH_MS = 6000;
const AI_MS = 20000;
const MAX_PAGE_BYTES = 3_000_000;
const MAX_TEXT_CHARS = 30_000;

// code: what the page shows the family; detail: the technical reason, shown small underneath.
class ImportError extends Error { constructor(code, detail = "") { super(code); this.detail = detail; } }

function checkUrl(raw) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch { throw new ImportError("bad_url"); }
  if (!/^https?:$/.test(u.protocol)) throw new ImportError("bad_url");
  const h = u.hostname.toLowerCase();
  // Only public websites: no local names or private addresses.
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || !h.includes(".") ||
      /^(\d+\.){3}\d+$/.test(h) || h.includes(":")) throw new ImportError("bad_url");
  return u;
}

async function fetchPage(u, userAgent = "Mozilla/5.0 (compatible; FamilyRecipeBook/1.0)") {
  let res;
  try {
    res = await fetch(u, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_MS),
      headers: {
        "user-agent": userAgent,
        "accept": "text/html,application/xhtml+xml",
        "accept-language": "he,en;q=0.8",
      },
    });
  } catch (e) { throw new ImportError("fetch_failed", e.name === "TimeoutError" ? `the site did not answer within ${FETCH_MS / 1000}s` : String(e.message)); }
  if (!res.ok) throw new ImportError("fetch_failed", `the site answered ${res.status}`);
  const reader = res.body.getReader();
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length; chunks.push(value);
    if (size > MAX_PAGE_BYTES) { reader.cancel(); break; }
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

const decode = s => String(s ?? "")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const plain = s => decode(String(s ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

function findRecipeData(html) {
  const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const isRecipe = n => n && typeof n === "object" && [].concat(n["@type"] || []).some(t => String(t).toLowerCase() === "recipe");
  const walk = n => {
    if (!n || typeof n !== "object") return null;
    if (isRecipe(n)) return n;
    for (const v of Array.isArray(n) ? n : Object.values(n)) { const r = walk(v); if (r) return r; }
    return null;
  };
  for (const [, body] of blocks) {
    try { const r = walk(JSON.parse(body.trim())); if (r) return r; } catch { /* a broken block: try the next one */ }
  }
  return null;
}

function pageText(html) {
  const title = plain((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
  const body = html
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/li|\/h\d|\/div|\/tr)[^>]*>/gi, "\n");
  const text = decode(body.replace(/<[^>]+>/g, " ")).split("\n").map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
  return { title, text: text.slice(0, MAX_TEXT_CHARS) };
}

// ---- reels and short videos ----
// Many recipes live in the caption of an Instagram, TikTok, YouTube or Facebook video.
// These sites hide the caption from ordinary page fetches, so each one is read the way
// it publishes captions for link previews and embeds.
const BROWSER_UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";
const PREVIEW_UA = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";
const meta = (html, name) => decode((html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']*)["']`, "i")) ||
  html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${name}["']`, "i")) || [])[1] || "");
const lines = html => decode(String(html).replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).replace(/[ \t]+\n/g, "\n").trim();

function platformOf(u) {
  const h = u.hostname.replace(/^(www\.|m\.)/, "");
  if (/(^|\.)instagram\.com$/.test(h)) return "instagram";
  if (/(^|\.)tiktok\.com$/.test(h)) return "tiktok";
  if (/(^|\.)youtube\.com$|^youtu\.be$/.test(h)) return "youtube";
  if (/(^|\.)facebook\.com$|^fb\.watch$/.test(h)) return "facebook";
  return null;
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_MS), headers: { "user-agent": BROWSER_UA } });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

// Returns { platform, caption, author, title } or throws when the caption cannot be read.
async function readVideo(u, platform) {
  if (platform === "instagram") {
    const code = (u.pathname.match(/\/(?:reels?|p|tv)\/([\w-]+)/) || [])[1];
    if (code) {
      // The embed page carries the full caption without a login.
      const html = await fetchPage(new URL(`https://www.instagram.com/p/${code}/embed/captioned/`), BROWSER_UA).catch(() => "");
      const m = html.match(/class=["']Caption["'][^>]*>([\s\S]*?)<div class=["']CaptionComments/i);
      if (m) {
        const author = plain((m[1].match(/class=["']CaptionUsername["'][^>]*>([\s\S]*?)<\/a>/i) || [])[1]);
        const caption = lines(m[1].replace(/<a[^>]+class=["']CaptionUsername["'][\s\S]*?<\/a>/i, ""));
        if (caption) return { platform, caption, author: author && `@${author}` };
      }
    }
    const html = await fetchPage(u, PREVIEW_UA);
    const d = meta(html, "og:description") || meta(html, "description");
    // Preview text looks like: 1,234 likes, 56 comments - user on May 1, 2026: "caption"
    const m = d.match(/^[\s\S]*?-\s*([\w.]+)[^:]*:\s*["“]([\s\S]*)["”]\.?\s*$/);
    return { platform, caption: m ? m[2] : d, author: m ? `@${m[1]}` : "" };
  }
  if (platform === "tiktok") {
    const o = await fetchJson(`https://www.tiktok.com/oembed?url=${encodeURIComponent(u.href)}`);
    if (o?.title) return { platform, caption: o.title, author: o.author_unique_id ? `@${o.author_unique_id}` : o.author_name || "" };
  }
  if (platform === "youtube") {
    const html = await fetchPage(u, BROWSER_UA);
    const raw = (html.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/) || [])[1];
    let description = "";
    try { description = raw ? JSON.parse(`"${raw}"`) : ""; } catch { /* keep empty */ }
    const title = meta(html, "og:title");
    const author = (html.match(/"ownerChannelName":"((?:[^"\\]|\\.)*)"/) || [])[1] || "";
    if (description || title) return { platform, caption: description, title, author };
  }
  // Facebook and anything above that came back empty: the link preview text.
  const html = await fetchPage(u, PREVIEW_UA);
  return { platform, caption: meta(html, "og:description") || meta(html, "description"), title: meta(html, "og:title") };
}

// Without AI: split a caption into ingredients and steps by its own headings.
// (\b does not work next to Hebrew letters, so a heading is the word followed by no other letter.)
const ING_HEAD = /^[^\p{L}\d]*(?:מצרכים|המצרכים|מרכיבים|רכיבים|חומרים|ingredients?)(?!\p{L})[^\p{L}]*$/iu;
const STEP_HEAD = /^[^\p{L}\d]*(?:אופן ההכנה|אופן הכנה|הכנה|ההכנה|הוראות|הוראות הכנה|שלבי הכנה|instructions?|method|directions|preparation|how to make)(?!\p{L})[^\p{L}]*$/iu;
const tidy = t => t.replace(/#[\p{L}\d_]+/gu, "").replace(/^[\s•\-–*·▪️✅✔️👉🔸🔹⭐️]+/u, "").replace(/^\d+[.)]\s*/, "").trim();
function captionDraft(v, categories) {
  const all = String(v.caption || "").split(/\n/).map(l => l.trim());
  const ingAt = all.findIndex(l => ING_HEAD.test(l)), stepAt = all.findIndex(l => STEP_HEAD.test(l));
  const body = l => l.map(tidy).filter(Boolean);
  let ingredients = [], steps = [], intro = [];
  if (ingAt >= 0) {
    ingredients = body(all.slice(ingAt + 1, stepAt > ingAt ? stepAt : undefined));
    if (stepAt > ingAt) steps = body(all.slice(stepAt + 1));
    intro = body(all.slice(0, ingAt));
  } else if (stepAt >= 0) {
    steps = body(all.slice(stepAt + 1)); intro = body(all.slice(0, stepAt));
  }
  const first = body(all)[0] || "";
  const title = (v.title && v.platform === "youtube" ? plain(v.title) : intro[0] || first).replace(/[.!:]+$/, "").slice(0, 120);
  const draft = {
    title, category: guessCategory({ name: title, keywords: all.join(" ") }, categories), author: v.author || "",
    intro: intro.slice(1, 2).join(" ").slice(0, 300), servings: "", time: "", ingredients, steps,
    notes: ingredients.length || steps.length ? "" : body(all).join("\n"),
    vegan: /טבעונ|vegan/i.test(all.join(" ")),
  };
  return draft;
}

// ---- mapping schema.org data directly (used when there is no API key) ----
function isoDuration(s) {
  const m = String(s || "").match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/i);
  if (!m || !(m[1] || m[2] || m[3])) return plain(s);
  const mins = (+m[1] || 0) * 1440 + (+m[2] || 0) * 60 + (+m[3] || 0);
  const h = Math.floor(mins / 60), mm = mins % 60;
  const hours = h === 0 ? "" : h === 1 ? "שעה" : h === 2 ? "שעתיים" : `${h} שעות`;
  if (!mm) return hours;
  return hours ? `${hours} ו-${mm} דקות` : `${mm} דקות`;
}
function steps(ins) {
  const out = [];
  const add = n => {
    if (!n) return;
    if (typeof n === "string") { plain(n).split(/\s*\n\s*/).filter(Boolean).forEach(t => out.push(t)); return; }
    if (Array.isArray(n)) { n.forEach(add); return; }
    if (n.itemListElement) { add(n.itemListElement); return; } // a section: keep its steps
    add(n.text || n.name);
  };
  add(ins);
  return out;
}
const KEYWORDS = [
  ["עוגות וקינוחים", /עוג|קינוח|עוגי|מאפה מתוק|שוקולד|cake|cookie|dessert|brownie|tart|pie/i],
  ["מאפים ולחמים", /לחם|חלה|מאפ|בצק|פיתה|פוקאצ|bread|bun|pastry|focaccia|challah|dough/i],
  ["מרקים", /מרק|soup|broth/i],
  ["סלטים", /סלט|salad/i],
  ["עיקריות", /פסטה|ספגטי|לזניה|עוף|בשר|קציצ|דג |סלמון|אורז מוקפץ|pasta|spaghetti|lasagna|chicken|beef|salmon|stir.?fry/i],
  ["רטבים וממרחים", /^(?:רוטב|ממרח|מטבל)|sauce$|dip|spread|dressing|pesto/i],
  ["משקאות", /משקה|שייק|לימונדה|drink|smoothie|cocktail|juice/i],
  ["ארוחת בוקר", /בוקר|שקשוקה|חביתה|פנקייק|breakfast|pancake|omelet|granola/i],
  ["נשנושים", /נשנוש|חטיף|קרקר|snack|cracker/i],
  ["תוספות", /תוספת|אורז|פירה|side dish|rice/i],
  ["מנות ראשונות", /ראשונה|starter|appetizer/i],
];
function guessCategory(r, categories) {
  const hay = [r.recipeCategory, r.name, r.keywords, r.recipeCuisine].flat().filter(Boolean).join(" ");
  for (const [cat, re] of KEYWORDS) if (re.test(hay) && categories.includes(cat)) return cat;
  return "עיקריות";
}
function mapDirect(r, categories) {
  const author = [].concat(r.author || [])[0];
  const yieldText = [].concat(r.recipeYield || []).map(plain).sort((a, b) => b.length - a.length)[0] || "";
  return {
    title: plain(r.name),
    category: guessCategory(r, categories),
    author: plain(typeof author === "string" ? author : author?.name),
    intro: plain(r.description).slice(0, 300),
    servings: /^\d+$/.test(yieldText) ? `${yieldText} מנות` : yieldText,
    time: isoDuration(r.totalTime || r.cookTime || r.prepTime),
    ingredients: [].concat(r.recipeIngredient || r.ingredients || []).map(plain).filter(Boolean),
    steps: steps(r.recipeInstructions),
    notes: "",
    vegan: [].concat(r.suitableForDiet || []).some(d => /vegan/i.test(String(d))) || /טבעונ|vegan/i.test([r.name, r.keywords, r.recipeCategory].flat().join(" ")),
  };
}

// ---- Gemini ----
const S = (description) => ({ type: "STRING", description });
const DRAFT_SCHEMA = {
  type: "OBJECT",
  properties: {
    is_recipe: { type: "BOOLEAN", description: "false when the page has no recipe in it" },
    title: S("recipe name, in Hebrew"),
    category: S("one of the given categories, or a short new Hebrew category if none fits"),
    author: S("who wrote the recipe, or empty"),
    intro: S("one short sentence, or empty"),
    servings: S("how many servings, e.g. ״4 מנות״, or empty"),
    time: S("total time in Hebrew words, e.g. ״45 דקות״, or empty"),
    ingredients: { type: "ARRAY", items: S("one ingredient with its quantity, in Hebrew; a group header like ״לרוטב:״ ends with a colon") },
    steps: { type: "ARRAY", items: S("one preparation step, in Hebrew") },
    notes: S("tips from the page in Hebrew, or empty"),
    vegan: { type: "BOOLEAN", description: "true only when the recipe has no animal products at all (no meat, fish, eggs, dairy or honey)" },
  },
  required: ["is_recipe", "title", "category", "author", "intro", "servings", "time", "ingredients", "steps", "notes", "vegan"],
};

// Which Gemini to call. A key the family saved under any name starting with GEMINI_API_KEY_
// (e.g. GEMINI_API_KEY_recepies) goes straight to Google's free tier. Otherwise GEMINI_API_KEY is
// used; when Netlify injected it (AI Gateway, with GOOGLE_GEMINI_BASE_URL set) requests go through
// Netlify and use the account's monthly credits.
const GOOGLE_BASE = "https://generativelanguage.googleapis.com";
const clean = v => String(v || "").trim().replace(/^["']|["']$/g, "");
function geminiSetup() {
  const env = { ...process.env, ...(Netlify.env.toObject?.() || {}) };
  const own = Object.keys(env).find(k => /^GEMINI_API_KEY_./i.test(k) && clean(env[k]));
  if (own) return { key: clean(env[own]), base: GOOGLE_BASE, model: env.GEMINI_MODEL || "gemini-flash-lite-latest", source: own };
  const key = clean(env.GEMINI_API_KEY);
  if (!key) return null;
  const gateway = clean(env.GOOGLE_GEMINI_BASE_URL);
  return gateway
    ? { key, base: gateway, model: env.GEMINI_MODEL || "gemini-3-flash-preview", source: "Netlify AI Gateway" }
    : { key, base: GOOGLE_BASE, model: env.GEMINI_MODEL || "gemini-flash-lite-latest", source: "GEMINI_API_KEY" };
}

// One source can hold several recipes (a carousel post, a cookbook spread, a long message).
const MULTI_SCHEMA = { type: "OBJECT", properties: { recipes: { type: "ARRAY", items: DRAFT_SCHEMA } }, required: ["recipes"] };

// When Google says a free model is overloaded ("high demand", 503) or out of quota for it, the next one usually answers.
const FALLBACK_MODELS = { google: ["gemini-flash-latest", "gemini-2.5-flash-lite"], gateway: ["gemini-2.5-flash"] };
const BUDGET_MS = 24000;

async function withGemini(setup, source, categories, opts = {}) {
  const models = [setup.model, ...FALLBACK_MODELS[setup.base === GOOGLE_BASE ? "google" : "gateway"].filter(m => m !== setup.model)];
  const until = Date.now() + BUDGET_MS;
  let last;
  for (const model of models) {
    const left = until - Date.now();
    if (left < 3000) break;
    try { return await askGemini({ ...setup, model }, source, categories, opts, Math.min(AI_MS, left)); }
    catch (e) {
      last = e;
      if (!(e instanceof ImportError) || !e.retry) throw e;
      console.error("gemini fallback:", e.detail);
    }
  }
  throw new ImportError(last.message, last.detail);
}

async function askGemini(setup, source, categories, { multi = false, known = false } = {}, ms = AI_MS) {
  const { key: apiKey, base, model } = setup;
  let res;
  try {
    res = await fetch(`${base.replace(/\/+$/, "")}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      signal: AbortSignal.timeout(ms),
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text:
          "You turn a recipe (a web page, a video caption, a photo or pasted text) into fields for a family's Hebrew recipe book. " +
          "Write every value in Hebrew. When the source is in English or any other language, translate everything (title, ingredients, steps, notes) into natural Hebrew as an Israeli home cook would write it. " +
          "When translating, convert Fahrenheit to Celsius and ounces, pounds and sticks of butter to grams; keep cups and spoons as כוס, כף, כפית. " +
          "Keep the ingredients, quantities and steps faithful to the source and do not invent ingredients or steps. " +
          "When an ingredient has no quantity in the source, add a typical amount for this recipe and start it with \"כ-\" so the family sees it is an estimate (for example \"כ-3 כפות שמן\", \"כ-1 כפית מלח\"). " +
          "When the source does not say how many it serves, estimate it the same way (for example \"כ-6 מנות\"). Leave time and author empty when the source does not say. " +
          `Choose the category from this list: ${JSON.stringify(categories)}.` +
          (multi ? " The source may hold several separate recipes: return each one as its own entry in \"recipes\", in the order they appear. Do not merge different dishes, and do not split one recipe into parts." : "") }] },
        contents: [{ role: "user", parts: typeof source === "string" ? [{ text: source }] : source }],
        generationConfig: {
          responseMimeType: "application/json", responseSchema: multi ? MULTI_SCHEMA : DRAFT_SCHEMA, maxOutputTokens: multi ? 24000 : 8000,
          ...(/^gemini-3/.test(model) ? { thinkingConfig: { thinkingLevel: "low" } } : {}),
        },
      }),
    });
  } catch (e) {
    const err = new ImportError("read_failed", e.name === "TimeoutError" ? `Gemini did not answer within ${Math.round(ms / 1000)}s (${model})` : `Gemini unreachable: ${e.message}`);
    err.retry = e.name === "TimeoutError";
    throw err;
  }
  if (!res.ok) {
    const body = await res.text();
    console.error("gemini", res.status, body.slice(0, 500));
    let message = body.slice(0, 200);
    try { message = JSON.parse(body).error?.message || message; } catch { /* not JSON */ }
    // For a rejected key, say what was saved (first 3 characters and length only) so a wrong value is easy to spot.
    const keyHint = /api key|auth|token/i.test(message) ? ` [key from ${setup.source}: starts "${apiKey.slice(0, 3)}", ${apiKey.length} characters]` : "";
    const overloaded = res.status === 503 || res.status === 500 || /high demand|overloaded/i.test(message);
    const err = new ImportError(overloaded ? "overloaded" : res.status === 429 ? "busy" : "read_failed", `Gemini ${res.status} (${model}): ${message}${keyHint}`);
    err.retry = overloaded || res.status === 429 || res.status === 404; // 404: this model name is not offered to this key
    throw err;
  }
  const out = await res.json();
  const cand = out.candidates?.[0];
  const text = (cand?.content?.parts || []).map(p => p.text || "").join("");
  let draft;
  try { draft = JSON.parse(text); } catch {
    throw new ImportError("read_failed", `Gemini returned no usable answer (${cand?.finishReason || out.promptFeedback?.blockReason || "empty"})`);
  }
  const str = v => plainHebrew(v).trim();
  const list = v => (Array.isArray(v) ? v : []).map(str).filter(Boolean);
  const tidy = d => ({
    title: str(d.title), category: str(d.category) || "עיקריות", author: str(d.author), intro: str(d.intro),
    servings: str(d.servings), time: str(d.time), ingredients: list(d.ingredients), steps: list(d.steps), notes: str(d.notes),
    vegan: d.vegan === true,
  });
  if (multi) {
    const found = (Array.isArray(draft.recipes) ? draft.recipes : []).filter(d => d && d.is_recipe).map(tidy)
      .filter(d => d.title && (d.ingredients.length || d.steps.length));
    if (!found.length) throw new ImportError("no_recipe");
    return found;
  }
  // "known": the family already has this recipe (translating, filling amounts), so never answer "no recipe".
  if (!draft.is_recipe && !known) throw new ImportError("no_recipe");
  return tidy(draft);
}

// Scanning: photos of a cookbook page, a handwritten card or a screenshot (up to 4, in order).
const MAX_IMAGE_BYTES = 4_000_000;
async function fromImages(images, categories) {
  const parts = images.slice(0, 4).map(b64 => {
    const buf = Buffer.from(String(b64 || ""), "base64");
    if (buf.length < 100 || buf.length > MAX_IMAGE_BYTES || buf[0] !== 0xff || buf[1] !== 0xd8) throw new ImportError("bad_image");
    return { inline_data: { mime_type: "image/jpeg", data: buf.toString("base64") } };
  });
  if (!parts.length) throw new ImportError("bad_image");
  const setup = geminiSetup();
  if (!setup) throw new ImportError("needs_ai_scan");
  try {
    return await withGemini(setup, [
      { text: `${parts.length > 1 ? `These ${parts.length} images come from one post, card or book, in order` : "This image is from a post, a card or a book"}: a cookbook page, a handwritten card, a screenshot or a photo of a screen. ` +
        "They may hold one recipe (perhaps spread over several images) or several different recipes. " +
        "Read all the text, including handwriting, and fill the fields from what is written. If a word is unclear, write your best reading." },
      ...parts,
    ], categories, { multi: true });
  } catch (e) { throw e instanceof ImportError && e.message === "no_recipe" ? new ImportError("no_recipe_image") : e; }
}

// Pasted text: a caption copied from a reel, a WhatsApp message, a page...
async function fromText(text, categories) {
  text = String(text).trim().slice(0, MAX_TEXT_CHARS);
  if (text.length < 20) throw new ImportError("short_text");
  const setup = geminiSetup();
  if (setup) {
    try { return await withGemini(setup, `Recipe text the family copied and pasted (often a video caption or a message):\n${text}`, categories, { multi: true }); }
    catch (e) { if (e instanceof ImportError && e.message === "no_recipe") throw e; /* else split it by its own headings below */ }
  }
  const draft = captionDraft({ caption: text }, categories);
  if (!draft.title) throw new ImportError("no_recipe");
  return [await inHebrew(draft, categories)];
}

// "השלמת כמויות": estimated amounts for ingredients that have none, and servings when missing.
async function fillAmounts(r, categories) {
  const setup = geminiSetup();
  if (!setup) throw new ImportError("needs_ai_fill");
  const recipe = {
    title: plainHebrew(r.title), category: plainHebrew(r.category), servings: plainHebrew(r.servings),
    ingredients: (Array.isArray(r.ingredients) ? r.ingredients : []).map(plainHebrew).slice(0, 200),
    steps: (Array.isArray(r.steps) ? r.steps : []).map(plainHebrew).slice(0, 200), notes: plainHebrew(r.notes).slice(0, 3000),
  };
  if (!recipe.ingredients.length) throw new ImportError("no_ingredients");
  const draft = await withGemini(setup,
    "Here is a recipe from the family book. Return it with the same title, steps and notes, and the same ingredients in the same order " +
    "(keep group headers that end with a colon). Change only this: every ingredient that has no quantity gets a typical amount for this recipe, " +
    "starting with \"כ-\"; a line that lists several seasonings may be split into one line per seasoning. Keep every quantity that is already there exactly as written. " +
    "If servings is empty, estimate it starting with \"כ-\".\n" + JSON.stringify(recipe), categories, { known: true });
  return { ingredients: draft.ingredients, servings: recipe.servings || draft.servings };
}

// A recipe in another language, translated to Hebrew. Used for a saved recipe and when a page's own data was used without Gemini.
const isForeign = r => { const t = [r.title, ...(r.ingredients || []), ...(r.steps || []), r.notes].join(" ");
  return (t.match(/[A-Za-z]/g) || []).length > 2 * (t.match(/[\u05D0-\u05EA]/g) || []).length; };
async function translate(r, categories) {
  const setup = geminiSetup();
  if (!setup) throw new ImportError("needs_ai_translate");
  const recipe = {
    title: String(r.title || ""), category: String(r.category || ""), author: String(r.author || ""), intro: String(r.intro || "").slice(0, 2000),
    servings: String(r.servings || ""), time: String(r.time || ""), notes: String(r.notes || "").slice(0, 3000),
    ingredients: (Array.isArray(r.ingredients) ? r.ingredients : []).map(String).slice(0, 200),
    steps: (Array.isArray(r.steps) ? r.steps : []).map(String).slice(0, 200),
  };
  const ask = strict => (strict
      ? "The previous answer was still in English. Every field you return MUST be written in Hebrew letters: translate the title, every ingredient, every step and the notes. " +
        "Only brand names may stay in English. תרגם את כל המתכון לעברית.\n"
      : "Translate this recipe from the family book into Hebrew. ") +
    "Keep every ingredient, quantity and step, in the same order; keep group headers that end with a colon. Keep the author's name as written.\n" + JSON.stringify(recipe);
  let d = await withGemini(setup, ask(false), categories, { known: true });
  if (isForeign(d)) d = await withGemini(setup, ask(true), categories, { known: true });
  if (isForeign(d)) throw new ImportError("still_foreign");
  return { ...d, author: recipe.author || d.author, category: d.category || recipe.category };
}

// A draft made without Gemini's full reading (page data or a caption split by its headings): translate it on its own,
// which is short and usually quick; if that fails too, mark it so the form says so.
async function inHebrew(draft, categories) {
  if (!isForeign(draft) || !geminiSetup()) return isForeign(draft) ? { ...draft, untranslated: true } : draft;
  try { return { ...(await translate(draft, categories)), author: draft.author }; }
  catch { return { ...draft, untranslated: true }; }
}

async function fromVideo(url, platform, categories) {
  const v = await readVideo(url, platform);
  if (!String(v.caption || "").trim() && !v.title) throw new ImportError("no_caption", `${platform}: no caption could be read`);
  const setup = geminiSetup();
  if (setup) {
    const source = `This is the caption of a ${platform} video${v.author ? ` by ${v.author}` : ""}. Most of the time it holds a full recipe.\n` +
      (v.title ? `Video title: ${v.title}\n` : "") + `Caption:\n${String(v.caption).slice(0, MAX_TEXT_CHARS)}`;
    try {
      const found = await withGemini(setup, source, categories, { multi: true });
      for (const d of found) if (!d.author && v.author) d.author = v.author;
      return found;
    } catch {
      // Gemini unavailable, over quota or found no recipe: split the caption by its own headings.
    }
  }
  const draft = captionDraft(v, categories);
  if (!draft.title) throw new ImportError("no_caption", `${platform}: the caption is empty`);
  return [await inHebrew(draft, categories)];
}

export default async (req) => {
  const denied = checkPassword(req);
  if (denied) return denied;
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const extra = (Array.isArray(body.categories) ? body.categories : []).map(c => String(c).slice(0, 40)).filter(Boolean).slice(0, 40);
  const categories = [...new Set([...CATS, ...extra])];

  try {
    // Every reader returns a list: usually one recipe, several when the source holds several.
    // Light models sometimes skip the translation: anything still not in Hebrew gets its own translation pass.
    const reply = async (list, extra = {}) => {
      const recipes = [];
      for (const d of list) recipes.push({ ...(d.untranslated ? d : await inHebrew(d, categories)), ...extra });
      return json({ recipe: recipes[0], recipes });
    };
    if (Array.isArray(body.images)) return await reply(await fromImages(body.images, categories));
    if (typeof body.text === "string") return await reply(await fromText(body.text, categories));
    if (body.fillAmounts && typeof body.fillAmounts === "object") return json({ recipe: await fillAmounts(body.fillAmounts, categories) });
    if (body.translate && typeof body.translate === "object") return json({ recipe: await translate(body.translate, categories) });
    const url = checkUrl(body.url);
    const platform = platformOf(url);
    if (platform) return await reply(await fromVideo(url, platform, categories), { source: url.href });
    const html = await fetchPage(url);
    const data = findRecipeData(html);
    const setup = geminiSetup();
    let draft, many = null;
    if (setup) {
      const { title, text } = pageText(html);
      const source = data
        ? `Recipe data embedded in the page (schema.org):\n${JSON.stringify(data).slice(0, MAX_TEXT_CHARS)}`
        : `Page title: ${title}\n\nPage text:\n${text}`;
      try {
        many = await withGemini(setup, source, categories, { multi: true });
        draft = many[0];
      } catch (e) {
        // If Gemini is slow, out of free quota or unavailable, use the page's own recipe data.
        if (e instanceof ImportError && e.message === "no_recipe") throw e;
        if (!data) {
          if (e instanceof ImportError) { e.detail = `${e.detail}; the page has no embedded recipe data`; throw e; }
          throw new ImportError("read_failed", String(e?.message || e));
        }
        draft = mapDirect(data, categories);
        // The full page was too much for Gemini this time; the short recipe alone usually translates quickly.
        draft = await inHebrew(draft, categories);
      }
    } else {
      if (!data) throw new ImportError("needs_ai");
      draft = mapDirect(data, categories);
      if (isForeign(draft)) draft.untranslated = true;
    }
    if (!draft.title || (!draft.ingredients.length && !draft.steps.length)) throw new ImportError("no_recipe");
    return await reply(many || [draft], { source: url.href });
  } catch (e) {
    if (e instanceof ImportError) return json({ error: e.message, detail: e.detail }, 422);
    console.error(e);
    return json({ error: "read_failed", detail: String(e?.message || e).slice(0, 200) }, 500);
  }
};

export const config = { path: "/api/import" };
