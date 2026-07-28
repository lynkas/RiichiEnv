import * as THREE from 'three';
import { TILES } from '../../tiles';

/**
 * Per-tile SVG art lives under this directory as individual `.svg` files
 * (sourced from github.com/lietxia/mahjong_graphic, viewBox `0 0 19 26`,
 * transparent background, glyph-only). They are fetched at runtime by the
 * dev server (esbuild `--servedir=.` serves the whole project root, so the
 * absolute path resolves at `/src/...`). DEBUG-ONLY: there is no server
 * serving these files inside the bundled sanma-shell viewer, so `loadGlyph`
 * falls back to the inlined `TILES` map whenever the fetch fails.
 */
const TILE_SVG_BASE = '/src/renderers/webgl/tile-svgs/';

/**
 * tileCode (used throughout the engine) → lietxia SVG filename stem.
 * Honors use E/S/W/N/P/F/C in this codebase but 1z–7z in the SVG set.
 */
const TILE_SVG_MAP: Record<string, string> = {
    '1m': '1m',
    '2m': '2m',
    '3m': '3m',
    '4m': '4m',
    '5m': '5m',
    '6m': '6m',
    '7m': '7m',
    '8m': '8m',
    '9m': '9m',
    '0m': '0m',
    '1p': '1p',
    '2p': '2p',
    '3p': '3p',
    '4p': '4p',
    '5p': '5p',
    '6p': '6p',
    '7p': '7p',
    '8p': '8p',
    '9p': '9p',
    '0p': '0p',
    '1s': '1s',
    '2s': '2s',
    '3s': '3s',
    '4s': '4s',
    '5s': '5s',
    '6s': '6s',
    '7s': '7s',
    '8s': '8s',
    '9s': '9s',
    '0s': '0s',
    E: '1z',
    S: '2z',
    W: '3z',
    N: '4z',
    P: '5z',
    F: '6z',
    C: '7z',
    // red-five aliases (engine uses 5mr/5pr/5sr; SVG set uses 0m/0p/0s)
    '5mr': '0m',
    '5pr': '0p',
    '5sr': '0s',
};

/**
 * SVG → Canvas → CanvasTexture cache for 3D tile faces.
 *
 * Tile face glyphs are loaded at runtime from `tile-svgs/` (lietxia art,
 * viewBox `0 0 19 26`); each is wrapped in a 300×400 face SVG with a cream
 * `#ebe5d5` background and composited into one opaque texture sized to the
 * top face. If the runtime fetch is unavailable (tests, bundled viewer),
 * `loadGlyph` falls back to the generated `TILES` map.
 */
export class TextureCache {
    private cache = new Map<string, THREE.CanvasTexture>();
    private readonly w: number;
    private readonly h: number;

    // Canvas aspect must match the SVG viewBox (300×400 = 3:4). A square
    // canvas letterboxes the portrait glyph, leaving transparent margins that
    // sample as black on an opaque material — hence the previous "black border".
    constructor(width = 600, height = 800) {
        this.w = width;
        this.h = height;
    }

    async get(tileCode: string): Promise<THREE.CanvasTexture> {
        const cached = this.cache.get(tileCode);
        if (cached) return cached;

        const svg = await this.buildFaceSvg(tileCode);
        const texture = await this.svgToTexture(svg, { background: '#ebe5d5', padded: true });
        this.cache.set(tileCode, texture);
        return texture;
    }

    /**
     * Vertical gradient for the tile's four side faces: cream lacquer above,
     * gold lacquer for the bottom 3 mm. Drawn on a 64×256 canvas where the
     * full canvas height corresponds to the 16.5mm tile thickness, so the
     * gold band occupies 3/16.5 ≈ 18.2% of the canvas — wider than the
     * RoundedBoxGeometry bevel region (arcUvRatio ≈ 10% for radius=2), which
     * means the entire bottom bevel samples gold and never leaks cream.
     *
     * UV orientation: RoundedBoxGeometry side faces have V=0 at -Y (tile
     * bottom) and V=1 at +Y (tile top). CanvasTexture defaults to flipY=true,
     * so the canvas bottom row maps to V=0 — i.e. drawing gold at the canvas
     * bottom puts gold at the tile's lower 3 mm. A 2px gradient softens the
     * cream↔gold boundary so the transition reads as a painted edge rather
     * than a hard line. Cached under '__side__' so every tile shares one
     * canvas texture.
     */
    getSide(bottomColor: string = '#c8a030'): THREE.CanvasTexture {
        const key = `__side_${bottomColor}__`;
        const cached = this.cache.get(key);
        if (cached) return cached;

        const w = 64;
        const h = 256; // 16.5mm tile thickness
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('TextureCache: 2d context unavailable');

        // Cream lacquer body.
        ctx.fillStyle = '#ddd5c0';
        ctx.fillRect(0, 0, w, h);

        // Coloured lacquer bottom band: 3mm of 16.5mm ≈ 18.2% of canvas height.
        const goldH = h * (3 / 16.5); // ≈ 46.5px
        ctx.fillStyle = bottomColor;
        ctx.fillRect(0, h - goldH, w, goldH);

        // 2px soft transition for a natural painted boundary.
        const grad = ctx.createLinearGradient(0, h - goldH - 2, 0, h - goldH);
        grad.addColorStop(0, '#ddd5c0');
        grad.addColorStop(1, bottomColor);
        ctx.fillStyle = grad;
        ctx.fillRect(0, h - goldH - 2, w, 2);

        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        this.cache.set(key, texture);
        return texture;
    }

