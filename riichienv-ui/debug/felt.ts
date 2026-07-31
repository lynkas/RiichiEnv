import * as THREE from 'three';

/**
 * Procedural detail map for the table cloth.
 *
 * The cloth is the single largest thing on screen — measured at ~55% of the
 * frame — and until now it was a flat `MeshStandardMaterial({ color })` with no
 * map at all: 234k sampled pixels at a luma standard deviation of 5.6, i.e. one
 * uniform colour field. A surface that size carrying zero authored variation is
 * the most direct reason the image reads as "rendered" rather than "painted".
 *
 * This is deliberately a *detail* map, not an albedo map: values sit around
 * white and only modulate, so `material.color` still supplies the hue and the
 * live cloth-colour control keeps working.
 *
 * Two noise scales, for different reasons:
 *
 *  - **Low-frequency mottling** is the one that matters. It survives mipmapping,
 *    so the cloth still has structure at the far side of the table.
 *  - **Fine weave** is high-frequency and will mip away with distance. That is
 *    fine — it only has to hold up near the camera.
 *
 * Both are seeded, not `Math.random()`. The existing felt texture in
 * table_body.ts used per-pixel `Math.random()`, which gives a different cloth on
 * every rebuild and is pure white noise that vanishes entirely into the first
 * mip level — visually equivalent to not being there.
 */

export interface FeltTextureOptions {
    /** Canvas resolution. */
    size?: number;
    /**
     * Peak amplitude of the mottling, as a fraction. Default 0.02 — very low.
     *
     * Value noise produces smooth lumps at every octave, and on a 1:1 map over a
     * 900mm table even its finest usable octaves land at 15-30 screen pixels. That
     * is not cloth, it is staining: irregular dark patches, worst on the dimmed
     * outer cloth where sRGB expands the differences.
     *
     * A 1:1 detail map fundamentally cannot carry fabric texture at this camera
     * distance — fibre-scale features would be 1-3 pixels, i.e. per-texel noise
     * that mipmaps away. Fabric character comes from the tiled nap normal map plus
     * sheen instead; this map is left to do nothing but the radial falloff.
     */
    mottle?: number;
    /** Peak amplitude of the fine weave, as a fraction. */
    weave?: number;
    /** How much darker the cloth gets toward the table edge, as a fraction. */
    vignette?: number;
    /** PRNG seed — same seed gives the same cloth across rebuilds. */
    seed?: number;
}

/** Small deterministic PRNG (mulberry32). */
function makeRng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Wrapping value noise: same as `valueNoise` but the lattice wraps, so the result
 * tiles seamlessly. Needed for the nap normal map, which is repeated many times
 * across the cloth and would show visible seams otherwise.
 */
function tilingNoise(grid: number, rng: () => number): (u: number, v: number) => number {
    const lattice = new Float32Array(grid * grid);
    for (let i = 0; i < lattice.length; i++) lattice[i] = rng();
    const at = (x: number, y: number): number =>
        lattice[(((y % grid) + grid) % grid) * grid + (((x % grid) + grid) % grid)];
    const smooth = (t: number): number => t * t * (3 - 2 * t);
    return (u: number, v: number): number => {
        const x = u * grid;
        const y = v * grid;
        const x0 = Math.floor(x);
        const y0 = Math.floor(y);
        const fx = smooth(x - x0);
        const fy = smooth(y - y0);
        const a = at(x0, y0);
        const b = at(x0 + 1, y0);
        const c = at(x0, y0 + 1);
        const d = at(x0 + 1, y0 + 1);
        return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
    };
}

/**
 * Tiling normal map for the cloth's nap.
 *
 * This is what actually makes the surface read as fabric. The detail map above
 * only varies albedo, which is paint — a painted surface and a woven one differ in
 * how they *respond to light*, not in how they are coloured. Perturbing the normal
 * at fibre scale gives every point of the cloth its own tiny N.L, so the nap
 * catches and loses the key light the way real baize does.
 *
 * Repeated many times across the table (see `feltNapRepeat`), so it is built from
 * wrapping noise and inherently periodic sines only.
 *
 * The noise is sampled anisotropically: real baize is brushed, so its fibres have a
 * direction, and stretching the lattice along one axis is what reads as nap rather
 * than as generic bumpiness.
 */
