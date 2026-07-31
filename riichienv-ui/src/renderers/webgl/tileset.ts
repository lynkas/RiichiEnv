/**
 * TileSet — immutable per-tile-type specification.
 *
 * One TileSet instance describes the "spec" of a kind of tile: its physical
 * dimensions, face/back/side colours, glyph shaders and SVG art sources.
 * Neither {@link Tile3D} nor {@link TileTextureFactory} hardcode any of these
 * values — they all read them from a TileSet, so a different tileset (e.g. a
 * smaller debug tile, a recoloured theme, a rule variant) is just a different
 * TileSet instance.
 *
 * The default config reproduces the previously-hardcoded values (the
 * 26×19×34mm table tile, cream face + gold back, lietxia SVG art), so passing
 * `new TileSet()` is fully backward compatible.
 */

export interface TileSetConfig {
    // --- Dimensions (1 unit = 1mm; origin at the geometric centre) ---
    /** Tile width along X. Default 26. */
    width: number;
    /** Tile thickness along Y (stacking axis). Default 19. */
    height: number;
    /** Tile length along Z. Default 34. */
    depth: number;
    /** Rounded-corner radius (mm). Default 1.5. */
    radius: number;

    // --- Face (+Y) ---
    /**
     * Lacquer base colour of the glyph face (material.color). Default 0xe4dac6.
     *
     * Cool blue-grey, and deliberately well below white.
     *
     * Two independent decisions, worth keeping separate:
     *
     *  - **Hue.** Neutral. Measured off a Mahjong Soul frame, its tile lacquer sits
     *    at RGB (220, 220, 218) — B minus R of -2, i.e. no cast either way. Warm
     *    ivory read as grubby, and correcting it landed at B minus R of +20, a
     *    blue-tinted white that reads cold and glaring. The target was neither;
     *    it was the middle.
     *  - **Value.** Near-white, ~237 luma. An earlier pass dropped this to 219 to
     *    buy "shading headroom", on the theory that a face lit to 95% of its own
     *    reflectance has nowhere to go. That was the wrong lever twice over: the
     *    thing that actually fixed the frame's two-clump histogram was lifting the
     *    *cloth* (55% of the pixels), not darkening the tiles; and a desaturated
     *    blue-grey at 219 is literally grey-white, which is what the frame then
     *    looked like. Restoring it took the 95th-percentile luma from 225 back to
     *    231 and raised RMS contrast, with no return of the bimodal histogram.
     *    Note that albedo is *not* the lever for overall tile brightness here.
     *    NeutralToneMapping compresses hard at the top, so dropping this by 10 luma
     *    moved the rendered median by 4, and halving the ramp's headroom moved it by
     *    2. Exposure is the knob that actually reaches it — see `exposure` in
     *    post.ts.
     */
    bgColor: number;
    /**
     * Stroke colour saturation multiplier (>1 = more vivid, 1 = original,
     * 0 = grayscale). Default 1.15.
     *
     * Applied in linear space (the glyph face is a lit material now), so a
     * given number bites harder than the same number did when the face was an
     * unlit ShaderMaterial working on gamma-encoded values. Values much above
     * ~1.3 clip the strokes.
     */
    saturation: number;
    /**
     * Default ink weight for any glyph without an entry in `glyphWeightByCode`:
     * how far the edge is pushed outward, in signed-distance units. Default 0.01.
     *
     * A single global value cannot serve the whole art set, because the strokes are
     * not all the same width to begin with — 1p and 2p are a couple of large rings
     * and 1s is a dense bird, so a global boost that rescues 9p turns those into
     * blobs, and backing it off to protect them leaves the small-pip tiles pale.
     *
     * Only meaningful with `useSdfGlyph`, and it is one of the real reasons to
     * want the field: the glyph edge is a threshold on a distance function, so
     * moving the threshold dilates or erodes the strokes. The shipped art is fine
     * line work drawn for print, and a table tile covers roughly 31 CSS px, so
     * without this the strokes land near or below one pixel wide and the face
     * reads as a pale blank panel however dark the ink is.
     *
     * Distinct from the earlier fix of sampling colour at mip 0 — that made the
     * ink properly *dark* (deepest-decile coverage went from 2.1% to 3.9% of tile
     * pixels), this makes it properly *thick*.
     */
    glyphWeight: number;
    /**
     * Absolute per-glyph ink weight, overriding `glyphWeight`. Art metadata rather
     * than a style setting — it belongs next to `codeToFile` because it describes
     * how heavy each drawing already is.
     *
     * Absolute, not an offset: these read as "this glyph's weight is X", which is
     * how the tiers were specified and how they are easiest to reason about.
     *
     * The circle suit sits in two tiers: its pips are concentric rings, so the more
     * a tile carries the smaller and finer each is drawn — 1p and 2p are large rings
     * that need only a touch, while 3p through 9p fall below one screen pixel per
     * ring at table distance. 1s goes the other way, *below* the default: the bird
     * is the densest drawing in the set, so the same weight that helps elsewhere
     * closes up its detail. Bamboo (2s-9s) is the obvious next candidate if its
     * stems read thin.
     *
     * Red fives are listed under every alias the engine and the art use.
     */
    glyphWeightByCode: Record<string, number>;
    /**
     * Multiplier on the resolved weight, whether that came from `glyphWeight` or
     * from `glyphWeightByCode`. Default 1. Lets a debug GUI scale the whole set
     * proportionally without disturbing the tiers.
     */
    glyphWeightScale: number;
    /** Face lacquer roughness. Tight enough that the hardened highlight is a compact shape. Default 0.3. */
    faceRoughness: number;
    /**
     * Take the glyph's *shape* from a signed distance field instead of from the
     * colour texture's alpha channel. Default **false**.
     *
     * The colour map still supplies stroke colour, but its alpha is mipmapped,
     * so a tile a long way from the camera resolves its strokes to mush. An SDF
     * is thresholded per-pixel in the shader against the screen-space gradient,
     * so the edge stays crisp at any distance — which is the whole reason
     * `TileTextureFactory.getSDF` exists.
     *
     * On by default, at 480x640 (see textures.ts). At the 192x256 originally
     * shipped here, the *contours* were quantised to the field grid, so circles
     * rendered as visible staircases and fine strokes went lumpy — which is why
     * this was briefly turned off. The field resolution was the problem, not the
     * technique: at 480x640 the shape is clean, and the build is cached per code
     * so it is a one-time startup cost (warm rebuilds measured 103ms with it vs
     * 92ms without).
     *
     * It is needed at ordinary viewing distance, not just when zoomed in. A table
     * tile covers roughly 31 CSS px, so the 600x800 colour map is sampled from
     * deep mip levels and a thin stroke has its alpha averaged toward zero — the
     * glyphs go pale and the face reads as a blank glowing panel. Thresholding an
     * SDF per-pixel keeps coverage regardless of minification.
     *
     * If this is ever revisited, prefer the pre-baked `tile-msdf/` PNGs over
     * building a field at runtime: they are true multi-channel fields (52% of
     * pixels have differing RGB), and multi-channel holds corners at a fraction of
     * the resolution.
     *
     * Note: a glyph whose SVG carries an opaque full-bleed background rect
     * produces an all-inside mask and cannot be used this way. Of the shipped
     * art only 5z (白板) does, and it is already in `blankCodes`.
     */
    useSdfGlyph: boolean;

