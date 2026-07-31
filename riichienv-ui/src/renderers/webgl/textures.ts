import * as THREE from 'three';
import { TILES } from '../../tiles';
import type { TileSet } from './tileset.js';

/** Convert a numeric 0xRRGGBB colour to a CSS '#rrggbb' string. */
function hexColorToCss(n: number): string {
    return `#${n.toString(16).padStart(6, '0')}`;
}

/**
 * SVG → Canvas → CanvasTexture factory for 3D tile faces, backs and sides.
 *
 * All art paths, colour values and dimension ratios are sourced from the
 * bound {@link TileSet}, so nothing is hardcoded here. Tile face glyphs are
 * loaded at runtime from the tileset's `svgBasePath` (lietxia art, viewBox
 * `0 0 19 26`); each is wrapped in a 300×400 face SVG with a cream
 * background and composited into one opaque texture sized to the top face.
 * If the runtime fetch is unavailable (tests, bundled viewer), `loadGlyph`
 * falls back to the generated `TILES` map.
 */
export class TileTextureFactory {
    private readonly tileSet: TileSet;
    private faceCache = new Map<string, THREE.CanvasTexture>();
    private backCache = new Map<string, THREE.CanvasTexture>();
    private sideCache = new Map<string, THREE.CanvasTexture>();
    private sdfCache = new Map<string, THREE.DataTexture>();
    private readonly w: number;
    private readonly h: number;

    /** SDF source resolution (3:4 to match the face). */
    private static readonly SDF_W = 480;
    private static readonly SDF_H = 640;
    /** Half-range of the signed distance field, in source pixels. Strokes
     * thinner than this still render sharp; beyond it the field saturates. */
    private static readonly SDF_SPREAD = 60;

    // Canvas aspect must match the SVG viewBox (300×400 = 3:4). A square
    // canvas letterboxes the portrait glyph, leaving transparent margins that
    // sample as black on an opaque material — hence the previous "black border".
    constructor(tileSet: TileSet, width = 600, height = 800) {
        this.tileSet = tileSet;
        this.w = width;
        this.h = height;
    }

    async getFaceTexture(tileCode: string): Promise<THREE.CanvasTexture> {
        const cached = this.faceCache.get(tileCode);
        if (cached) return cached;

        const glyphSvg = await this.loadGlyph(tileCode);
        const svg = this.buildFaceSvg(glyphSvg);
        const texture = await this.svgToTexture(svg, { padded: true });
        // Keep THREE's defaults (generateMipmaps=true, LinearMipmapLinear)
        // for clean minification at distance.
        this.faceCache.set(tileCode, texture);
        return texture;
    }

    /**
     * Build a single-channel signed distance field texture for `tileCode`.
     *
     * The glyph is rasterised (transparent background, same padded-contain
     * layout as the colour face) and its alpha channel thresholded into a
     * binary mask. A signed distance field is then computed with the
     * separable Exact Distance Transform (Felzenszwalb & Huttenlocher 2012),
     * normalised so that 0.5 sits exactly on the glyph boundary (>0.5 inside
     * a stroke, <0.5 in the background). The field is uploaded as an R8
     * DataTexture with linear + mip filtering; the consumer's fragment shader
     * thresholds it on-screen, so the glyph stays crisp at any distance
     * without depending on a mipmapped colour map.
     */
    async getSDF(tileCode: string): Promise<THREE.DataTexture> {
        const cached = this.sdfCache.get(tileCode);
        if (cached) return cached;

        const W = TileTextureFactory.SDF_W;
        const H = TileTextureFactory.SDF_H;

        const svg = await this.buildGlyphSvg(tileCode);
        const mask = await this.rasterizeAlphaMask(svg, W, H);
        let insideCount = 0;
        for (let i = 0; i < mask.length; i++) insideCount += mask[i];
        if (insideCount === 0) {
            console.warn(
                `[TileTextureFactory] SDF mask empty for "${tileCode}" — SVG rasterised no foreground pixels; ` +
                    `colour still comes from colorMap so the face will not render fully black.`,
            );
        }
        const sdf = TileTextureFactory.computeSDF(mask, W, H, TileTextureFactory.SDF_SPREAD);

        const data = new Uint8Array(W * H);
        for (let i = 0; i < sdf.length; i++) data[i] = Math.round(sdf[i] * 255);
        const tex = new THREE.DataTexture(data, W, H, THREE.RedFormat, THREE.UnsignedByteType);
        tex.colorSpace = THREE.NoColorSpace;
        tex.flipY = true;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = true;
        tex.needsUpdate = true;

        this.sdfCache.set(tileCode, tex);
        return tex;
    }

