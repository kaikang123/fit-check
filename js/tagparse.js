// Care-label parsing.
//
// The trick that makes this work with unreliable OCR: we are not reading free
// text. We are looking for one of a handful of known brands, one of about
// fifteen known size tokens, and percentages followed by fibre names. A noisy
// read like "UNIOLO / M / 60% C0TT0N" still resolves, because the search space
// is tiny and the candidates are far apart.
//
// Note what a tag does NOT carry: garment dimensions. No manufacturer prints
// pit-to-pit on a label. The tag establishes identity; dimensions come from
// the catalog or from measuring the garment.

import { BRAND_ALIASES, BRANDS, STRETCH_FIBRES, STRETCH_THRESHOLD } from './data.js';

// A looser pass that keeps the characters prices are made of. The strict
// normalize() below destroys them, which is right for fibres and sizes and
// useless for money.
export function normalizeLoose(text) {
  return String(text || '')
    .toUpperCase()
    .replace(/['’´`]/g, '')
    .replace(/[^A-Z0-9%.,£$€¥₩]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const CURRENCY = { '£': 'GBP', $: 'USD', '€': 'EUR', '¥': 'JPY', '₩': 'KRW' };
const CURRENCY_CODES = ['GBP', 'USD', 'EUR', 'JPY', 'KRW', 'CAD', 'AUD', 'SEK', 'NOK', 'DKK', 'PLN', 'CHF'];

// Prices on a hangtag look like £29.99, $45, 199,00 EUR, USD 30.
// Returned tokens are also used to blank out the price before hunting for a
// size, so "$32.00" can never be mistaken for a waist 32.
export function findPrices(text) {
  const loose = normalizeLoose(text);
  const out = [];
  const push = (amountRaw, currency, raw) => {
    const amount = Number(amountRaw.replace(',', '.'));
    if (Number.isFinite(amount) && amount > 0) out.push({ amount, currency, raw });
  };

  const symbolFirst = /([£$€¥₩])\s?(\d{1,5}(?:[.,]\d{1,2})?)/g;
  const symbolLast = /(\d{1,5}(?:[.,]\d{1,2})?)\s?([£$€¥₩])/g;
  const codeFirst = new RegExp(`\\b(${CURRENCY_CODES.join('|')})\\s?(\\d{1,5}(?:[.,]\\d{1,2})?)`, 'g');
  const codeLast = new RegExp(`\\b(\\d{1,5}(?:[.,]\\d{1,2})?)\\s?(${CURRENCY_CODES.join('|')})\\b`, 'g');

  let m;
  while ((m = symbolFirst.exec(loose))) push(m[2], CURRENCY[m[1]], m[0]);
  while ((m = symbolLast.exec(loose))) push(m[1], CURRENCY[m[2]], m[0]);
  while ((m = codeFirst.exec(loose))) push(m[2], m[1], m[0]);
  while ((m = codeLast.exec(loose))) push(m[1], m[2], m[0]);

  // A bare two-decimal number on a tag is money often enough to be worth
  // catching — and far more likely money than a garment size.
  if (!out.length) {
    const bare = /\b(\d{1,4}[.,]\d{2})\b/g;
    while ((m = bare.exec(loose))) push(m[1], null, m[0]);
  }
  return out;
}

// Uppercase, and collapse anything that isn't a letter or digit to a single
// space, so punctuation and OCR speckle stop mattering.
export function normalize(text) {
  return String(text || '')
    .toUpperCase()
    // Keep possessives welded together, or "WOMEN'S" leaves a stray "S" that
    // reads as a size. Same reason "LEVI'S" must become LEVIS, not LEVI S.
    .replace(/['’´`]/g, '')
    .replace(/[^A-Z0-9%]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Common OCR confusions, applied only when matching brands — never to the
// percentages, where a digit swap would silently change the meaning.
function deconfuse(s) {
  return s.replace(/0/g, 'O').replace(/1/g, 'I').replace(/5/g, 'S').replace(/8/g, 'B');
}

export function findBrand(text) {
  const flat = deconfuse(normalize(text)).replace(/ /g, '');
  for (const [brandId, aliases] of Object.entries(BRAND_ALIASES)) {
    for (const alias of aliases) {
      if (flat.includes(deconfuse(alias).replace(/ /g, ''))) {
        return { brandId, name: BRANDS.find(b => b.id === brandId)?.name || brandId, alias };
      }
    }
  }
  return null;
}

// Size tokens, longest first so XXL is never consumed as XL and XL never as L.
const SIZE_TOKENS = ['3XL', 'XXXL', '2XL', 'XXL', 'XL', 'XS', 'S', 'M', 'L'];
const SIZE_CANONICAL = { XXXL: '3XL', '2XL': 'XXL' };

// `brand` is optional but strongly recommended: a brand name can contribute
// letters that look exactly like sizes — "H&M" leaves a standalone M — so the
// matched brand is removed from the text before scanning for a size.
export function findSize(text, brand) {
  // Blank out money first. A hangtag is covered in numbers, and reading
  // "$32.00" as a waist 32 would be a confidently wrong answer.
  let source = String(text || '');
  for (const price of findPrices(source)) {
    source = source.split(price.raw).join(' ');
    // The raw match came from the loose normalisation, so also strip the
    // digits on their own in case spacing differed in the original.
    source = source.replace(new RegExp(`\\b${String(price.amount).replace('.', '[.,]')}\\b`, 'g'), ' ');
  }

  let norm = normalize(source);

  if (brand && BRAND_ALIASES[brand.brandId]) {
    for (const alias of BRAND_ALIASES[brand.brandId]) {
      const pattern = normalize(alias).split(' ').join('\\s*');
      norm = norm.replace(new RegExp(`\\b${pattern}\\b`, 'g'), ' ');
    }
    norm = norm.replace(/\s+/g, ' ').trim();
  }

  // Waist sizings appear as W32 or W 32.
  const waist = norm.match(/\bW\s?(2[4-9]|3[0-9]|4[0-6])\b/);
  if (waist) return { size: `W${waist[1]}`, kind: 'waist' };

  // An explicit "SIZE X" marker beats anything found by scanning loose text.
  const marked = norm.match(/\b(?:SIZE|TAILLE|TALLA|GROSSE|GR)\s+(3XL|XXXL|2XL|XXL|XL|XS|S|M|L)\b/);
  if (marked) {
    const token = marked[1];
    return { size: SIZE_CANONICAL[token] || token, kind: 'letter' };
  }

  for (const token of SIZE_TOKENS) {
    // Must stand alone: "M" inside "MEDIUM" or "COTTON" must not count.
    if (new RegExp(`(^| )${token}( |$)`).test(norm)) {
      return { size: SIZE_CANONICAL[token] || token, kind: 'letter' };
    }
  }

  // Spelled-out sizes are common on labels.
  const words = [
    [/\bEXTRA SMALL\b/, 'XS'], [/\bSMALL\b/, 'S'], [/\bMEDIUM\b/, 'M'],
    [/\bLARGE\b/, 'L'], [/\bEXTRA LARGE\b/, 'XL'],
  ];
  for (const [re, size] of words) {
    if (re.test(norm)) return { size, kind: 'word' };
  }

  // Bare numbers, which is how hangtags usually print bottoms sizing. Only
  // the waist range is claimed, because that's the only numeric sizing the
  // bundled charts can actually resolve.
  const markedNumber = norm.match(/\b(?:SIZE|TAILLE|TALLA|W|WAIST)\s?(\d{2})\b/);
  const bareNumber = markedNumber || norm.match(/\b(\d{2})\b/);
  if (bareNumber) {
    const n = Number(bareNumber[1]);
    if (n >= 24 && n <= 46) return { size: `W${n}`, kind: 'waist', fromBareNumber: !markedNumber };
    return { size: String(n), kind: 'numeric', unmapped: true };
  }
  return null;
}

// Cut wording on a hangtag maps onto the cut options the engine already has.
// Longer phrases are listed first so "SLIM FIT" beats a stray "FIT".
const CUT_WORDS = [
  [/\b(SKINNY|SUPER SLIM|SLIM|TAPERED|FITTED|ATHLETIC)\b/, 'slim'],
  [/\b(RELAXED|OVERSIZED|LOOSE|BAGGY|WIDE|BOXY)\b/, 'relaxed'],
  [/\b(REGULAR|CLASSIC|STRAIGHT|STANDARD)\b/, 'regular'],
];

export function findCut(text) {
  const norm = normalize(text);
  for (const [re, cut] of CUT_WORDS) {
    if (re.test(norm)) return cut;
  }
  return null;
}

// Product names name the garment. Order matters: SWEATSHIRT and T SHIRT must
// be tested before SHIRT, and SHORTS before SHORT.
const TYPE_WORDS = [
  [/\b(SWEATSHIRT|SWEAT SHIRT|HOODIE|HOODED|SWEATER|JUMPER|PULLOVER|CREWNECK|CREW NECK|KNIT|FLEECE)\b/, 'sweater'],
  [/\b(T SHIRT|TSHIRT|TEE|T)\b(?! ?SHIRT)/, 'tshirt'],
  [/\b(JACKET|COAT|PARKA|BLAZER|OVERSHIRT|ANORAK|GILET)\b/, 'jacket'],
  [/\b(SHORTS)\b/, 'shorts'],
  [/\b(JEANS|DENIM|CHINO|CHINOS|TROUSER|TROUSERS|PANT|PANTS|SLACKS)\b/, 'pants'],
  [/\b(SHIRT|OXFORD|POLO|BLOUSE)\b/, 'shirt'],
];

export function findGarmentType(text) {
  const norm = normalize(text);
  for (const [re, type] of TYPE_WORDS) {
    if (re.test(norm)) return type;
  }
  return null;
}

export function findDept(text) {
  const norm = normalize(text);
  if (/\bWOMEN|WOMENS|LADIES|FEMME|DAMEN\b/.test(norm)) return 'women';
  if (/\bMEN|MENS|HOMME|HERREN\b/.test(norm)) return 'men';
  return null;
}

// The fibres a label might actually name.
const KNOWN_FIBRES = [
  'COTTON', 'POLYESTER', 'ELASTANE', 'SPANDEX', 'LYCRA', 'WOOL', 'LINEN', 'SILK',
  'NYLON', 'POLYAMIDE', 'VISCOSE', 'RAYON', 'MODAL', 'ACRYLIC', 'CASHMERE',
  'TENCEL', 'LYOCELL', 'BAMBOO', 'HEMP', 'LEATHER', 'ELASTODIENE',
];

// Words that sit between the percentage and the fibre it belongs to —
// "100% PRESHRUNK COTTON", "60% COMBED RINGSPUN COTTON".
const FIBRE_QUALIFIERS = [
  'PRESHRUNK', 'PRE', 'SHRUNK', 'ORGANIC', 'RECYCLED', 'COMBED', 'RINGSPUN',
  'RING', 'SPUN', 'BRUSHED', 'PURE', 'VIRGIN', 'MERCERIZED', 'MERCERISED',
  'SUPIMA', 'PIMA', 'FINE', 'SOFT', 'BCI',
];

// OCR reads 0 as O and 1 as I often enough that a percentage can be lost
// entirely. Only applied to the digits immediately preceding a %, where the
// intent is unambiguous — never to letters elsewhere.
function digitsFrom(token) {
  return Number(token.replace(/[OQ]/g, '0').replace(/[IL]/g, '1'));
}

// "60% COTTON 40% POLYESTER" -> [{ pct: 60, fibre: 'COTTON' }, ...]
export function findFibres(text) {
  const norm = normalize(text);
  const out = [];
  // Capture the percentage, then up to four following words so a qualifier
  // sitting in front of the real fibre can be stepped over.
  // The trailing words must stop before the next "NN%", or that percentage
  // gets consumed here and the fibre after it is lost entirely.
  const re = /([0-9OQIL]{1,3})\s*%\s*((?:(?![0-9OQIL]{1,3}\s*%)[A-Z0-9]+ ?){0,4})/g;
  let m;
  while ((m = re.exec(norm))) {
    const pct = digitsFrom(m[1]);
    if (!(pct > 0 && pct <= 100)) continue;
    const words = (m[2] || '').trim().split(' ')
      .filter(Boolean)
      // Bare numbers here belong to the next percentage, not this fibre.
      .filter(w => /[A-Z]/.test(w))
      // Fibre names are pure letters, so digits inside one are OCR damage
      // and can be safely undone — "C0TT0N" is unambiguously cotton.
      .map(w => (/\d/.test(w) ? deconfuse(w) : w));
    const named = words.find(w => KNOWN_FIBRES.includes(w));
    const fallback = words.find(w => !FIBRE_QUALIFIERS.includes(w));
    const fibre = named || fallback;
    if (fibre) out.push({ pct, fibre });
  }
  return out;
}

// Does this fabric have real give? Reported, never silently folded into the
// maths — we have no data on how much extra room stretch is worth, and
// inventing a number would produce confident guesses.
export function stretchOf(fibres) {
  const pct = fibres
    .filter(f => STRETCH_FIBRES.some(s => f.fibre.startsWith(s.slice(0, 6))))
    .reduce((sum, f) => sum + f.pct, 0);
  return { pct, stretchy: pct >= STRETCH_THRESHOLD };
}

// Everything a care label can actually tell us, in one pass.
export function parseTag(text) {
  const fibres = findFibres(text);
  const brand = findBrand(text);
  const prices = findPrices(text);
  return {
    raw: text,
    brand,
    // Brand is resolved first so its letters can be excluded from size hunting.
    size: findSize(text, brand),
    dept: findDept(text),
    fibres,
    stretch: stretchOf(fibres),
    // Hangtag extras. A care label carries none of these; a price tag usually
    // carries all of them.
    price: prices[0] || null,
    cut: findCut(text),
    garmentType: findGarmentType(text),
  };
}

// A short, honest description of what was recognised.
export function describe(parsed) {
  const bits = [];
  bits.push(parsed.brand ? parsed.brand.name : 'brand not recognised');
  bits.push(parsed.size ? `size ${parsed.size.size}` : 'size not found');
  if (parsed.fibres.length) {
    bits.push(parsed.fibres.map(f => `${f.pct}% ${f.fibre.toLowerCase()}`).join(', '));
  }
  return bits.join(' · ');
}