    // --- Back (-Y) ---
    /** Back-design base / gold frame colour. Default 0xc8a030. */
    backColor: number;
    /**
     * Self-illumination on the back face. Kept low deliberately: without a
     * bloom pass to catch it, emissive only flattens the surface, and a full
     * wall puts ~70 backs on screen. Default 0.06.
     */
    backEmissiveIntensity: number;

    // --- Sides (±X, ±Z): vertical gradient cream→gold ---
    /**
     * Upper side lacquer colour. Default '#bcc7d8'.
     *
     * Clearly darker than the face, for two reasons that compound: the sides are
     * vertical so an overhead-ish key rakes them, and the side lacquer on a real
     * tile is duller than the polished top. Measured before this, the rendered
     * sides were only 9% darker than the tops (202.8 vs 223.6) — the rim light,
     * which is strongest at exactly these grazing angles, was lifting them back up.
     */
    sideTopColor: string;
    /** Lower side band colour (extends the back colour down the sides). Default '#c8a030'. */
    sideBottomColor: string;
    /** Height (mm) of the coloured bottom band on the sides. Default 3. */
    sideBottomHeight: number;

    // --- Hard-edged specular ---
    /**
     * Replace the smooth GGX falloff with a hard-edged highlight. Default true.
     *
     * On box geometry this matters more than the diffuse ramp does. Every facet
     * of a tile receives constant N.L, so the diffuse term is already flat and a
     * ramp has almost no gradient to quantise — measured at ~7.5 mean luma delta
     * over 22% of the frame. The broad specular sweep is the one genuinely
     * continuous thing left on a flat face, so it is what still reads as
     * "rendered plastic", and hardening it is what reads as cel.
     */
    specHard: boolean;
    /**
     * Accumulated direct-specular level at which the highlight switches on.
     * Default 0.0065.
     *
     * Calibrate against the actual rig rather than guessing — set too high and the
     * highlight never appears at all, too low and it floods the whole face. Same
     * trap as `rampRange`, and the first guess here was 0.05, roughly 10x too
     * high, which switched the feature off silently.
     *
     * Measured by tinting the highlight magenta and sweeping: coverage of a tile
     * region ran 59% at 0.002, 7% at 0.008 and 0.5% at 0.015, so the real level
     * lives around 0.005 and this sits just above it.
     */
    specThreshold: number;
    /** Half-width of the highlight edge, as a fraction of the threshold. Default 0.35. */
    specSoftness: number;
    /**
     * Brightness of the hard highlight once it is on. Default 0.12.
     *
     * Zero. The reference art has no specular on the tile faces at all — they are
     * flat matte panels, and the form is carried by the side faces being darker plus
     * a contact shadow.
     *
     * It also has to be zero to kill the bright line along the bevel. The highlight
     * is *additive and independent of the key's intensity*, so wherever it fires it
     * pins that surface near white: with it on, the bevel sat at 236 whether the key
     * was at 1.9 or 1.45, while the flat top tracked the key down to 192. Turning
     * the key down could never close the gap — the plateau does not move.
     */
    specIntensity: number;
    /** Highlight colour. Cool keeps the tile crisp. Default 0xeaf2ff. */
    specColor: number | string;
    /**
     * Multiplier on the environment (indirect) specular. Default 0.35.
     *
     * The IBL sheen is a broad, view-dependent wash across the whole face — the
     * other half of the plastic read, and unlike the direct highlight it has no
     * shape to harden. Turning it down is the fix; removing it entirely makes the
     * lacquer look like paper.
     */
    specEnvScale: number;

