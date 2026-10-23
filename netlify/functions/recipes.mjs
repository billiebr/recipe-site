// The recipe book's API. Every request must carry the family password
// (set FAMILY_PASSWORD in the Netlify site's environment variables).
// Recipes live in Netlify Blobs, one entry per recipe.
import { getStore } from "@netlify/blobs";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { json, checkPassword } from "../lib/auth.mjs";

const FIELDS = ["title", "category", "time", "servings", "author", "source", "intro", "notes"];
function clean(input, prev = {}) {
  const r = {};
  for (const f of FIELDS) r[f] = String(input[f] ?? "").slice(0, 5000).trim();
  for (const f of ["ingredients", "steps"]) r[f] = (Array.isArray(input[f]) ? input[f] : []).map(s => String(s).slice(0, 2000).trim()).filter(Boolean).slice(0, 200);
  if (typeof input.vegan === "boolean") r.vegan = input.vegan;
  r.createdAt = Number(prev.createdAt || input.createdAt) || Date.now();
  r.updatedAt = Date.now();
  return r;
}

// data/seed.json holds recipes added or edited through Claude (via git).
// Each entry carries a "rev" (default 1). The store remembers which rev of each
// id it has applied, so a recipe is copied in once, again only when Claude bumps
// its rev, and never comes back after it was deleted on the site.
// An entry with "deleted": true removes that recipe.
async function syncFromRepo(store) {
  const seed = JSON.parse(await readFile(new URL("../../data/seed.json", import.meta.url), "utf8"));
  const applied = (await store.get("_meta/applied", { type: "json" })) || {};
  let changed = false;
  for (const { id, rev = 1, deleted, ...r } of seed) {
    if (!/^[\w-]{1,80}$/.test(id || "") || (applied[id] || 0) >= rev) continue;
    if (deleted) await store.delete("r/" + id);
    else await store.setJSON("r/" + id, clean(r));
    applied[id] = rev; changed = true;
  }
  if (changed) await store.setJSON("_meta/applied", applied);
}

export default async (req) => {
  const denied = checkPassword(req);
  if (denied) return denied;

  const store = getStore({ name: "recipes", consistency: "strong" });
  const url = new URL(req.url);

  if (req.method === "GET") {
    await syncFromRepo(store);
    const { blobs } = await store.list({ prefix: "r/" });
    const recipes = (await Promise.all(blobs.map(async b => {
      const r = await store.get(b.key, { type: "json" });
      return r && { id: b.key.slice(2), ...r };
    }))).filter(Boolean);
    return json({ recipes });
  }

  if (req.method === "POST") {
    let body;
    try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
    if (!body || !String(body.title || "").trim()) return json({ error: "missing_title" }, 400);
    const id = /^[\w-]{1,80}$/.test(body.id || "") ? body.id : randomUUID();
    const prev = (await store.get("r/" + id, { type: "json" })) || {};
    const recipe = clean(body, prev);
    await store.setJSON("r/" + id, recipe);
    return json({ recipe: { id, ...recipe } });
  }

  if (req.method === "DELETE") {
    const id = url.searchParams.get("id") || "";
    if (!/^[\w-]{1,80}$/.test(id)) return json({ error: "bad_id" }, 400);
    await store.delete("r/" + id);
    return json({ ok: true });
  }

  return json({ error: "method_not_allowed" }, 405);
};

export const config = { path: "/api/recipes" };
