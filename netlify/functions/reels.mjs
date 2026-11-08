// Reel ideas: links to reels (Instagram, TikTok, YouTube...) saved for later, with a note,
// an optional linked recipe and whether the reel was already made. Family password required.
// GET    /api/reels            -> { reels }
// POST   /api/reels            { id?, url, note, recipeId, done } -> { reel }
// DELETE /api/reels?id=<id>
import { getStore } from "@netlify/blobs";
import { randomUUID } from "node:crypto";
import { json, checkPassword } from "../lib/auth.mjs";

const ID = /^[\w-]{1,80}$/;

function cleanUrl(raw) {
  try {
    const u = new URL(String(raw || "").trim());
    return /^https?:$/.test(u.protocol) ? u.href.slice(0, 2000) : "";
  } catch { return ""; }
}

export default async (req) => {
  const denied = checkPassword(req);
  if (denied) return denied;
  const store = getStore({ name: "reels", consistency: "strong" });

  if (req.method === "GET") {
    const { blobs } = await store.list();
    const reels = (await Promise.all(blobs.map(async b => {
      const r = await store.get(b.key, { type: "json" });
      return r && { id: b.key, ...r };
    }))).filter(Boolean);
    return json({ reels });
  }

  if (req.method === "POST") {
    let body;
    try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
    const url = cleanUrl(body?.url);
    if (!url) return json({ error: "bad_url" }, 400);
    const id = ID.test(body.id || "") ? body.id : randomUUID();
    const prev = (await store.get(id, { type: "json" })) || {};
    const reel = {
      url,
      note: String(body.note ?? "").trim().slice(0, 2000),
      recipeId: ID.test(body.recipeId || "") ? body.recipeId : "",
      done: body.done === true,
      createdAt: Number(prev.createdAt) || Date.now(),
      updatedAt: Date.now(),
    };
    await store.setJSON(id, reel);
    return json({ reel: { id, ...reel } });
  }

  if (req.method === "DELETE") {
    const id = new URL(req.url).searchParams.get("id") || "";
    if (!ID.test(id)) return json({ error: "bad_id" }, 400);
    await store.delete(id);
    return json({ ok: true });
  }

  return json({ error: "method_not_allowed" }, 405);
};

export const config = { path: "/api/reels" };
