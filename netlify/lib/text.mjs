// Photo scans and some sites return Hebrew in "presentation forms" (e.g. בּ as one character,
// U+FB31) or with niqqud marks. The site's fonts do not draw those, so phones fall back to
// another font mid-word. Turn them into plain letters and drop the marks.
export const plainHebrew = s => String(s ?? "")
  .replace(/[\uFB1D-\uFB4F]/g, c => c.normalize("NFKC"))
  .replace(/[\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7]/g, "")
  .replace(/[\u200C\u200D\uFEFF]/g, "");
