import { timingSafeEqual } from "node:crypto";

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

// Returns an error Response when the request lacks the family password, or null when it is fine.
export function checkPassword(req) {
  const expected = Netlify.env.get("FAMILY_PASSWORD") || "";
  if (!expected) return json({ error: "no_password_configured" }, 500);
  const given = Buffer.from(req.headers.get("x-family-password") || "");
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return json({ error: "wrong_password" }, 401);
  return null;
}
