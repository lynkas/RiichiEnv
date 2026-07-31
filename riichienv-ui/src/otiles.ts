/**
 * Stand-in for the real project's generated `TILES` map.
 *
 * `TileTextureFactory` only reaches for this map as a fallback: face glyphs are
 * fetched at runtime from `svgBasePath` (tile-svgs/), so the entries that matter
 * here are `back` (there is no file-backed source for it) and `blank`.
 *
 * Both fragments are authored in the 300x400 space that
 * `getBackTexture` / `buildFaceSvg` wrap them in.
 */
export const TILES: Record<string, string> = {
    // Gold frame + dark inner panel + a simple centred motif. The outer rect
    // keeps ry="40" so the rounded corners match what textures.ts documents.
    back: `
        <rect x="0" y="0" width="300" height="400" rx="40" ry="40" fill="#c8a030"/>
        <rect x="22" y="22" width="256" height="356" rx="26" ry="26" fill="#a8842a"/>
        <rect x="38" y="38" width="224" height="324" rx="18" ry="18"
              fill="none" stroke="#e0c464" stroke-width="4"/>
        <g fill="#e0c464">
          <circle cx="150" cy="200" r="52" fill="none" stroke="#e0c464" stroke-width="7"/>
          <circle cx="150" cy="200" r="20"/>
          <path d="M150 108 l16 28 h-32 z"/>
          <path d="M150 292 l16 -28 h-32 z"/>
          <path d="M58 200 l28 16 v-32 z"/>
          <path d="M242 200 l-28 16 v-32 z"/>
        </g>
    `,
    blank: '',
};
