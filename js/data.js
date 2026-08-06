// Bundled size-chart data. These are approximations of published brand charts
// (body circumference in cm — chest/bust for tops, waist for bottoms, midpoint
// per size). Charts describe bodies, not garments — the engine converts to
// flat garment width via a per-type ease assumption, and the UI flags that as
// a confidence cost.

export const BRANDS = [
  {
    id: 'uniqlo', name: 'Uniqlo',
    charts: {
      men: {
        tops:    { XS: 78, S: 84, M: 92, L: 100, XL: 108, XXL: 116 },
        bottoms: { S: 76, M: 84, L: 92, XL: 100 },
      },
      women: {
        tops:    { XS: 77, S: 83, M: 89, L: 95, XL: 101, XXL: 107 },
        bottoms: { S: 64, M: 70, L: 76, XL: 82 },
      },
    },
  },
  {
    id: 'hm', name: 'H&M',
    charts: {
      men: {
        tops:    { XS: 82, S: 88, M: 96, L: 104, XL: 112, XXL: 120 },
        bottoms: { S: 78, M: 86, L: 94, XL: 102 },
      },
      women: {
        tops:    { XS: 80, S: 84, M: 88, L: 94, XL: 100, XXL: 107 },
        bottoms: { S: 66, M: 72, L: 78, XL: 86 },
      },
    },
  },
  {
    id: 'zara', name: 'Zara',
    charts: {
      men: {
        tops:    { S: 92, M: 98, L: 104, XL: 110, XXL: 116 },
        bottoms: { S: 78, M: 84, L: 90, XL: 96 },
      },
      women: {
        tops:    { XS: 82, S: 86, M: 90, L: 96, XL: 102 },
        bottoms: { XS: 62, S: 66, M: 70, L: 76, XL: 82 },
      },
    },
  },
  {
    id: 'nike', name: 'Nike',
    charts: {
      men: {
        tops:    { XS: 84, S: 92, M: 100, L: 108, XL: 118, XXL: 124 },
        bottoms: { S: 78, M: 86, L: 94, XL: 104 },
      },
      women: {
        tops:    { XS: 80, S: 87, M: 94, L: 100, XL: 109 },
        bottoms: { XS: 64, S: 69, M: 75, L: 82, XL: 90 },
      },
    },
  },
  {
    // Gildan publishes body-fit chest ranges in both inches and cm; the
    // midpoints of those ranges are used here.
    id: 'gildan', name: 'Gildan',
    charts: {
      men: {
        tops:    { S: 88.5, M: 99.5, L: 109.5, XL: 119.5, XXL: 129.5 },
        bottoms: { S: 78, M: 86, L: 94, XL: 102 },
      },
      women: {
        tops:    { S: 84, M: 89, L: 94, XL: 101 },
        bottoms: { S: 66, M: 72, L: 78, XL: 86 },
      },
    },
  },
  {
    id: 'levis', name: "Levi's",
    charts: {
      men: {
        tops:    { S: 89, M: 99, L: 109, XL: 119, XXL: 126 },
        bottoms: { W28: 71, W30: 76, W32: 81, W34: 86, W36: 91, W38: 97, W40: 102 },
      },
      women: {
        tops:    { XS: 81, S: 86, M: 92, L: 99, XL: 107 },
        bottoms: { W24: 61, W26: 66, W28: 71, W30: 76, W32: 81, W34: 86 },
      },
    },
  },
];

// Garment types. `family` decides which chart and which reference garment a
// comparison uses; `ease` is the cm added to body circumference to estimate
// garment circumference for a regular cut of that type.
export const CATEGORIES = {
  tshirt:  { label: 'T-shirt',            family: 'tops',    ease: 8 },
  shirt:   { label: 'Shirt',              family: 'tops',    ease: 10 },
  sweater: { label: 'Sweater / hoodie',   family: 'tops',    ease: 12 },
  jacket:  { label: 'Jacket / outerwear', family: 'tops',    ease: 14 },
  pants:   { label: 'Pants / jeans',      family: 'bottoms', ease: 2 },
  shorts:  { label: 'Shorts',             family: 'bottoms', ease: 3 },
};