    /** How strongly the highlight and rim are held off the glyph ink, 0..1. Default 0.9. */
    inkSpecSuppress: number;

    // --- Cel ramp (quantised diffuse shading) ---
    /** Quantise diffuse lighting into flat bands. Default true. */
    ramp: boolean;
    /**
     * Also ramp the four side faces. Default false.
     *
     * The sides carry the tile's thickness: their continuous gradient is what
     * reads as a solid object rather than a card. Banding them as well is more
     * aggressively graphic — closer to a flat-coloured tile — so it is offered but
     * not the default.
     */
    rampSides: boolean;
    /** Number of flat bands. 2 is the classic light/shadow split. Default 3. */
    rampSteps: number;
    /** Half-width of the band transition, in normalised light level. Default 0.055. */
    rampSoftness: number;
    /**
     * Level of the darkest band, as a fraction of the brightest. Default 0.62.
     *
     * Not 0: a cel shadow is a *lighter, tinted* version of the lit colour, not an
     * absence of light. Dropping it too far undoes the value compression that got
     * the frame out of its two-clump histogram.
     */
    rampFloor: number;
    /**
     * Light level treated as fully lit — the top of the ramp. Bands are laid out
     * across [0, rampRange], so this is what decides where the terminator falls.
     * Default 1.25.
     *
     * Must actually cover the scene's real light level. Set below it, every
     * surface clamps into the top band and the ramp silently degenerates from a
     * quantiser into a flat multiplier — measured on this rig with the value at
     * 0.8, going from 3 bands to 2 and dropping the floor from 0.62 to 0.3
     * changed the frame by less than 0.1%, because everything was already pinned
     * to the top. 1.25 is where the uniform darkening stops on this lighting rig,
     * i.e. where the range finally spans the lit faces.
     */
    rampRange: number;
    /** Tint multiplied into the darkest band. Cool shadows read as anime. Default 0x9fb0d8. */
    rampShadowTint: number | string;

