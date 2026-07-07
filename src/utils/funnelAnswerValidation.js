/** Fast local check — keyboard mash, repeated chars, consonant-heavy strings. */
const KEYBOARD_SEQUENCES = [
  "qwerty",
  "wertyu",
  "asdf",
  "sdfg",
  "dfgh",
  "fghj",
  "ghjk",
  "hjkl",
  "zxcv",
  "xcvb",
  "cvbn",
  "vbnm",
];

const isObviouslyGibberish = (text = "") => {
  const t = String(text || "").trim();
  if (!t) return true;

  if (t.length === 1 && !/^[a-z0-9]$/i.test(t)) return true;

  const compact = t.replace(/\s/g, "").toLowerCase();
  if (compact.length >= 4 && /^(.)\1{3,}$/.test(compact)) return true;

  if (compact.length >= 4) {
    for (const seq of KEYBOARD_SEQUENCES) {
      if (compact.includes(seq)) return true;
    }
  }

  const lettersOnly = t.replace(/[^a-zA-Z]/g, "");
  if (lettersOnly.length >= 5 && !/[aeiouAEIOU]/.test(lettersOnly)) return true;

  if (lettersOnly.length >= 6) {
    const vowels = (lettersOnly.match(/[aeiouAEIOU]/g) || []).length;
    if (vowels / lettersOnly.length <= 0.15) return true;
  }

  const words = t.split(/\s+/).filter(Boolean);
  if (
    words.length >= 1 &&
    words.every((w) => {
      const wLetters = w.replace(/[^a-zA-Z]/g, "");
      if (wLetters.length < 4) return false;
      if (!/[aeiouAEIOU]/.test(wLetters)) return true;
      const vowelCount = (wLetters.match(/[aeiouAEIOU]/g) || []).length;
      return vowelCount / wLetters.length <= 0.15;
    })
  ) {
    return true;
  }

  return false;
};

module.exports = { isObviouslyGibberish };