export function makeFeltNapNormalTexture(opts: { size?: number; seed?: number; strength?: number } = {}): THREE.CanvasTexture {
    const size = opts.size ?? 512;
    const strength = opts.strength ?? 1;
    const rng = makeRng(opts.seed ?? 0x51ed2701);

    // Anisotropic fibre noise plus a periodic weave, all wrapping.
    const fine = tilingNoise(64, rng);
    const mid = tilingNoise(24, rng);
    const height = (u: number, v: number): number =>
        fine(u * 1.0, v * 2.6) * 0.55 +
        mid(u * 1.0, v * 1.5) * 0.3 +
        (Math.sin(u * Math.PI * 2 * 48) * Math.sin(v * Math.PI * 2 * 48)) * 0.06;

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('felt: 2d context unavailable');
    const img = ctx.createImageData(size, size);
    const data = img.data;
    const e = 1 / size;

    for (let y = 0; y < size; y++) {
        const v = y / size;
        for (let x = 0; x < size; x++) {
            const u = x / size;
            // Central differences -> tangent-space normal.
            const dx = (height(u + e, v) - height(u - e, v)) * size * 0.02 * strength;
            const dy = (height(u, v + e) - height(u, v - e)) * size * 0.02 * strength;
            const len = Math.hypot(-dx, -dy, 1);
            const i = (y * size + x) * 4;
            data[i] = Math.round((-dx / len * 0.5 + 0.5) * 255);
            data[i + 1] = Math.round((-dy / len * 0.5 + 0.5) * 255);
            data[i + 2] = Math.round((1 / len * 0.5 + 0.5) * 255);
            data[i + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);

    const texture = new THREE.CanvasTexture(canvas);
    // A normal map is vector data, never colour — decoding it as sRGB bends the
    // vectors and the lighting comes out subtly wrong.
    texture.colorSpace = THREE.NoColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    // Anisotropy matters more here than on any other texture in the scene, and
    // leaving it at the default of 1 is what made the nap read as irregular dark
    // patches rather than as fabric.
    //
    // This map is tiled ~22x across the table and viewed at a steep angle, so it is
    // minified hard and anisotropically. Trilinear filtering alone then averages
    // wildly different normals into each pixel, and because shading is non-linear in
    // the normal the result is not a smooth blur but blotchy noise that survives
    // into the mip chain. Measured on a clean patch of cloth, the nap took
    // block-scale variation from 0.28 to 0.47 before this.
    //
    // The caller sets the actual value from renderer.capabilities.
    texture.anisotropy = 16;
    return texture;
}

/**
 * Value noise: a coarse random lattice, smoothly interpolated. Cheap, tileable
 * enough for this, and — unlike white noise — it has structure at a scale large
 * enough to survive minification.
 */
function valueNoise(grid: number, rng: () => number): (u: number, v: number) => number {
    const g = grid + 1;
    const lattice = new Float32Array(g * g);
    for (let i = 0; i < lattice.length; i++) lattice[i] = rng();
    const smooth = (t: number): number => t * t * (3 - 2 * t);
    return (u: number, v: number): number => {
        const x = u * grid;
        const y = v * grid;
        const x0 = Math.min(Math.floor(x), grid - 1);
        const y0 = Math.min(Math.floor(y), grid - 1);
        const fx = smooth(x - x0);
        const fy = smooth(y - y0);
        const a = lattice[y0 * g + x0];
        const b = lattice[y0 * g + x0 + 1];
        const c = lattice[(y0 + 1) * g + x0];
        const d = lattice[(y0 + 1) * g + x0 + 1];
        return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
    };
}

/**
 * Build the cloth detail map. UVs are the plain 0..1 of a PlaneGeometry, so this
 * maps one-to-one over the table surface (no repeat/offset juggling).
 */
export function makeFeltDetailTexture(opts: FeltTextureOptions = {}): THREE.CanvasTexture {
    const size = opts.size ?? 1024;
    const mottleAmp = opts.mottle ?? 0.02;
    const weaveAmp = opts.weave ?? 0.022;
    const vignetteAmp = opts.vignette ?? 0.22;
    const rng = makeRng(opts.seed ?? 0x9e3779b9);

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('felt: 2d context unavailable');

    // Only the two finest octaves survive, at a trace amplitude, purely so the
    // cloth is not mathematically uniform. Every coarser octave was a blob
    // generator — see the `mottle` note above.
    const n4 = valueNoise(72, rng);
    const n5 = valueNoise(150, rng);

    const img = ctx.createImageData(size, size);
    const data = img.data;

    for (let y = 0; y < size; y++) {
        const v = y / (size - 1);
        for (let x = 0; x < size; x++) {
            const u = x / (size - 1);

            // Radial falloff, computed first: it also gates the mottling below.
            const dx = u - 0.5;
            const dy = v - 0.5;
            const r = Math.min(1, Math.sqrt(dx * dx + dy * dy) * 2);
            const t = Math.max(0, Math.min(1, (r - 0.35) / 0.65));
            const falloff = 1 - vignetteAmp * (t * t * (3 - 2 * t));

            // Mottling, centred on 0 so it modulates rather than darkens.
            const m = (n4(u, v) - 0.5) * 0.4 + (n5(u, v) - 0.5) * 0.6;
            // Scaled by the falloff, not just added to it.
            //
            // sRGB expands differences in the darks, so a *constant* relative
            // mottling is far more visible on the dimmed outer cloth than in the
            // lit centre — it reads as staining exactly where the cloth is
            // darkest. Measured on the darker felt (luma < 70), large-scale
            // variation ran 4.91 at 90px against 3.29 over the cloth as a whole.
            // Fading the noise along with the light keeps the shadowed edges clean.
            let mul = 1 + m * 2 * mottleAmp * (falloff * falloff);

            // Woven cloth: two crossed stripe sets, slightly offset in phase so
            // they read as a weave rather than as a grid.
            const weave =
                Math.sin(x * Math.PI * 0.5) * Math.sin(y * Math.PI * 0.5 + 0.7) * weaveAmp;
            mul += weave;

            // Radial falloff — gives the cloth some volume and pulls the eye in.
            mul *= falloff;

            const c = Math.max(0, Math.min(255, Math.round(mul * 255)));
            const i = (y * size + x) * 4;
            data[i] = c;
            data[i + 1] = c;
            data[i + 2] = c;
            data[i + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    return texture;
}
