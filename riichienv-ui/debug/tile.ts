import { setupDebugScene } from './base.js';
import { Tile3D } from '../src/renderers/webgl/tile3d.js';
import { TextureCache } from '../src/renderers/webgl/textures.js';

const { scene, gui } = setupDebugScene(document.body);
const cache = new TextureCache();

// --- Project tile encoding (mirrors sanma-shell web/core/tile-utils.js) ---
// tile_34: 0-8 萬子(1m-9m), 9-17 筒子(1p-9p), 18-26 索子(1s-9s), 27-33 字牌
// (E,S,W,N,P,F,C). Each tile_34 has 4 copies (copy_index 0-3). The red fives
// live at tile_34 {4,13,22} as copy 0 → texture codes 0m/0p/0s (tiles.ts aliases
// them to 5mr/5pr/5sr). Every other copy is the normal tile.
const RED_FIVE_34: Record<number, string> = { 4: '0m', 13: '0p', 22: '0s' };

function tile34ToCode(t34: number): string {
    if (t34 <= 8) return `${t34 + 1}m`;
    if (t34 <= 17) return `${t34 - 8}p`;
    if (t34 <= 26) return `${t34 - 17}s`;
    return ['E', 'S', 'W', 'N', 'P', 'F', 'C'][t34 - 27];
}

function codeForCopy(t34: number, copy: number): string {
    if (copy === 0 && RED_FIVE_34[t34]) return RED_FIVE_34[t34];
    return tile34ToCode(t34);
}

// Four rows, one per suit. Each row enumerates its tile_34 range; each tile_34
// is a tight block of 4 copies ordered by copy_index (red five at copy 0 for
// 5m/5p/5s). This matches how the project numbers a hand.
const ALL_GROUPS: { name: string; t34Start: number; count: number }[] = [
    { name: '萬', t34Start: 0, count: 9 },
    { name: '筒', t34Start: 9, count: 9 },
    { name: '索', t34Start: 18, count: 9 },
    { name: '字', t34Start: 27, count: 7 },
];

const COPIES = 4; // four of each tile_34

// Compact debug tile — scaled down from the real 21×16.5×28 so the full
// 136-tile grid fits on the 800mm table. Tile3D is a single RoundedBoxGeometry
// mesh; its side material carries a cream→gold gradient map (gold band at the
// bottom) and its -Y face carries the back design.
const DEBUG_W = 15; // X width
const DEBUG_H = 12; // Y thickness
const DEBUG_D = 20; // Z length
const HALF_H = DEBUG_H / 2;

// Layout within/between type-groups and between suit rows.
const INTRA_GAP = 1; // gap between the 4 copies of one tile type
const GROUP_W = COPIES * DEBUG_W + (COPIES - 1) * INTRA_GAP; // 63
const GROUP_GAP = 6; // gap between adjacent type-groups
const GROUP_STEP = GROUP_W + GROUP_GAP; // center-to-center X between groups
const ROW_STEP = DEBUG_D + 5; // Z spacing between suit rows
const GRID_Z_CENTER = -180; // vertical (Z) center of the 4-row grid

const allTiles: Tile3D[] = [];

async function buildAllTiles(): Promise<void> {
    // Upper area: full tile set grouped by suit, one row per suit. Each
    // tile_34 is a tight block of 4 copies (copy 0 = red five for 5m/5p/5s);
    // 9 blocks per row (7 for honors).
    const rowCount = ALL_GROUPS.length;
    for (let row = 0; row < rowCount; row++) {
        const group = ALL_GROUPS[row];
        const z = GRID_Z_CENTER + (row - (rowCount - 1) / 2) * ROW_STEP;
        for (let g = 0; g < group.count; g++) {
            const t34 = group.t34Start + g;
            const groupX = (g - (group.count - 1) / 2) * GROUP_STEP;
            for (let c = 0; c < COPIES; c++) {
                const code = codeForCopy(t34, c);
                const tile = new Tile3D(DEBUG_W, DEBUG_H, DEBUG_D);
                await tile.setTileCode(code, cache);
                const x = groupX + (c - (COPIES - 1) / 2) * (DEBUG_W + INTRA_GAP);
                tile.setPosition(x, HALF_H, z);
                scene.add(tile.mesh);
                allTiles.push(tile);
            }
        }
    }
}

