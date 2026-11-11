// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The app glyph (scripts/glyph.svg, hfps-repo-assets look): a square in the palette's brand colour
 * with the monitor-and-live-circle mark in white. The paths are the glyph's own, in its 128 box.
 */
export function AppMark() {
  return (
    <span
      aria-hidden
      className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground"
    >
      <svg viewBox="16 16 96 96" className="size-5" fill="currentColor">
        <path
          d="M29.806 28.251L85.76 28.251C90.91 28.251 95.086 32.427 95.086 37.577L95.086 60.321C93.184 59.777 91.218 59.616 89.208 59.481C80.292 58.881 72.991 64.873 69.087 72.365C67.892 74.656 67.54 77.062 67.34 79.543L29.806 79.543C24.655 79.543 20.48 75.368 20.48 70.217L20.48 37.577C20.48 32.427 24.655 28.251 29.806 28.251Z"
          fillRule="evenodd"
          opacity="0.7"
        />
        <path
          d="M46.514 85.76L67.612 85.76C68.236 88.656 69.555 91.309 71.347 93.641C70.684 94.064 69.896 94.309 69.051 94.309L46.514 94.309C44.154 94.309 42.24 92.395 42.24 90.034C42.24 87.674 44.154 85.76 46.514 85.76Z"
          fillRule="evenodd"
          opacity="0.45"
        />
        <circle cx="88.869" cy="81.097" r="18.651" />
      </svg>
    </span>
  );
}