    /**
     * Render `TILES.back` contained (0.8mm inset, aspect-preserved) on a gold
     * base — the same contain mode used for the front glyphs. The gold pre-fill
     * matters because the back design's own background rect has ry="40"
     * rounded corners, leaving the viewBox corners transparent; the fill makes
     * those corners (sampled by the 3D tile's bevel) render gold instead of
     * black, and now also forms a 0.8mm gold frame around the contained design.
     * Cached under a private key so it is rendered once.
     */
    async getBack(bgColor: string = '#c8a030'): Promise<THREE.CanvasTexture> {
        const key = `__back_${bgColor}__`;
        const cached = this.cache.get(key);
        if (cached) return cached;

        const w = this.w;
        const h = this.h;
        const svg =
            `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" ` +
            `viewBox="0 0 300 400" preserveAspectRatio="xMidYMid meet">` +
            (TILES.back ?? '') +
            `</svg>`;
        const texture = await this.svgToTexture(svg, { background: bgColor, padded: true });
        this.cache.set(key, texture);
        return texture;
    }

    private async buildFaceSvg(code: string): Promise<string> {
        const glyph = await this.loadGlyph(code);
        const w = this.w;
        const h = this.h;
        return (
            `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" ` +
            `viewBox="0 0 300 400" preserveAspectRatio="xMidYMid meet">` +
            `<rect width="300" height="400" fill="#ebe5d5"/>` +
            glyph +
            `</svg>`
        );
    }

    /**
     * Resolve a tile glyph to an SVG fragment string. Tries the runtime-fetched
     * lietxia SVG first (DEBUG dev-server path); on any failure falls back to
     * the inlined `TILES` map so callers in tests / the bundled viewer still
     * get a usable face. The lietxia files carry an `<?xml?>` declaration that
     * is illegal inside a nested fragment, so it is stripped; their `<svg
     * viewBox="0 0 19 26">` root is kept and scaled by the outer face SVG via
     * `preserveAspectRatio="meet"`.
     */
    private async loadGlyph(code: string): Promise<string> {
        const file = TILE_SVG_MAP[code];
        if (file) {
            try {
                const res = await fetch(`${TILE_SVG_BASE}${file}.svg`);
                if (res.ok) {
                    const stripped = (await res.text()).replace(/<\?xml.*?\?>/gs, '').trim();
                    // Guard against dev-server SPA fallback: a missing .svg is
                    // answered with 200 + index.html body, which nests as
                    // invalid SVG and aborts the whole render. Require an actual
                    // <svg> root; otherwise fall through to the TILES fallback.
                    if (stripped.startsWith('<svg')) {
                        return stripped;
                    }
                }
            } catch {
                /* fall back to TILES below */
            }
        }
        return TILES[code] ?? TILES.blank ?? '';
    }

    /**
     * Render `svg` to a canvas texture.
     *
     * The canvas is ALWAYS pre-filled with `opts.background` first. This is
     * mandatory: RoundedBoxGeometry maps the tile's rounded bevel/corners onto
     * the outer ~8% of each face's UV space, so the texture edges and corners
     * are sampled — a transparent canvas there (alpha 0, RGB 0) renders as
     * black on an opaque material (the "black corners" bug). The fill colour
     * matches the face's base material colour so any region the SVG leaves
     * uncovered (e.g. the ry="40" rounded corners of the back design) blends
     * in seamlessly.
     *
     * When `opts.padded` is true (tile faces) the SVG is *contained* — scaled
     * to fit, aspect-preserved, centred — inside a 0.8mm inset on every side so
     * the glyph sits inside the bevel without being squashed. The 0.8mm-padded
     * inner box is NOT 3:4 (shaving 0.8mm off a 21×28 face leaves 19.4×26.4 =
     * 0.734, vs 0.75 for the 3:4 SVG), so a naive edge-to-edge draw would
     * stretch the glyph; we letterbox on the binding axis and centre on the
     * other instead. When false the SVG is drawn edge-to-edge (used for the
     * full-bleed back).
     */
    private async svgToTexture(
        svg: string,
        opts: { background: string; padded: boolean },
    ): Promise<THREE.CanvasTexture> {
        const w = this.w;
        const h = this.h;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('TextureCache: 2d context unavailable');

        ctx.fillStyle = opts.background;
        ctx.fillRect(0, 0, w, h);

        await new Promise<void>((resolve, reject) => {
            const img = new Image();
            const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            img.onload = () => {
                if (opts.padded) {
                    // Contain the w×h (3:4) SVG inside a 0.8mm-padded box,
                    // preserving aspect ratio.
                    const padX = w * (0.8 / 21);
                    const padZ = h * (0.8 / 28);
                    const innerW = w - 2 * padX;
                    const innerH = h - 2 * padZ;
                    const imgAspect = w / h;
                    const innerAspect = innerW / innerH;
                    let drawW: number, drawH: number, drawX: number, drawY: number;
                    if (imgAspect > innerAspect) {
                        // Width-binding: letterbox vertically.
                        drawW = innerW;
                        drawH = innerW / imgAspect;
                        drawX = padX;
                        drawY = padZ + (innerH - drawH) / 2;
                    } else {
                        // Height-binding: letterbox horizontally.
                        drawH = innerH;
                        drawW = innerH * imgAspect;
                        drawX = padX + (innerW - drawW) / 2;
                        drawY = padZ;
                    }
                    ctx.drawImage(img, drawX, drawY, drawW, drawH);
                } else {
                    ctx.drawImage(img, 0, 0, w, h);
                }
                URL.revokeObjectURL(url);
                resolve();
            };
            img.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error(`TextureCache: failed to render SVG for tile`));
            };
            img.src = url;
        });

        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.needsUpdate = true;
        return texture;
    }

    dispose(): void {
        for (const tex of this.cache.values()) tex.dispose();
        this.cache.clear();
    }
}
