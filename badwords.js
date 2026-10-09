'use strict';
// Chat bad-word filter. Used by the server before a message is stored or delivered.
// Matches whole words only (so "class" or "Scunthorpe" are fine) and catches common tricks:
// upper/lower case, accents, leetspeak (f@ck, sh1t), stretched letters (fuuuck) and
// separators between letters (f.u.c.k, f u c k).
// To change what is blocked, edit BLOCKED below. Keep entries lowercase, letters only.

const BLOCKED = [
  'fuck', 'fack', 'shit', 'bitch', 'asshole', 'bastard', 'dick', 'cunt', 'slut', 'whore', 'piss',
  'nigger', 'nigga', 'faggot', 'fag', 'retard', 'tranny', 'kys'
];
const SUFFIX = '(?:s|es|ed|er|ers|ing|in|y)?';
const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's', '!': 'i', '|': 'i', '+': 't' };

const squash = (w) => w.replace(/(.)\1+/g, '$1');
const RULES = BLOCKED.map((w) => ({
  exact: new RegExp(`^${w}${SUFFIX}$`),
  // fully de-duplicated comparison only for longer words, so "ass"-like short words don't over-match
  squashed: w.length >= 4 ? new RegExp(`^${squash(w)}${SUFFIX}$`) : null
}));

function tokens(text) {
  const mapped = String(text).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[0134578@$!|+]/g, (c) => LEET[c]);
  const raw = mapped.split(/[^a-z]+/).filter(Boolean);
  // "f u c k" / "f.u.c.k": join runs of single letters into one token
  const out = [];
  let run = '';
  for (const t of raw) {
    if (t.length === 1) { run += t; continue; }
    if (run) { out.push(run); run = ''; }
    out.push(t);
  }
  if (run) out.push(run);
  return out;
}

// Returns true when the text contains a blocked word.
function hasBadWord(text) {
  for (const t of tokens(text)) {
    const two = t.replace(/(.)\1{2,}/g, '$1$1'); // fuuuck -> fuuck
    const one = squash(t);                       // fuuck -> fuck
    if (RULES.some((r) => r.exact.test(t) || r.exact.test(two) || (r.squashed && r.squashed.test(one)))) return true;
  }
  return false;
}

module.exports = { hasBadWord };