    // --- Outline (inverted hull) ---
    /** Draw the cel-style outline. Default true. */
    outline: boolean;
    /**
     * Outline thickness in **device pixels** (so ~2 at devicePixelRatio 1, ~4 at
     * 2). Constant on screen: a table tile and a 3x overlay-hand tile get the
     * same line weight, which is what makes it read as ink rather than as
     * geometry. Default 3.
     */
    outlineWidth: number;
    /**
     * Outline colour. Not pure black: a slightly desaturated near-black sits into
     * the lacquer instead of punching a hole in it. Default 0x232830.
     */
    outlineColor: number | string;
    /**
     * Line-weight multiplier where the form turns away from the key light.
     * Default 1.45.
     */
    outlineShadowBoost: number;
    /** Line-weight multiplier where the key light lands. Default 0.55. */
    outlineLitScale: number;
    /** Line-weight multiplier at the far end of the depth range. Default 0.7. */
    outlineFarScale: number;

    // --- Rim light (Fresnel edge highlight, all three faces) ---
    /**
     * Rim light intensity (Fresnel edge glow). Default 0.
     *
     * Off. Three separate things pointed the same way:
     *
     *  - Fresnel peaks at grazing angles, which on a box means the side faces — so
     *    it was fighting the "sides should be darker than the top" requirement.
     *    Removing it took the side-to-top separation from -54 to -57 and dropped
     *    the sides 4.7 luma against the top's 1.9.
     *  - It is cool-tinted, and it was the last of the blue cast: the tile's blue
     *    channel went 205.6 -> 203.0 against a Mahjong Soul reference at 202.4.
     *  - The reference art has no edge glow at all; its tiles read as solid from
     *    darker sides plus a contact shadow.
     *
     * Its actual job — separating a tile from the background — is now done by the
     * outline, so the two overlapped. Kept as a parameter rather than deleted.
     */
    rimIntensity: number;
    /**
     * Rim light colour, in any form `THREE.Color` accepts (0xRRGGBB or
     * '#rrggbb'). A cool tint is what reads as anime edge light; pure white
     * just washes the silhouette out. Default 0x9fc4ff.
     */
    rimColor: number | string;

    // --- SVG art sources (reserved for rule/variant extension) ---
    /** Base URL/dir the per-code `.svg` glyphs are fetched from. */
    svgBasePath: string;
    /** tileCode → SVG filename stem (without extension). */
    codeToFile: Record<string, string>;
    /** Codes that render as a blank face (no glyph), e.g. 白板. */
    blankCodes: string[];
}

const DEFAULT_CONFIG: TileSetConfig = {
    width: 26,
    height: 19,
    depth: 34,
    radius: 1.5,

    bgColor: 0xe4e4e1,
    saturation: 1.15,
    glyphWeight: 0.01,
    glyphWeightScale: 1,
    // Circle suit in two tiers, plus 1s pulled below the default.
    glyphWeightByCode: {
        '1p': 0.010,
        '2p': 0.010,
        '1s': 0.005, // 幺鸡: dense drawing, needs less than the default
        '3p': 0.018,
        '4p': 0.018,
        '5p': 0.018,
        '0p': 0.018, // red five (art filename)
        '5pr': 0.018, // red five (engine code)
        '6p': 0.018,
        '7p': 0.018,
        '8p': 0.018,
        '9p': 0.018,
    },
    faceRoughness: 0.45,
    useSdfGlyph: true,

    backColor: 0xc8a030,
    backEmissiveIntensity: 0.06,

    sideTopColor: '#c2c1bc',
    sideBottomColor: '#c8a030',
    sideBottomHeight: 6,

    specHard: true,
    specThreshold: 0.0065,
    specSoftness: 0.35,
    specIntensity: 0,
    specColor: 0xeaf2ff,
    specEnvScale: 0.06,
    inkSpecSuppress: 0.9,

    ramp: true,
    rampSides: false,
    rampSteps: 3,
    rampSoftness: 0.055,
    rampFloor: 0.38,
    rampRange: 1.25,
    rampShadowTint: 0x9fb0d8,

    outline: true,
    outlineWidth: 3,
    outlineColor: 0x232830,
    outlineShadowBoost: 1.45,
    outlineLitScale: 0.55,
    outlineFarScale: 0.7,

    rimIntensity: 0,
    rimColor: 0x9fc4ff,

    svgBasePath: '/src/renderers/webgl/tile-svgs/',
    codeToFile: {
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
    },
    blankCodes: ['P', '5z'],
};

export class TileSet {
    config: TileSetConfig;

    constructor(config?: Partial<TileSetConfig>) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /** Half thickness — the Y offset that rests a tile on the table (y=0). */
    get halfHeight(): number {
        return this.config.height / 2;
    }

    /** RoundedBoxGeometry segment count (curve resolution). */
    get segments(): number {
        return 6;
    }
}
