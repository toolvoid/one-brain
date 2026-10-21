'use strict';

const STOPWORDS = new Set(`a an and are as at be been but by can could did do does for from had has have he her him his how i if in into is it its me my of on or our she so than that the their them then there these they this those to was we were what when where which who why will with would you your about after again all also am any because before being both each few further here more most other some such through too very
kya ka ke ki ko mein me ma hai hain ho hua hu hain kaise kyun kyon aur se tha thi the phir par pe bhi ab kab kyun kya kyunki jo jise jiski jiska jisko jahan wahan yeh ye woh wo iska uska unka mera meri mere tum aap ham hum agar nahi nahin nahiin chahiye
`.trim().split(/\s+/));

function escapeFtsToken(token) { return `"${String(token).replaceAll('"', '""')}"`; }

function buildFtsQuery(input) {
  const text = String(input || '').normalize('NFKC').toLocaleLowerCase('en-US');
  const phrases = [...text.matchAll(/"([^"]{1,200})"/g)].map((match) => match[1].trim()).filter(Boolean);
  const tokens = [...new Set((text.match(/[\p{L}\p{N}]+/gu) || []).filter((token) => !STOPWORDS.has(token)))];
  const terms = tokens.map((token) => `${escapeFtsToken(token)}${[...token].length >= 4 ? '*' : ''}`);
  const phraseFallback = phrases.map((phrase) => escapeFtsToken(phrase));
  return { match: [...terms, ...(!terms.length ? phraseFallback : [])].join(' OR '), phrases, tokens };
}

module.exports = { STOPWORDS, buildFtsQuery, escapeFtsToken };
