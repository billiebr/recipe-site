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

// Netlify stops a function after about 10 seconds, so every step has its own deadline.
const FETCH_MS = 4000;
const AI_MS = 5500;
const MAX_PAGE_BYTES = 3_000_000;
const MAX_TEXT_CHARS = 30_000;

class ImportError extends Error {}

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

async function fetchPage(u) {
  let res;
  try {
    res = await fetch(u, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_MS),
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; FamilyRecipeBook/1.0)",
        "accept": "text/html,application/xhtml+xml",
        "accept-language": "he,en;q=0.8",
      },
    });
  } catch { throw new ImportError("fetch_failed"); }
  if (!res.ok) throw new ImportError("fetch_failed");
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
  ["רטבים וממרחים", /רוטב|ממרח|מטבל|sauce|dip|spread|dressing|pesto/i],
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
  },
  required: ["is_recipe", "title", "category", "author", "intro", "servings", "time", "ingredients", "steps", "notes"],
};

async function withGemini(apiKey, source, categories) {
  // flash-lite: fast enough for Netlify's 10-second limit, with the largest free daily quota.
  const model = Netlify.env.get("GEMINI_MODEL") || "gemini-flash-lite-latest";
  let res;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
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
        generationConfig: { responseMimeType: "application/json", responseSchema: DRAFT_SCHEMA, maxOutputTokens: 8000 },
      }),
    });
  } catch { throw new ImportError("read_failed"); }
  if (!res.ok) {
    console.error("gemini", res.status, (await res.text()).slice(0, 300));
    throw new ImportError(res.status === 429 ? "busy" : "read_failed");
  }
  const out = await res.json();
  const text = (out.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
  let draft;
  try { draft = JSON.parse(text); } catch { throw new ImportError("read_failed"); }
  if (!draft.is_recipe) throw new ImportError("no_recipe");
  const str = v => String(v ?? "").trim();
  const list = v => (Array.isArray(v) ? v : []).map(str).filter(Boolean);
  return {
    title: str(draft.title), category: str(draft.category) || "עיקריות", author: str(draft.author), intro: str(draft.intro),
    servings: str(draft.servings), time: str(draft.time), ingredients: list(draft.ingredients), steps: list(draft.steps), notes: str(draft.notes),
  };
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
    const html = await fetchPage(url);
    const data = findRecipeData(html);
    const apiKey = Netlify.env.get("GEMINI_API_KEY");
    let draft;
    if (apiKey) {
      const { title, text } = pageText(html);
      const source = data
        ? `Recipe data embedded in the page (schema.org):\n${JSON.stringify(data).slice(0, MAX_TEXT_CHARS)}`
        : `Page title: ${title}\n\nPage text:\n${text}`;
      try {
        draft = await withGemini(apiKey, source, categories);
      } catch (e) {
        // If Gemini is slow, out of free quota or unavailable, use the page's own recipe data.
        if (e instanceof ImportError && e.message === "no_recipe") throw e;
        if (!data) throw e;
        draft = mapDirect(data, categories);
      }
    } else {
      if (!data) throw new ImportError("needs_ai");
      draft = mapDirect(data, categories);
    }
    if (!draft.title || (!draft.ingredients.length && !draft.steps.length)) throw new ImportError("no_recipe");
    return json({ recipe: { ...draft, source: url.href } });
  } catch (e) {
    if (e instanceof ImportError) return json({ error: e.message }, 422);
    console.error(e);
    return json({ error: "read_failed" }, 500);
  }
};

export const config = { path: "/api/import" };
