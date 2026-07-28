import * as THREE from 'three';
import { TILES } from '../../tiles';

/**
 * SVG → Canvas → CanvasTexture cache for 3D tile faces.
 *
 * Tile face SVGs come from the generated `TILES` map (viewBox 0 0 300 400).
 * `TILES.front` is the cream tile-face background; `TILES[code]` is the ink
 * glyph. We composite both into a single opaque texture sized to the top face.
 */
export class TextureCache {
    private cache = new Map<string, THREE.CanvasTexture>();
    private readonly w: number;
    private readonly h: number;

    // Canvas aspect must match the SVG viewBox (300×400 = 3:4). A square
    // canvas letterboxes the portrait glyph, leaving transparent margins that
    // sample as black on an opaque material — hence the previous "black border".
    constructor(width = 150, height = 200) {
        this.w = width;
        this.h = height;
    }

    async get(tileCode: string): Promise<THREE.CanvasTexture> {
        const cached = this.cache.get(tileCode);
        if (cached) return cached;

        const svg = this.buildFaceSvg(tileCode);
        const texture = await this.svgToTexture(svg, { background: '#f5f0e0', padded: true });
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
        ctx.fillStyle = '#e4dec8';
        ctx.fillRect(0, 0, w, h);

        // Coloured lacquer bottom band: 3mm of 16.5mm ≈ 18.2% of canvas height.
        const goldH = h * (3 / 16.5); // ≈ 46.5px
        ctx.fillStyle = bottomColor;
        ctx.fillRect(0, h - goldH, w, goldH);

        // 2px soft transition for a natural painted boundary.
        const grad = ctx.createLinearGradient(0, h - goldH - 2, 0, h - goldH);
        grad.addColorStop(0, '#e4dec8');
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
     * Render `TILES.back` contained (2mm inset, aspect-preserved) on a gold
     * base — the same contain mode used for the front glyphs. The gold pre-fill
     * matters because the back design's own background rect has ry="40"
     * rounded corners, leaving the viewBox corners transparent; the fill makes
     * those corners (sampled by the 3D tile's bevel) render gold instead of
     * black, and now also forms a 2mm gold frame around the contained design.
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

    private buildFaceSvg(code: string): string {
        const front = TILES.front ?? '';
        const glyph = TILES[code] ?? TILES.blank ?? '';
        const w = this.w;
        const h = this.h;
        return (
            `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" ` +
            `viewBox="0 0 300 400" preserveAspectRatio="xMidYMid meet">` +
            `<rect width="300" height="400" fill="#f5f0e0"/>` +
            front +
            glyph +
            `</svg>`
        );
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
     * to fit, aspect-preserved, centred — inside a 2mm inset on every side so
     * the glyph sits inside the bevel without being squashed. The 2mm-padded
     * inner box is NOT 3:4 (shaving 2mm off a 21×28 face leaves 17×24 = 0.708,
     * vs 0.75 for the 3:4 SVG), so a naive edge-to-edge draw would stretch the
     * glyph; we letterbox on the binding axis and centre on the other instead.
     * When false the SVG is drawn edge-to-edge (used for the full-bleed back).
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
                    // Contain the w×h (3:4) SVG inside the 2mm-padded box,
                    // preserving aspect ratio.
                    const padX = w * (2 / 21);
                    const padZ = h * (2 / 28);
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
        texture.anisotropy = 4;
        texture.needsUpdate = true;
        return texture;
    }

    dispose(): void {
        for (const tex of this.cache.values()) tex.dispose();
        this.cache.clear();
    }
}