// What each family measures, flat on a table.
export const FAMILIES = {
  tops: {
    label: 'Tops',
    main: 'Chest, pit to pit (cm)', mainShort: 'chest',
    secondary: 'Length, collar to hem (cm)', secondaryShort: 'length',
  },
  bottoms: {
    label: 'Bottoms',
    main: 'Waist, flat across (cm)', mainShort: 'waist',
    secondary: 'Inseam, crotch to hem (cm)', secondaryShort: 'inseam',
  },
};

// How this person likes clothes to sit. Two distinct jobs:
//
//   `ease`  — extra room added to a body measurement when deriving a starting
//             reference from a body scan. Only used when there is no real
//             garment to compare against.
//   tightExt / looseExt
//           — how much extra snugness or extra room this person accepts,
//             relative to their reference garment. These widen the tolerance
//             asymmetrically rather than sliding it: a garment matching the
//             reference exactly must always read as a fit, because that
//             reference *is* the garment they said fits them perfectly.
//             Applying preference to the measurement instead would count it
//             twice, since choosing that reference already expressed it.
//             Bottoms move half as much — a centimetre matters more at the
//             waist than at the chest.
export const FIT_PREFERENCES = {
  tight:   { label: 'Tight / close-fitting', ease: -4, tightExt: 2, looseExt: -2 },
  regular: { label: 'Regular',               ease: 0,  tightExt: 0, looseExt: 0 },
  baggy:   { label: 'Baggy / oversized',     ease: 6,  tightExt: 0, looseExt: 3 },
};

export const FAMILY_BAND_SCALE = { tops: 1, bottoms: 0.5 };

// Cut adjusts the per-type ease.
export const CUTS = {
  slim:    { label: 'Slim fit',            mod: -4 },
  regular: { label: 'Regular fit',         mod: 0 },
  relaxed: { label: 'Relaxed / oversized', mod: 6 },
};

// Flat-width cm implied by one step of the "how does it feel" scale.
export const FEEL_CM = 2.5;

export const FEELS = [
  { v: -2, label: 'Too tight' },
  { v: -1, label: 'Snug / runs small' },
  { v: 0,  label: 'Just right' },
  { v: 1,  label: 'Loose / runs large' },
  { v: 2,  label: 'Too loose' },
];

// Vintage sizing drift, applied to estimated flat width (cm). Older garments
// under the same label run smaller than their modern equivalents.
export const ERAS = {
  current: { label: 'Current / recent', shift: 0 },
  '2000s': { label: '2000s',            shift: -1.5 },
  '1990s': { label: '1990s',            shift: -3 },
  '1980s': { label: '1980s or earlier', shift: -4.5 },
};

export const DEPTS = { men: "Men's", women: "Women's" };

// How each brand's name can appear on a care label once punctuation and
// spacing are stripped. Matching against this short list is what makes tag
// reading work even when the OCR is poor — the vocabulary is tiny.
export const BRAND_ALIASES = {
  uniqlo: ['UNIQLO', 'UNI QLO'],
  hm: ['HM', 'H M', 'HENNESMAURITZ'],
  zara: ['ZARA'],
  nike: ['NIKE'],
  gildan: ['GILDAN'],
  levis: ['LEVIS', 'LEVI STRAUSS', 'LEVISTRAUSS'],
};

// Fibres that give a garment meaningful stretch. Care labels list these by
// percentage, which is the one genuinely fit-relevant number a tag carries.
export const STRETCH_FIBRES = ['ELASTANE', 'SPANDEX', 'LYCRA', 'ELASTHANE', 'ELASTODIENE'];

// Percentage of stretch fibre at which a garment starts behaving noticeably
// differently from a rigid one.
export const STRETCH_THRESHOLD = 3;