    /** Glyph-only SVG (no background fill) at SDF resolution, centred with the
     * same 300×400 meet layout as the colour face so the stroke lands in the
     * same spot on the tile. */
    private async buildGlyphSvg(code: string): Promise<string> {
        const glyph = await this.loadGlyph(code);
        const W = TileTextureFactory.SDF_W;
        const H = TileTextureFactory.SDF_H;
        return (
            `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" ` +
            `viewBox="0 0 300 400" preserveAspectRatio="xMidYMid meet">` +
            glyph +
            `</svg>`
        );
    }

    /** Rasterise `svg` onto a W×H transparent canvas using the same
     * padded-contain math as `svgToTexture`, then read back the alpha
     * channel as a binary mask (alpha ≥ 128 ⇒ inside the glyph). */
    private rasterizeAlphaMask(svg: string, W: number, H: number): Promise<Uint8Array> {
        return new Promise<Uint8Array>((resolve, reject) => {
            const canvas = document.createElement('canvas');
            canvas.width = W;
            canvas.height = H;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                reject(new Error('TileTextureFactory: 2d context unavailable'));
                return;
            }
            ctx.clearRect(0, 0, W, H);

            const img = new Image();
            const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            img.onload = () => {
                const dims = this.paddedContain(W, H);
                ctx.drawImage(img, dims.drawX, dims.drawY, dims.drawW, dims.drawH);
                URL.revokeObjectURL(url);

                const { data } = ctx.getImageData(0, 0, W, H);
                const mask = new Uint8Array(W * H);
                for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3] >= 128 ? 1 : 0;
                resolve(mask);
            };
            img.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error('TileTextureFactory: failed to render SVG for SDF'));
            };
            img.src = url;
        });
    }

    /**
     * Signed distance field from a binary mask via two separable 1D EDTs.
     * Returns values in [0,1] with 0.5 on the boundary; >0.5 inside a stroke.
     *
     * Two unsigned distance fields are computed — distance to the nearest
     * outside pixel and distance to the nearest inside pixel — and their
     * difference forms the signed distance, which is then rescaled by `spread`
     * around the 0.5 midpoint.
     */
    private static computeSDF(mask: Uint8Array, W: number, H: number, spread: number): Float32Array {
        const n = W * H;
        const INF = 1e20;

        const fOut = new Float64Array(n);
        const fIn = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            const inside = mask[i] !== 0;
            fOut[i] = inside ? INF : 0;
            fIn[i] = inside ? 0 : INF;
        }
        const dOut = TileTextureFactory.edt2d(fOut, W, H);
        const dIn = TileTextureFactory.edt2d(fIn, W, H);

        const out = new Float32Array(n);
        const scale = 1 / (2 * spread);
        for (let i = 0; i < n; i++) {
            const sd = Math.sqrt(dOut[i]) - Math.sqrt(dIn[i]);
            let v = 0.5 + sd * scale;
            if (v < 0) v = 0;
            else if (v > 1) v = 1;
            out[i] = v;
        }
        return out;
    }

    /** Two-pass separable 2D squared-Euclidean distance transform of `f`
     * (distance to the nearest zero of `f`). */
    private static edt2d(f: Float64Array, W: number, H: number): Float64Array {
        const n = W * H;
        const col = new Float64Array(n);
        const out = new Float64Array(n);
        const maxDim = Math.max(W, H);
        const ff = new Float64Array(maxDim);
        const dd = new Float64Array(maxDim);
        const v = new Int32Array(maxDim);
        const z = new Float64Array(maxDim + 1);

        for (let x = 0; x < W; x++) {
            for (let y = 0; y < H; y++) ff[y] = f[y * W + x];
            TileTextureFactory.edt1d(ff, dd, v, z, H);
            for (let y = 0; y < H; y++) col[y * W + x] = dd[y];
        }
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) ff[x] = col[y * W + x];
            TileTextureFactory.edt1d(ff, dd, v, z, W);
            for (let x = 0; x < W; x++) out[y * W + x] = dd[x];
        }
        return out;
    }

    /** 1D squared distance transform of a sampled function (Felzenszwalb &
     * Huttenlocher lower-envelope-of-parabolas algorithm). `v`/`z` are
     * scratch arrays of length ≥ n (z ≥ n+1) reused across calls. */
    private static edt1d(f: Float64Array, d: Float64Array, v: Int32Array, z: Float64Array, n: number): void {
        const INF = 1e20;
        let k = 0;
        v[0] = 0;
        z[0] = -INF;
        z[1] = +INF;
        for (let q = 1; q < n; q++) {
            let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
            while (s <= z[k]) {
                k--;
                s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
            }
            k++;
            v[k] = q;
            z[k] = s;
            z[k + 1] = +INF;
        }
        k = 0;
        for (let q = 0; q < n; q++) {
            while (z[k + 1] < q) k++;
            d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
        }
    }

    /**
     * Vertical gradient for the tile's four side faces: cream lacquer above,
     * coloured lacquer for the bottom band. Drawn on a 64×256 canvas where
     * the full canvas height corresponds to the tile thickness, so the
     * coloured band occupies `sideBottomHeight / height` of the canvas —
     * wider than the RoundedBoxGeometry bevel region, which means the entire
     * bottom bevel samples the band colour and never leaks the top colour.
     *
     * UV orientation: RoundedBoxGeometry side faces have V=0 at -Y (tile
     * bottom) and V=1 at +Y (tile top). CanvasTexture defaults to flipY=true,
     * so the canvas bottom row maps to V=0 — i.e. drawing the band at the
     * canvas bottom puts it at the tile's lower edge. A 2px gradient softens
     * the boundary so the transition reads as a painted edge rather than a
     * hard line. Cached under the resolved colour so every tile shares one
     * canvas texture.
     *
     * All three appearance inputs are overridable and all three are part of the
     * cache key. They have to be: this factory is normally constructed once with a
     * *default* TileSet, so anything read straight off `this.tileSet.config` is
     * fixed at the default regardless of what a caller has configured — and with
     * only `bottomColor` in the key, a caller that did vary the top colour or band
     * height would silently get the first texture built. Between the two, the
     * side-colour controls in the debug GUI had no effect at all.
     */
    getSideTexture(
        bottomColor: string = this.tileSet.config.sideBottomColor,
        topColor: string = this.tileSet.config.sideTopColor,
        bottomHeight: number = this.tileSet.config.sideBottomHeight,
    ): THREE.CanvasTexture {
        const key = `__side_${bottomColor}_${topColor}_${bottomHeight}__`;
        const cached = this.sideCache.get(key);
        if (cached) return cached;

        const c = this.tileSet.config;
        const w = 64;
        const h = 256; // represents the full tile thickness
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('TileTextureFactory: 2d context unavailable');

        // Upper lacquer body.
        ctx.fillStyle = topColor;
        ctx.fillRect(0, 0, w, h);

        // Coloured lacquer bottom band.
        const bandH = h * (bottomHeight / c.height);
        ctx.fillStyle = bottomColor;
        ctx.fillRect(0, h - bandH, w, bandH);

        // 2px soft transition for a natural painted boundary.
        const grad = ctx.createLinearGradient(0, h - bandH - 2, 0, h - bandH);
        grad.addColorStop(0, topColor);
        grad.addColorStop(1, bottomColor);
        ctx.fillStyle = grad;
        ctx.fillRect(0, h - bandH - 2, w, 2);

        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        this.sideCache.set(key, texture);
        return texture;
    }

    /**
     * Render `TILES.back` contained (0.8mm inset, aspect-preserved) on a
     * coloured base — the same contain mode used for the front glyphs. The
     * base pre-fill matters because the back design's own background rect has
     * ry="40" rounded corners, leaving the viewBox corners transparent; the
     * fill makes those corners (sampled by the 3D tile's bevel) render with
     * the frame colour instead of black, and also forms a 0.8mm frame around
     * the contained design. Cached under the resolved colour so it is
     * rendered once per colour.
     *
     * `bgColor` defaults to the tileset's `backColor`; passing an explicit
     * value (used by debug recolour GUIs) is cached independently.
     */
    async getBackTexture(bgColor: string = hexColorToCss(this.tileSet.config.backColor)): Promise<THREE.CanvasTexture> {
        const key = `__back_${bgColor}__`;
        const cached = this.backCache.get(key);
        if (cached) return cached;

        const w = this.w;
        const h = this.h;
        const svg =
            `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" ` +
            `viewBox="0 0 300 400" preserveAspectRatio="xMidYMid meet">` +
            (TILES.back ?? '') +
            `</svg>`;
        const texture = await this.svgToTexture(svg, { background: bgColor, padded: true });
        this.backCache.set(key, texture);
        return texture;
    }

    private buildFaceSvg(glyphSvg: string): string {
        return `<svg viewBox="0 0 300 400" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">
  ${glyphSvg}
</svg>`;
    }

    /**
     * Resolve a tile glyph to an SVG fragment string. Tries the runtime-fetched
     * lietxia SVG first (from the tileset's `svgBasePath`, DEBUG dev-server
     * path); on any failure falls back to the inlined `TILES` map so callers
     * in tests / the bundled viewer still get a usable face. The lietxia files
     * carry an `<?xml?>` declaration that is illegal inside a nested
     * fragment, so it is stripped; their `<svg viewBox="0 0 19 26">` root is
     * kept and scaled by the outer face SVG via `preserveAspectRatio="meet"`.
     */
    private async loadGlyph(code: string): Promise<string> {
        const c = this.tileSet.config;
        const file = c.codeToFile[code];
        if (file) {
            try {
                const res = await fetch(`${c.svgBasePath}${file}.svg`);
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
     * Compute the padded-contain draw rect for a W×H canvas whose full extent
     * represents the tile's width×depth face: the art is inset by 0.8mm on
     * every side (relative to the tileset's width/depth), aspect-preserved
     * and centred. Returns canvas-space pixel coordinates for drawImage.
     */
    private paddedContain(
        W: number,
        H: number,
    ): {
        drawW: number;
        drawH: number;
        drawX: number;
        drawY: number;
    } {
        const c = this.tileSet.config;
        const padX = W * (0.8 / c.width);
        const padZ = H * (0.8 / c.depth);
        const innerW = W - 2 * padX;
        const innerH = H - 2 * padZ;
        const imgAspect = W / H;
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
        return { drawW, drawH, drawX, drawY };
    }

    /**
     * Render `svg` to a canvas texture.
     *
     * When `opts.background` is set, the canvas is pre-filled with it before the
     * SVG is drawn. This matters for the back face: RoundedBoxGeometry maps the
     * tile's rounded bevel/corners onto the outer ~8% of each face's UV space,
     * so the texture edges and corners are sampled — a transparent canvas there
     * (alpha 0, RGB 0) renders as black on an opaque material (the "black
     * corners" bug). The fill colour matches the face's base material colour so
     * any region the SVG leaves uncovered (e.g. the ry="40" rounded corners of
     * the back design) blends in seamlessly.
     *
     * When `opts.background` is omitted the canvas stays transparent — used for
     * the front faces so the texture acts as an emissiveMap: glyph pixels carry
     * colour (emissive) while transparent regions sample RGB 0 (no emissive,
     * letting the material's base colour + lighting show through).
     *
     * When `opts.padded` is true (tile faces) the SVG is *contained* — scaled
     * to fit, aspect-preserved, centred — inside a 0.8mm inset on every side so
     * the glyph sits inside the bevel without being squashed. When false the
     * SVG is drawn edge-to-edge.
     */
    private async svgToTexture(
        svg: string,
        opts: { background?: string; padded: boolean },
    ): Promise<THREE.CanvasTexture> {
        const w = this.w;
        const h = this.h;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('TileTextureFactory: 2d context unavailable');

        if (opts.background) {
            ctx.fillStyle = opts.background;
            ctx.fillRect(0, 0, w, h);
        }

        await new Promise<void>((resolve, reject) => {
            const img = new Image();
            const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            img.onload = () => {
                if (opts.padded) {
                    const dims = this.paddedContain(w, h);
                    ctx.drawImage(img, dims.drawX, dims.drawY, dims.drawW, dims.drawH);
                } else {
                    ctx.drawImage(img, 0, 0, w, h);
                }
                URL.revokeObjectURL(url);
                resolve();
            };
            img.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error(`TileTextureFactory: failed to render SVG for tile`));
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
        for (const tex of this.faceCache.values()) tex.dispose();
        for (const tex of this.backCache.values()) tex.dispose();
        for (const tex of this.sideCache.values()) tex.dispose();
        for (const tex of this.sdfCache.values()) tex.dispose();
        this.faceCache.clear();
        this.backCache.clear();
        this.sideCache.clear();
        this.sdfCache.clear();
    }
}
