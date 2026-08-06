// Inline SVG garment icons (24x24, stroke = currentColor) and larger
// measurement-guide diagrams shown wherever garments appear, so the UI reads
// visually rather than as a wall of text.

const wrap = (inner, cls = 'gicon') =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">${inner}</svg>`;

export const ICONS = {
  tshirt: wrap('<path d="M8 3 4 6l2 4 2-1v12h8V9l2 1 2-4-4-3c0 1.5-1.6 2.5-4 2.5S8 4.5 8 3Z"/>'),
  shirt: wrap('<path d="M8 3 4 6l2 4 2-1v12h8V9l2 1 2-4-4-3c0 1.5-1.6 2.5-4 2.5S8 4.5 8 3Z"/><path d="M12 6v15"/><path d="m10 3.8 2 2.2 2-2.2"/>'),
  sweater: wrap('<path d="M9 3h6l4 3-1.5 5L16 10v11H8V10l-1.5 1L5 6l4-3Z"/><path d="M8 18h8"/>'),
  jacket: wrap('<path d="M9 3 5 6l1 5 2-.5V21h8V10.5l2 .5 1-5-4-3-3 3-3-3Z"/><path d="M12 6v15"/>'),
  pants: wrap('<path d="M8 3h8l1 18h-5l-.9-11h-.2L10 21H5.9L8 3Z"/><path d="M8 6h8"/>'),
  shorts: wrap('<path d="M7 4h10l1.5 9H13l-.9-4.5h-.2L11 13H5.5L7 4Z"/><path d="M7 7h10"/>'),
  camera: wrap('<path d="M4 7h3l2-2h6l2 2h3v13H4V7Z"/><circle cx="12" cy="13" r="4"/>'),
};

// Where-to-measure diagrams, keyed by family.
export const DIAGRAMS = {
  tops: `
  <svg class="diagram" viewBox="0 0 220 150" fill="none" aria-hidden="true">
    <path d="M75 22 95 13c0 6 30 6 30 0l20 9 15 26-19 9v70H79V57l-19-9 15-26Z"
          stroke="currentColor" stroke-width="2" stroke-linejoin="round" opacity=".85"/>
    <g stroke="var(--blue)" stroke-width="2">
      <line x1="81" y1="70" x2="139" y2="70"/>
      <path d="m86 66-5 4 5 4M134 66l5 4-5 4" fill="none"/>
    </g>
    <text x="110" y="62" text-anchor="middle" fill="var(--blue)" font-size="11" font-weight="600">chest</text>
    <g stroke="var(--green)" stroke-width="2">
      <line x1="172" y1="22" x2="172" y2="137"/>
      <path d="m168 27 4-5 4 5M168 132l4 5 4-5" fill="none"/>
    </g>
    <text x="180" y="82" fill="var(--green)" font-size="11" font-weight="600">length</text>
  </svg>`,
  bottoms: `
  <svg class="diagram" viewBox="0 0 220 150" fill="none" aria-hidden="true">
    <path d="M75 15h60l9 120h-30l-9-75h-1l-8 75H65L75 15Z"
          stroke="currentColor" stroke-width="2" stroke-linejoin="round" opacity=".85"/>
    <g stroke="var(--blue)" stroke-width="2">
      <line x1="77" y1="26" x2="133" y2="26"/>
      <path d="m82 22-5 4 5 4M128 22l5 4-5 4" fill="none"/>
    </g>
    <text x="105" y="45" text-anchor="middle" fill="var(--blue)" font-size="11" font-weight="600">waist</text>
    <g stroke="var(--green)" stroke-width="2">
      <line x1="112" y1="62" x2="112" y2="132"/>
      <path d="m108 67 4-5 4 5M108 127l4 5 4-5" fill="none"/>
    </g>
    <text x="120" y="100" fill="var(--green)" font-size="11" font-weight="600">inseam</text>
  </svg>`,
};

export function categoryIcon(category) {
  return ICONS[category] || ICONS.tshirt;
}
