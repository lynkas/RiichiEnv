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
    /** Cream lacquer base colour (shader uniform). Default 0xf0ebe0. */
    bgColor: number;
    /** Stroke colour saturation multiplier. Default 1.8. */
    colorBoost: number;
    /** Glyph glow addend intensity. Default 0.5. */
    glowIntensity: number;

    // --- Back (-Y) ---
    /** Back-design base / gold frame colour. Default 0xc8a030. */
    backColor: number;

    // --- Sides (±X, ±Z): vertical gradient cream→gold ---
    /** Upper side lacquer colour. Default '#ddd5c0'. */
    sideTopColor: string;
    /** Lower side band colour (extends the back colour down the sides). Default '#c8a030'. */
    sideBottomColor: string;
    /** Height (mm) of the coloured bottom band on the sides. Default 3. */
    sideBottomHeight: number;

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

    bgColor: 0xf0ebe0,
    colorBoost: 1.8,
    glowIntensity: 0.5,

    backColor: 0xc8a030,

    sideTopColor: '#ddd5c0',
    sideBottomColor: '#c8a030',
    sideBottomHeight: 3,

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
