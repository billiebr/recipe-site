// Reads a recipe from a link. POST { url, categories } with the family password.
// Returns a filled-in draft (not saved): the page shows it in the form for a final check.
//
// 1. Fetch the page and pull out its schema.org Recipe data (most recipe sites embed it).
// 2. With GEMINI_API_KEY set (a free Google AI Studio key), Gemini turns that data (or the
//    page text, when there is none) into Hebrew fields and picks the category. Without a
//    key, or when Gemini is slow or over its free quota, the recipe data is mapped directly
//    and the category is guessed from keywords.
import { json, checkPassword } from "../lib/auth.mjs";

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
    title: S("recipe name"),
    category: S("one of the given categories, or a short new Hebrew category if none fits"),
    author: S("who wrote the recipe, or empty"),
    intro: S("one short sentence, or empty"),
    servings: S("how many servings, e.g. ״4 מנות״, or empty"),
    time: S("total time in Hebrew words, e.g. ״45 דקות״, or empty"),
    ingredients: { type: "ARRAY", items: S("one ingredient with its quantity; a group header like ״לרוטב:״ ends with a colon") },
    steps: { type: "ARRAY", items: S("one preparation step") },
    notes: S("tips from the page, or empty"),
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

async function withGemini(setup, source, categories) {
  const { key: apiKey, base, model } = setup;
  let res;
  try {
    res = await fetch(`${base.replace(/\/+$/, "")}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      signal: AbortSignal.timeout(AI_MS),
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text:
          "You turn a recipe web page into fields for a family's Hebrew recipe book. " +
          "Write every value in Hebrew, translating if the page is in another language. " +
          "Keep quantities and steps faithful to the page and do not invent anything; leave a field empty when the page does not say. " +
          `Choose the category from this list: ${JSON.stringify(categories)}.` }] },
        contents: [{ role: "user", parts: [{ text: source }] }],
        generationConfig: {
          responseMimeType: "application/json", responseSchema: DRAFT_SCHEMA, maxOutputTokens: 8000,
          ...(/^gemini-3/.test(model) ? { thinkingConfig: { thinkingLevel: "low" } } : {}),
        },
      }),
    });
  } catch (e) {
    throw new ImportError("read_failed", e.name === "TimeoutError" ? `Gemini did not answer within ${AI_MS / 1000}s` : `Gemini unreachable: ${e.message}`);
  }
  if (!res.ok) {
    const body = await res.text();
    console.error("gemini", res.status, body.slice(0, 500));
    let message = body.slice(0, 200);
    try { message = JSON.parse(body).error?.message || message; } catch { /* not JSON */ }
    // For a rejected key, say what was saved (first 3 characters and length only) so a wrong value is easy to spot.
    const keyHint = /api key|auth|token/i.test(message) ? ` [key from ${setup.source}: starts "${apiKey.slice(0, 3)}", ${apiKey.length} characters]` : "";
    throw new ImportError(res.status === 429 ? "busy" : "read_failed", `Gemini ${res.status} (${model}): ${message}${keyHint}`);
  }
  const out = await res.json();
  const cand = out.candidates?.[0];
  const text = (cand?.content?.parts || []).map(p => p.text || "").join("");
  let draft;
  try { draft = JSON.parse(text); } catch {
    throw new ImportError("read_failed", `Gemini returned no usable answer (${cand?.finishReason || out.promptFeedback?.blockReason || "empty"})`);
  }
  if (!draft.is_recipe) throw new ImportError("no_recipe");
  const str = v => String(v ?? "").trim();
  const list = v => (Array.isArray(v) ? v : []).map(str).filter(Boolean);
  return {
    title: str(draft.title), category: str(draft.category) || "עיקריות", author: str(draft.author), intro: str(draft.intro),
    servings: str(draft.servings), time: str(draft.time), ingredients: list(draft.ingredients), steps: list(draft.steps), notes: str(draft.notes),
    vegan: draft.vegan === true,
  };
}

async function fromVideo(url, platform, categories) {
  const v = await readVideo(url, platform);
  if (!String(v.caption || "").trim() && !v.title) throw new ImportError("no_caption", `${platform}: no caption could be read`);
  const setup = geminiSetup();
  if (setup) {
    const source = `This is the caption of a ${platform} video${v.author ? ` by ${v.author}` : ""}. Most of the time it holds a full recipe.\n` +
      (v.title ? `Video title: ${v.title}\n` : "") + `Caption:\n${String(v.caption).slice(0, MAX_TEXT_CHARS)}`;
    try {
      const draft = await withGemini(setup, source, categories);
      if (!draft.author && v.author) draft.author = v.author;
      return draft;
    } catch {
      // Gemini unavailable, over quota or found no recipe: split the caption by its own headings.
    }
  }
  const draft = captionDraft(v, categories);
  if (!draft.title) throw new ImportError("no_caption", `${platform}: the caption is empty`);
  return draft;
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
    const url = checkUrl(body.url);
    const platform = platformOf(url);
    if (platform) return json({ recipe: { ...(await fromVideo(url, platform, categories)), source: url.href } });
    const html = await fetchPage(url);
    const data = findRecipeData(html);
    const setup = geminiSetup();
    let draft;
    if (setup) {
      const { title, text } = pageText(html);
      const source = data
        ? `Recipe data embedded in the page (schema.org):\n${JSON.stringify(data).slice(0, MAX_TEXT_CHARS)}`
        : `Page title: ${title}\n\nPage text:\n${text}`;
      try {
        draft = await withGemini(setup, source, categories);
      } catch (e) {
        // If Gemini is slow, out of free quota or unavailable, use the page's own recipe data.
        if (e instanceof ImportError && e.message === "no_recipe") throw e;
        if (!data) {
          if (e instanceof ImportError) { e.detail = `${e.detail}; the page has no embedded recipe data`; throw e; }
          throw new ImportError("read_failed", String(e?.message || e));
        }
        draft = mapDirect(data, categories);
      }
    } else {
      if (!data) throw new ImportError("needs_ai");
      draft = mapDirect(data, categories);
    }
    if (!draft.title || (!draft.ingredients.length && !draft.steps.length)) throw new ImportError("no_recipe");
    return json({ recipe: { ...draft, source: url.href } });
  } catch (e) {
    if (e instanceof ImportError) return json({ error: e.message, detail: e.detail }, 422);
    console.error(e);
    return json({ error: "read_failed", detail: String(e?.message || e).slice(0, 200) }, 500);
  }
};

export const config = { path: "/api/import" };
