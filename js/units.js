// Unit handling. Everything is stored canonically in centimetres; units are
// purely a display/entry concern so switching them never mutates saved data.

export const UNITS = {
  cm: { label: 'Centimetres', short: 'cm', perCm: 1, step: 0.5, decimals: 1 },
  in: { label: 'Inches',      short: 'in', perCm: 1 / 2.54, step: 0.25, decimals: 2 },
};

// Entry can be flat (half the garment, laid flat) or full circumference.
// Flat is canonical — circumference is halved on the way in.
export const ENTRY_MODES = {
  flat: { label: 'Flat (laid out)', factor: 1 },
  circ: { label: 'All the way around', factor: 0.5 },
};

// Countries that measure clothing in inches. Guessing from the browser's
// locale removes a setup question for almost everyone, and it stays editable.
const IMPERIAL_LOCALES = ['US', 'GB', 'LR', 'MM'];

export function defaultUnit() {
  try {
    const region = new Intl.Locale(navigator.language).region
      || navigator.language.split('-')[1];
    return IMPERIAL_LOCALES.includes((region || '').toUpperCase()) ? 'in' : 'cm';
  } catch (e) {
    return 'cm';
  }
}

export function toDisplay(cm, unit) {
  if (cm == null) return null;
  const u = UNITS[unit];
  return Math.round(cm * u.perCm * 100) / 100;
}

export function toCm(value, unit) {
  const u = UNITS[unit];
  return value / u.perCm;
}

// "53 cm" / "20.87 in" — trailing zeros trimmed.
export function fmt(cm, unit, opts = {}) {
  if (cm == null) return '—';
  const u = UNITS[unit];
  const n = cm * u.perCm;
  const s = n.toFixed(opts.decimals ?? u.decimals).replace(/\.?0+$/, '');
  return opts.bare ? s : `${s} ${u.short}`;
}

// Signed delta, e.g. "+1.5 cm" / "−0.6 in".
export function fmtSigned(cm, unit) {
  const u = UNITS[unit];
  const n = cm * u.perCm;
  return (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(u.decimals).replace(/\.?0+$/, '') + ` ${u.short}`;
}

// Input bounds per family and entry mode, in cm, converted to the active unit.
const BOUNDS_CM = {
  tops:    { flat: [20, 120], circ: [40, 240] },
  bottoms: { flat: [15, 100], circ: [30, 200] },
};

export function bounds(family, mode, unit) {
  const [lo, hi] = BOUNDS_CM[family][mode];
  const u = UNITS[unit];
  return {
    min: Math.floor(lo * u.perCm),
    max: Math.ceil(hi * u.perCm),
    step: u.step,
  };
}

// Secondary dimension (length / inseam) is always a straight measurement.
const SECONDARY_CM = { tops: [30, 130], bottoms: [20, 130] };

export function secondaryBounds(family, unit) {
  const [lo, hi] = SECONDARY_CM[family];
  const u = UNITS[unit];
  return { min: Math.floor(lo * u.perCm), max: Math.ceil(hi * u.perCm), step: u.step };
}
