// Errors are prompts.
//
// The client of this database is a model, or a UI a model just wrote. A stack trace is useless to
// it. Every rejection therefore carries a stable `code`, a plain-language `message` and a `repair`
// hint: enough for the caller to fix its request and try again without a human in the loop.

export class GenDBError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'GenDBError';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { ok: false, error: { code: this.code, message: this.message, ...this.details } };
  }
}

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

/** Closest candidates to a misspelled name, nearest first. Empty when nothing is plausibly meant. */
export function didYouMean(input, candidates, max = 3) {
  const needle = String(input).toLowerCase();
  return [...candidates]
    .map((c) => ({ c, d: distance(needle, String(c).toLowerCase()) }))
    .filter(({ c, d }) => d <= Math.max(2, Math.floor(String(c).length / 3)))
    .sort((x, y) => x.d - y.d)
    .slice(0, max)
    .map(({ c }) => c);
}
