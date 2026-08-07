/**
 * Inline SVG glyphs.
 *
 * Emoji were the obvious shortcut and the wrong one: 🎙 renders as a flat monochrome glyph on
 * macOS and a colour one on iOS, so the same button looked broken on one platform and fine on the
 * other. `currentColor` also lets these inherit the button's colour instead of fighting it.
 */

const base = {
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

export function MicIcon({ size = 20 }: { size?: number }): React.JSX.Element {
  return (
    <svg {...base} width={size} height={size}>
      <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
      <path d="M12 19v3" />
    </svg>
  );
}

export function SendIcon(): React.JSX.Element {
  return (
    <svg {...base}>
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </svg>
  );
}

export function StopIcon(): React.JSX.Element {
  return (
    <svg {...base} fill="currentColor" stroke="none">
      <rect x="7" y="7" width="10" height="10" rx="2.5" />
    </svg>
  );
}

export function CloseIcon(): React.JSX.Element {
  return (
    <svg {...base} width={18} height={18}>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}