async function buildDirectionShowcase(): Promise<void> {
    // 4 seats — same tile, different Y rotation. Top face stays up; only the
    // glyph heading changes (south=0, west=π/2, north=π, east=-π/2).
    const dirs = [
        { y: 0, label: 'S' },
        { y: Math.PI / 2, label: 'W' },
        { y: Math.PI, label: 'N' },
        { y: -Math.PI / 2, label: 'E' },
    ];
    const z = 30;
    dirs.forEach((d, i) => {
        const tile = new Tile3D(DEBUG_W, DEBUG_H, DEBUG_D);
        tile.setTileCode('5p', cache);
        const x = (i - (dirs.length - 1) / 2) * 45;
        tile.setPosition(x, HALF_H, z);
        tile.mesh.rotation.y = d.y;
        scene.add(tile.mesh);
        allTiles.push(tile);
    });
}

async function buildSpecialForms(): Promise<void> {
    const z = 100;

    // Riichi discard: tile turned sideways (Y rotation by π/2).
    const riichi = new Tile3D(DEBUG_W, DEBUG_H, DEBUG_D);
    await riichi.setTileCode('1s', cache);
    riichi.setPosition(-35, HALF_H, z);
    riichi.mesh.rotation.y = Math.PI / 2;
    scene.add(riichi.mesh);
    allTiles.push(riichi);

    // Face-down (暗杠): physically flip the tile so the back-design face
    // points up. Real identity E is remembered on userData for toggling.
    const faceDown = new Tile3D(DEBUG_W, DEBUG_H, DEBUG_D);
    faceDown.mesh.userData.tileCode = 'E';
    await faceDown.setTileCode('E', cache);
    faceDown.setPosition(35, HALF_H, z);
    faceDown.flip();
    scene.add(faceDown.mesh);
    allTiles.push(faceDown);
}

// Material playground.
const params = {
    roughness: 0.75,
    metalness: 0.75,
    backColor: '#c8a030',
    rotateAll: 0,
    faceDown: false,
};

function applyRoughness(v: number) {
    for (const t of allTiles) for (const m of t.materials) m.roughness = v;
}
function applyMetalness(v: number) {
    for (const t of allTiles) for (const m of t.materials) m.metalness = v;
}

gui.add(params, 'roughness', 0, 1, 0.01).onChange(applyRoughness);
gui.add(params, 'metalness', 0, 1, 0.01).onChange(applyMetalness);

// Recolour the side gradient's bottom band and the back-design frame together.
// Both textures are cached by colour, so picking a previously-used hue is free.
gui.addColor(params, 'backColor').onChange(async (v: string) => {
    const sideTex = cache.getSide(v);
    const backTex = await cache.getBack(v);
    for (const t of allTiles) {
        t.setSideTexture(sideTex);
        t.setBottomTexture(backTex);
    }
});

// rotateAll spins every tile uniformly (overrides direction/special layouts —
// useful for inspecting tile backs/sides. Reset to 0 to restore).
gui.add(params, 'rotateAll', 0, Math.PI * 2, 0.01).onChange((v: number) => {
    for (const t of allTiles) t.mesh.rotation.y = v;
});

// Flip every tile physically: back-design face up when on, glyph face up when
// off. The side gradient's gold band stays at the lower 3mm regardless of
// orientation (it is mapped in the tile's local UV space).
gui.add(params, 'faceDown').onChange((down: boolean) => {
    for (const t of allTiles) {
        if (down) t.flip();
        else t.unflip();
    }
});

async function init() {
    await buildAllTiles();
    await buildDirectionShowcase();
    await buildSpecialForms();
    // Apply the shared side gradient (cream top, gold bottom 3mm) to every
    // tile. Cached so a single canvas texture backs all tiles.
    const sideTex = cache.getSide();
    for (const t of allTiles) t.setSideTexture(sideTex);
    // Paint the back design onto every tile's -Y face.
    await Promise.all(allTiles.map((t) => t.setBack(cache)));
    applyRoughness(params.roughness);
    applyMetalness(params.metalness);
}

init().catch((err) => console.error('[tile-debug] init failed:', err));
