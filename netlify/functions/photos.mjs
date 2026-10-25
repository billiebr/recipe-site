// Recipe photos, stored in Netlify Blobs.
// POST /api/photo  (family password, body: { full, thumb } as base64 JPEG) -> { photo: id }
// GET  /api/photo/<id>         the large photo
// GET  /api/photo/<id>?s=thumb the small one for cards
// Viewing needs no password: an <img> cannot send one, and ids are long random strings
// that only appear inside the password-protected recipe list.
import { getStore } from "@netlify/blobs";
import { randomUUID } from "node:crypto";
import { json, checkPassword } from "../lib/auth.mjs";
import { PHOTO_ID as ID } from "../lib/photos.mjs";

const MAX_BYTES = 3_000_000;

function jpeg(b64) {
  const buf = Buffer.from(String(b64 || ""), "base64");
  // JPEG files start with FF D8 FF.
  if (buf.length < 100 || buf.length > MAX_BYTES || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return null;
  return buf;
}

export default async (req) => {
  const store = getStore({ name: "photos", consistency: "strong" });
  const url = new URL(req.url);
  const id = url.pathname.split("/").pop();

  if (req.method === "GET") {
    if (!ID.test(id)) return new Response("not found", { status: 404 });
    const data = await store.get(`${id}/${url.searchParams.get("s") === "thumb" ? "thumb" : "full"}`, { type: "arrayBuffer" });
    if (!data) return new Response("not found", { status: 404 });
    return new Response(data, { headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=31536000, immutable" } });
  }

  const denied = checkPassword(req);
  if (denied) return denied;

  if (req.method === "POST") {
    let body;
    try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
    const full = jpeg(body?.full), thumb = jpeg(body?.thumb);
    if (!full || !thumb) return json({ error: "bad_photo" }, 400);
    const photo = randomUUID();
    await store.set(`${photo}/full`, full);
    await store.set(`${photo}/thumb`, thumb);
    return json({ photo });
  }

  return json({ error: "method_not_allowed" }, 405);
};

export const config = { path: ["/api/photo", "/api/photo/*"] };
