import { getStore } from "@netlify/blobs";

export const PHOTO_ID = /^[0-9a-f-]{36}$/;

// Removes a recipe photo (both sizes) that no recipe points to any more.
export async function deletePhoto(id) {
  if (!PHOTO_ID.test(String(id || ""))) return;
  const store = getStore({ name: "photos", consistency: "strong" });
  await Promise.all([store.delete(`${id}/full`), store.delete(`${id}/thumb`)]);
}
