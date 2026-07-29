import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import GUI from 'lil-gui';
import gsap from 'gsap';
import { Tile3D } from '../src/renderers/webgl/tile3d.js';
import { TileTextureFactory } from '../src/renderers/webgl/textures.js';
import { TileSet } from '../src/renderers/webgl/tileset.js';

// === Base tile dimensions (actual on-table size = BASE × tileScale) ===
const BASE_TILE_W = 26;
const BASE_TILE_H = 19;
const BASE_TILE_D = 34;

// === Default parameters (equivalent to CSS 3D: perspective 1800px + rotateX 48°) ===
const DEFAULTS = {
    fov: 22.6,
    cameraTilt: 45.7,
    cameraDistance: 1558,
    cameraZoom: 1,
    cameraTargetX: 0,
    cameraTargetY: -44,
    cameraTargetZ: 41,
    cameraOffsetX: 0,
    cameraOffsetZ: 41,
    tableSize: 900,
    tileScale: 1.4,
    handTileScale: 3,
    handMode: true,
    riverInset: 150,
    handInset: 50,
    opponentHandInset: 90,
    sideHandInset: 90,
    meldEdgeInset: 50,
    meldGroupGap: 0,
    tileGap: 2,
    riverRowGap: 35,
    riverJitter: 3,
    riverWallRemaining: 12,
    riverMode: 'auto' as 'auto' | 'extend' | 'row4', // 'auto' = 自动判断 | 'extend' = 强制第三行延展 | 'row4' = 强制第四行
    opponentHandStand: true,
    ambient: 1,
    mainLight: 1,
    hemiIntensity: 1.5,
    hemiSkyColor: '#ffffff',
    hemiGroundColor: '#444444',
    tableColor: '#232a5c',
    toneExposure: 1,
};

// === Layout params (live-tunable via lil-gui → full rebuild) ===
// Initialized from DEFAULTS; may be overridden by URL config or localStorage.
const lp = { ...DEFAULTS };

// === Legacy config migration (tileW/tileH/tileD → tileScale) ===
function migrateConfig(obj: Record<string, unknown>): void {
    if (!('tileScale' in obj) && typeof obj.tileW === 'number') {
        obj.tileScale = obj.tileW / BASE_TILE_W;
        delete obj.tileW;
        delete obj.tileH;
        delete obj.tileD;
    }
    if (!('opponentHandInset' in obj) && 'handInset' in obj) {
        obj.opponentHandInset = obj.handInset;
    }
    if (!('sideHandInset' in obj) && 'handInset' in obj) {
        obj.sideHandInset = obj.handInset;
    }
}

// === Config validation (guard against malformed import / URL / saved data) ===
const REQUIRED_KEYS: ReadonlyArray<keyof typeof DEFAULTS> = [
    'tableSize', 'cameraTilt', 'cameraDistance', 'fov', 'tileScale',
];
function validateConfig(obj: unknown): boolean {
    if (!obj || typeof obj !== 'object') return false;
    migrateConfig(obj as Record<string, unknown>);
    for (const k of REQUIRED_KEYS) {
        if (!(k in (obj as Record<string, unknown>))) return false;
    }
    return true;
}

// === Startup config: URL config > localStorage > DEFAULTS ===
{
    const urlConfig = new URLSearchParams(location.search).get('config');
    const savedConfig = localStorage.getItem('table-config');
    if (urlConfig) {
        try {
            const imported = JSON.parse(decodeURIComponent(urlConfig));
            if (validateConfig(imported)) {
                Object.assign(lp, imported);
                console.log('[table-config] Loaded from URL:', imported);
            } else {
                console.warn('[table-config] URL config invalid, ignoring');
            }
        } catch (e) {
            console.warn('[table-config] URL config parse failed:', e);
        }
    } else if (savedConfig) {
        try {
            const imported = JSON.parse(savedConfig);
            if (validateConfig(imported)) {
                Object.assign(lp, imported);
                console.log('[table-config] Loaded from localStorage:', imported);
            } else {
                console.warn('[table-config] Saved config invalid, ignoring');
            }
        } catch (e) {
            console.warn('[table-config] Saved config parse failed:', e);
        }
    }
}

let TILE_W = BASE_TILE_W * lp.tileScale;
let TILE_H = BASE_TILE_H * lp.tileScale;
let TILE_D = BASE_TILE_D * lp.tileScale;
let HALF = lp.tableSize / 2;
let HALF_H = TILE_H / 2;
let HAND_STEP = TILE_W + 0.5 * lp.tileScale; // hand tiles sit nearly edge-to-edge (no visible gap); 0.5 base × tileScale
let HAND_DRAWN_GAP = TILE_W * 0.35; // extra gap before the tsumo (drawn) tile

// === Demo tile codes (cycles through all glyphs for hand/meld debug) ===
const ALL_CODES = [
    '1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m',
    '1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p', '9p',
    '1s', '2s', '3s', '4s', '5s', 'E', 'S', 'W', 'P', 'F', 'C',
];
let codeIdx = 0;
function getDemoCode(): string {
    return ALL_CODES[codeIdx++ % ALL_CODES.length]!;
}

// === Scene ===
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a14);

// === 坐标轴 helper（红=X, 绿=Y, 蓝=Z）===
// 用圆柱体代替 AxesHelper 细线，避免远处闪烁。
const axisRadius = 2; // 线宽
const axisLength = 150;

// X 轴（红）
const xAxis = new THREE.Mesh(
    new THREE.CylinderGeometry(axisRadius, axisRadius, axisLength, 8),
    new THREE.MeshBasicMaterial({ color: 0xff4444 }),
);
xAxis.rotation.z = Math.PI / 2;
xAxis.position.x = axisLength / 2;

// Y 轴（绿）
const yAxis = new THREE.Mesh(
    new THREE.CylinderGeometry(axisRadius, axisRadius, axisLength, 8),
    new THREE.MeshBasicMaterial({ color: 0x44ff44 }),
);
yAxis.position.y = axisLength / 2;

// Z 轴（蓝）
const zAxis = new THREE.Mesh(
    new THREE.CylinderGeometry(axisRadius, axisRadius, axisLength, 8),
    new THREE.MeshBasicMaterial({ color: 0x4444ff }),
);
zAxis.rotation.x = Math.PI / 2;
zAxis.position.z = axisLength / 2;

const axisGroup = new THREE.Group();
axisGroup.add(xAxis, yAxis, zAxis);
scene.add(axisGroup);

// === 轴向文字标签（CanvasTexture + Sprite，跟随坐标轴开关）===
function makeAxisLabel(text: string, color: string, pos: [number, number, number]): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = color;
    ctx.font = 'bold 48px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 32, 32);
    const tex = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex }));
    sprite.position.set(pos[0], pos[1], pos[2]);
    sprite.scale.set(25, 25, 1);
    return sprite;
}

const axisLabels: THREE.Sprite[] = [
    makeAxisLabel('X', '#ff4444', [165, 0, 0]),
    makeAxisLabel('Y', '#44ff44', [0, 165, 0]),
    makeAxisLabel('Z', '#4444ff', [0, 0, 165]),
];
scene.add(...axisLabels);

// === Camera (near top-down with a slight tilt) ===
const camera = new THREE.PerspectiveCamera(lp.fov, window.innerWidth / window.innerHeight, 1, 10000);

// Set to true once OrbitControls is constructed so updateCamera can sync its target.
// Before that, updateCamera is called for initial positioning only.
let controlsReady = false;

function updateCamera(): void {
    const rad = (lp.cameraTilt * Math.PI) / 180;
    camera.position.set(
        0, // X 永远 0（不能左右位移）
        Math.cos(rad) * lp.cameraDistance,
        Math.sin(rad) * lp.cameraDistance + lp.cameraOffsetZ,
    );
    camera.fov = lp.fov;
    camera.zoom = lp.cameraZoom;
    camera.updateProjectionMatrix();
    camera.lookAt(0, lp.cameraTargetY, lp.cameraTargetZ);
    if (controlsReady) controls.target.set(0, lp.cameraTargetY, lp.cameraTargetZ);
}
updateCamera();

// === Renderer ===
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMappingExposure = lp.toneExposure;
document.body.appendChild(renderer.domElement);

// === Lighting (simple: one key light + ambient; no environment map so manual
//                intensity controls remain responsive) ===
const dirLight = new THREE.DirectionalLight(0xffffff, lp.mainLight);
dirLight.position.set(200, 800, 200);
dirLight.castShadow = true;
dirLight.shadow.mapSize.width = 2048;
dirLight.shadow.mapSize.height = 2048;
dirLight.shadow.camera.near = 1;
dirLight.shadow.camera.far = 2000;
dirLight.shadow.camera.left = -600;
dirLight.shadow.camera.right = 600;
dirLight.shadow.camera.top = 600;
dirLight.shadow.camera.bottom = -600;
dirLight.shadow.bias = -0.0005;
scene.add(dirLight);

const ambient = new THREE.AmbientLight(0x666666, lp.ambient);
scene.add(ambient);

// HemisphereLight: sky (up-facing) + ground (down-facing) for natural fill.
const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, lp.hemiIntensity);
scene.add(hemiLight);

// === Shared materials for the rebuildable table layer ===
// Geometry is recreated on every rebuild (tableSize changes), but materials
// persist so the live cloth-colour / zone texture controls keep working.
const tableMat = new THREE.MeshStandardMaterial({ color: lp.tableColor, roughness: 0.85 });

// Sync lighting / material values from lp back into the three.js objects.
function applyVisuals(): void {
    ambient.intensity = lp.ambient;
    dirLight.intensity = lp.mainLight;
    hemiLight.intensity = lp.hemiIntensity;
    hemiLight.color.set(lp.hemiSkyColor);
    hemiLight.groundColor.set(lp.hemiGroundColor);
    tableMat.color.set(lp.tableColor);
}

// === Zone overlay layer (top, independent of cloth color) ===
// Subtle green tints over each seat's hand / river regions, baked into a
// transparent CanvasTexture. MeshBasicMaterial keeps the tint stable under
// any lighting, and swapping the cloth color leaves the zones untouched.
function makeZoneTexture(): THREE.CanvasTexture {
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const half = size / 2;

    ctx.clearRect(0, 0, size, size);

    // Four triangular seat regions split by two diagonals, alternating dark/light tints.
    const dark = 'rgba(26, 58, 42, 0.15)';
    const light = 'rgba(42, 90, 58, 0.08)';

    // South (bottom triangle: base on the bottom edge, apex at center).
    ctx.fillStyle = dark;
    ctx.beginPath();
    ctx.moveTo(0, size);
    ctx.lineTo(size, size);
    ctx.lineTo(half, half);
    ctx.closePath();
    ctx.fill();

    // North (top triangle: base on the top edge, apex at center).
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(size, 0);
    ctx.lineTo(half, half);
    ctx.closePath();
    ctx.fill();

    // West (left triangle).
    ctx.fillStyle = light;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, size);
    ctx.lineTo(half, half);
    ctx.closePath();
    ctx.fill();

    // East (right triangle).
    ctx.beginPath();
    ctx.moveTo(size, 0);
    ctx.lineTo(size, size);
    ctx.lineTo(half, half);
    ctx.closePath();
    ctx.fill();

    // Central info rectangle (future: dora / score display).
    const rectW = 120;
    const rectH = 120;
    ctx.fillStyle = 'rgba(58, 106, 74, 0.12)';
    ctx.fillRect(half - rectW / 2, half - rectH / 2, rectW, rectH);

    // Two faint diagonals hinting the seat boundaries.
    ctx.strokeStyle = 'rgba(200, 160, 48, 0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(size, size);
    ctx.moveTo(size, 0);
    ctx.lineTo(0, size);
    ctx.stroke();

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

const zoneMat = new THREE.MeshBasicMaterial({
    map: makeZoneTexture(),
    transparent: true,
    depthWrite: false,
});

const borderMat = new THREE.MeshStandardMaterial({ color: 0xc8a030, roughness: 0.3, metalness: 0.6 });

// === Rebuildable table layer (cloth + zone overlay + gold border bars) ===
let tableGroup: THREE.Group | null = null;

function buildTable(): void {
    if (tableGroup) {
        scene.remove(tableGroup);
        tableGroup.traverse((obj) => {
            if (obj instanceof THREE.Mesh) obj.geometry.dispose();
        });
    }
    tableGroup = new THREE.Group();

    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(lp.tableSize, lp.tableSize), tableMat);
    cloth.rotation.x = -Math.PI / 2;
    cloth.receiveShadow = true;
    tableGroup.add(cloth);

    const zone = new THREE.Mesh(new THREE.PlaneGeometry(lp.tableSize, lp.tableSize), zoneMat);
    zone.rotation.x = -Math.PI / 2;
    zone.position.y = 0.5; // sit just above the cloth to avoid z-fighting
    tableGroup.add(zone);

    const barGeo = new THREE.BoxGeometry(lp.tableSize + 8, 4, 4);
    const borders: Array<{ pos: [number, number, number]; rotY: number }> = [
        { pos: [0, 2, HALF], rotY: 0 }, // front (south edge)
        { pos: [0, 2, -HALF], rotY: 0 }, // back (north edge)
        { pos: [HALF, 2, 0], rotY: Math.PI / 2 }, // right (east edge)
        { pos: [-HALF, 2, 0], rotY: Math.PI / 2 }, // left (west edge)
    ];
    for (const b of borders) {
        const bar = new THREE.Mesh(barGeo, borderMat);
        bar.position.set(b.pos[0], b.pos[1], b.pos[2]);
        bar.rotation.y = b.rotY;
        bar.castShadow = false;
        tableGroup.add(bar);
    }

    scene.add(tableGroup);
}
buildTable();

// === Four-seat layout (each rotated 90° around the table) ===
// Seat order: 南 / 西 / 北 / 东. All positions below are in the local south
// frame (+Z toward the south edge); the per-seat group rotation places them.
const SEAT_ROTATIONS = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
const RIVER_COLS = 6;
const HAND_COUNT = 13;
const MELDS_PER_SEAT = 2; // 每家展示的副露组数（每组让手牌减少 3 张）
const DEMO_RIVER_COUNT = 24; // 演示极端牌河（>18 触发换行策略）

const seatGroups: THREE.Group[] = [];

// === 南家屏幕 overlay 手牌（独立正交场景，渲染在主画面之上）===
// 南家手牌脱离桌面 3D 场景，用正交相机在屏幕空间底部居中绘制，
// 牌大小由 handTileScale 控制（与桌面 tileScale 解耦）。
const handScene = new THREE.Scene();
const handCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
handCamera.position.z = 100;
const handAmbient = new THREE.AmbientLight(0xffffff, 1.2);
handScene.add(handAmbient);
const cameraHandGroup = new THREE.Group();
handScene.add(cameraHandGroup);
// 南家 overlay 手牌 mesh 引用（用于 raycast 点击）
const handTiles: THREE.Mesh[] = [];

function updateHandCamera(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    handCamera.left = -w / 2;
    handCamera.right = w / 2;
    handCamera.top = h / 2;
    handCamera.bottom = -h / 2;
    handCamera.updateProjectionMatrix();
}
updateHandCamera();
// Art/padding spec for face/back/side textures (base 26×19×34, reused across
// rebuilds so the texture caches survive a tileScale slider drag).
const factory = new TileTextureFactory(new TileSet());

// === Per-seat hand inset (南 = 我方, 北 = 对家, 西/东 = 左右一组) ===
function getHandInset(seat: number): number {
    if (seat === 0) return lp.handInset;          // 南（我方）
    if (seat === 2) return lp.opponentHandInset;   // 北（对家）
    return lp.sideHandInset;                       // 西/东（左右一组）
}

// === Hand left edge (fixed, independent of tile count) ===
// 手牌左对齐：左边缘锚定在 13 张满手时的起始位置（满手时居中，少牌时左对齐）。
function calcHandLeftX(): number {
    return -(HAND_COUNT - 1) / 2 * HAND_STEP;
}

// === Deterministic micro-rotation for river discards ===
// A discard river isn't a mechanically perfect grid. These hash a
// seat/row/col seed into stable angles so the river looks hand-played yet
// stays visually identical across rebuilds (no shuffling on every rebuild).
function hashTo01(seed: number): number {
    const x = Math.sin(seed * 12.9898) * 43758.5453;
    return x - Math.floor(x); // [0, 1)
}
function jitterAngle(seed: number): number {
    // Y-axis yaw, ±riverJitter° — the "tossed in the table plane" look.
    return (hashTo01(seed) - 0.5) * 2 * ((lp.riverJitter * Math.PI) / 180);
}
function tiltAngle(seed: number): number {
    // Z-axis roll, ±1° — a slight tilt so tiles aren't dead flat.
    return (hashTo01(seed * 1.7 + 13.37) - 0.5) * 2 * (Math.PI / 180);
}

// === 牌河布局策略 ===
// 纯函数：计算第 index 张弃牌在牌河中的 {row, col}。
// 策略：前 maxRowsBeforeExtend 行各 cols 列。满后若牌墙剩余 > wallThreshold
// 开新行（正常换行），否则最后一行延展（col 继续递增，超出标准列宽）。
interface RiverLayoutConfig {
    cols: number; // 每行列数（默认 6）
    maxRowsBeforeExtend: number; // 延展前的行数（默认 3）
    wallThreshold: number; // 牌墙阈值（默认 9）
}

interface RiverSlot {
    row: number;
    col: number;
}

const RIVER_LAYOUT_DEFAULTS: RiverLayoutConfig = {
    cols: RIVER_COLS,
    maxRowsBeforeExtend: 3,
    wallThreshold: 9,
};

/**
 * 计算第 index 张弃牌在牌河中的位置。
 * - 前若干行正常排列（每行 cols 列）。
 * - 满行后：根据 mode 决定布局。
 *   - 'extend'：强制最后一行延展（col 继续递增，超出标准列宽）。
 *   - 'row4'：强制继续开新行（按 cols 正常换行）。
 *   - 'auto'：牌墙剩余 > wallThreshold → 开新行；否则最后一行延展。
 */
function calcRiverSlot(
    index: number, // 弃牌序号（0-based）
    wallRemaining: number, // 牌墙剩余张数
    mode: 'auto' | 'extend' | 'row4' = 'auto',
    config: RiverLayoutConfig = RIVER_LAYOUT_DEFAULTS,
): RiverSlot {
    const { cols, maxRowsBeforeExtend, wallThreshold } = config;
    const threshold = maxRowsBeforeExtend * cols; // 满行总数（默认 18）

    if (index < threshold) {
        return { row: Math.floor(index / cols), col: index % cols };
    }

    // 满行后：根据 mode 决定开新行还是延展最后一行
    if (mode === 'extend') {
        // 强制第三行延展
        const extendBase = (maxRowsBeforeExtend - 1) * cols;
        return { row: maxRowsBeforeExtend - 1, col: index - extendBase };
    } else if (mode === 'row4') {
        // 强制第四行
        return { row: Math.floor(index / cols), col: index % cols };
    } else {
        // auto：根据牌墙剩余判断
        if (wallRemaining > wallThreshold) {
            return { row: Math.floor(index / cols), col: index % cols };
        }
        const extendBase = (maxRowsBeforeExtend - 1) * cols; // 最后一行起点（默认 12）
        return { row: maxRowsBeforeExtend - 1, col: index - extendBase };
    }
}

// === Hand area: 13 closed tiles + 1 drawn (tsumo) tile, face up (+Y) ===
// Closest to the table edge. Hand tiles use HAND_STEP so they sit nearly
// edge-to-edge (independent of the river tileGap). `target` is either a seat
// group (table mode / other seats) or the decoupled camera-hand group.
//
// `seat` selects the standing mode: opponent seats (1/2/3) stand upright when
// lp.opponentHandStand is on; the south seat (0, incl. decoupled camera hand)
// always lies flat.
async function buildHand(target: THREE.Object3D, handZ: number, seat: number): Promise<void> {
    const sideTex = factory.getSideTexture();
    const stand = lp.opponentHandStand && seat !== 0;
    const handCount = HAND_COUNT - MELDS_PER_SEAT * 3;
    const handLeftX = calcHandLeftX();
    for (let i = 0; i < handCount; i++) {
        const tile = new Tile3D(new TileSet({ width: TILE_W, height: TILE_H, depth: TILE_D, radius: 1.5 * lp.tileScale }));
        await tile.setCode(getDemoCode(), factory);
        tile.setSideTexture(sideTex);
        await tile.setBack(factory);
        const x = handLeftX + i * HAND_STEP;
        if (stand) {
            // 竖立：rotation.x = π/2 把牌从平放翻转成立姿。原 depth(Z=TILE_D)
            // 变成竖直高度，中心 Y = TILE_D/2 使底面贴桌。花色面(+Y)旋转后
            // 指向 +Z（在本家本地系里），经 seatGroup.rotation.y 后朝向该家
            // 玩家——即玩家看到自己的花色，桌面中央看到背面。
            tile.mesh.rotation.x = Math.PI / 2;
            tile.setPosition(x, TILE_D / 2, handZ);
        } else {
            tile.setPosition(x, HALF_H, handZ);
        }
        target.add(tile.mesh);
    }
    // Drawn (tsumo) tile: offset to the right of the closed hand with an extra gap.
    {
        const tile = new Tile3D(new TileSet({ width: TILE_W, height: TILE_H, depth: TILE_D, radius: 1.5 * lp.tileScale }));
        await tile.setCode(getDemoCode(), factory);
        tile.setSideTexture(sideTex);
        await tile.setBack(factory);
        const lastX = handLeftX + (handCount - 1) * HAND_STEP;
        const drawnX = lastX + HAND_STEP + HAND_DRAWN_GAP;
        if (stand) {
            tile.mesh.rotation.x = Math.PI / 2;
            tile.setPosition(drawnX, TILE_D / 2, handZ);
        } else {
            tile.setPosition(drawnX, HALF_H, handZ);
        }
        target.add(tile.mesh);
    }
}

// === 南家屏幕 overlay 手牌缩放 ===
// handTileScale 为可调相对大小（默认 3）；正交场景里 1 单位 = 1 像素。
function calcHandScale(): number {
    return lp.handTileScale;
}

// === 南家屏幕 overlay 手牌（屏幕空间，底部居中）===
// 手牌在独立正交场景 handScene 中绘制，覆盖在主画面之上。牌大小由
// handTileScale 控制（与桌面 tileScale 解耦），底部居中排列，摸牌带额外间距。
// buildCameraHand 清空 cameraHandGroup 后重建；rebuild 时由 init() 调用。
async function buildCameraHand(): Promise<void> {
    // 清空旧手牌（dispose 几何体；材质 / 纹理为共享缓存，不释放）
    for (const mesh of handTiles) {
        cameraHandGroup.remove(mesh);
        mesh.geometry.dispose();
    }
    handTiles.length = 0;

    const hs = calcHandScale();
    const hw = BASE_TILE_W * hs;
    const hh = BASE_TILE_H * hs;
    const hd = BASE_TILE_D * hs;
    const radius = 1.5 * hs;
    const handStep = hw + 0.5 * hs;
    const handDrawnGap = hw * 0.35;
    const sideTex = factory.getSideTexture();

    const handCount = HAND_COUNT - MELDS_PER_SEAT * 3;
    // 左对齐：以满手（13 闭合 + 1 tsumo）整体居中于 x=0 时的左边缘作为固定锚点。
    // 满手时整体居中；鸣牌导致闭合手牌减少时左边缘保持不变，牌从右侧依次减少。
    // 注：leftX 为最左闭合牌中心（非物理左边缘），故不计入额外 hw，否则满手会左偏 hw/2。
    const fullHandCount = HAND_COUNT; // 13 闭合
    const leftX = -((fullHandCount * handStep + handDrawnGap) / 2);
    // 底部：正交相机底边 = -innerHeight/2，手牌中心 = 底边 + 半高 + 边距
    const bottomMargin = 16;
    const y = -window.innerHeight / 2 + hd / 2 + bottomMargin;

    const placeTile = async (x: number): Promise<void> => {
        const tile = new Tile3D(new TileSet({ width: hw, height: hh, depth: hd, radius }));
        await tile.setCode(getDemoCode(), factory);
        tile.setSideTexture(sideTex);
        await tile.setBack(factory);
        // 立式面向摄像机（+Z）：rotation.x = π/2 把 +Y 花色面转到 +Z
        tile.mesh.rotation.x = Math.PI / 2;
        tile.setPosition(x, y, 0);
        cameraHandGroup.add(tile.mesh);
        handTiles.push(tile.mesh);
    };

    for (let i = 0; i < handCount; i++) {
        await placeTile(leftX + i * handStep);
    }
    // 摸牌（tsumo）：闭合手牌右侧加额外间距
    await placeTile(leftX + handCount * handStep + handDrawnGap);
}

async function buildRiver(seatGroup: THREE.Group, seat: number): Promise<void> {
    // 南家（seat 0）牌河改为动态管理（addRiverTile / clearSouthRiver），
    // 由「🎬 牌河演示」面板逐张驱动，演示牌河增长 / 换行 / 延展全过程。
    if (seat === 0) return;
    const sideTex = factory.getSideTexture();
    const stepX = TILE_W + lp.tileGap * lp.tileScale; // river column step (live-tunable; gap scales with tileScale)
    for (let i = 0; i < DEMO_RIVER_COUNT; i++) {
        const slot = calcRiverSlot(i, lp.riverWallRemaining, lp.riverMode);
        const tile = new Tile3D(new TileSet({ width: TILE_W, height: TILE_H, depth: TILE_D, radius: 1.5 * lp.tileScale }));
        await tile.setCode(getDemoCode(), factory);
        tile.setSideTexture(sideTex);
        // 牌河以 X=0 为中心对称排列；延展 col≥6 自然向右溢出（真实牌桌行为）。
        const x = (slot.col - (RIVER_COLS - 1) / 2) * stepX;
        const z = lp.riverInset + slot.row * lp.riverRowGap * lp.tileScale;
        tile.setPosition(x, HALF_H, z);
        // Deterministic micro-jitter: seeded by seat/row/col so the
        // angles are stable across rebuilds.
        const seed = seat * 100 + slot.row * 10 + slot.col;
        tile.mesh.rotation.y = jitterAngle(seed);
        tile.mesh.rotation.z = tiltAngle(seed);
        seatGroup.add(tile.mesh);
    }
}

// === 南家动态牌河（可交互添加 / 清除）===
// seat 0（南家）脱离静态 buildRiver，由按钮逐张追加弃牌，
// 实时演示牌河随弃牌数增长 → 换行 → 延展的全过程。其他三家仍为静态。
interface SouthRiverEntry {
    code: string;
    tile: Tile3D;
    riichi: boolean;
}
const southRiver: SouthRiverEntry[] = [];

// 动态牌河专用 code 循环（独立于 getDemoCode，序列稳定可重复）
let riverCodeIdx = 0;
const RIVER_DEMO_CODES = [
    '1m', '9m', '1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p', '9p', '5pr',
    '1s', '2s', '3s', '4s', '5s', '6s', '7s', '8s', '9s', '5sr',
    'E', 'S', 'W', 'N', 'P', 'F', 'C',
];
function nextRiverCode(): string {
    return RIVER_DEMO_CODES[riverCodeIdx++ % RIVER_DEMO_CODES.length]!;
}

/**
 * 向南家牌河追加一张弃牌。位置 / 抖动算法与 buildRiver 完全一致，
 * 仅以当前 southRiver.length 作为 index 动态计算 slot。
 * 传入 code 则用指定花色（rebuild 复原用），否则从 RIVER_DEMO_CODES 循环取下一位。
 */
async function addRiverTile(
    codeOverride?: string,
    riichi: boolean = false,
    animate: boolean = true,
    startPos?: { x: number; y: number; z: number }, // 自定义飞行起点（主场景世界坐标）
): Promise<void> {
    const sg = seatGroups[0];
    if (!sg) return; // init 尚未完成，seatGroup 不存在
    const code = codeOverride ?? nextRiverCode();
    const index = southRiver.length;
    const slot = calcRiverSlot(index, lp.riverWallRemaining, lp.riverMode);

    const sideTex = factory.getSideTexture();
    const tile = new Tile3D(new TileSet({ width: TILE_W, height: TILE_H, depth: TILE_D, radius: 1.5 * lp.tileScale }));
    await tile.setCode(code, factory);
    tile.setSideTexture(sideTex);
    await tile.setBack(factory);

    const gap = lp.tileGap * lp.tileScale;
    const stepX = TILE_W + gap;
    // 行起点：以正常 6 列居中为基准的 col 0 位置。各行左对齐（真实牌桌行为），
    // 延展 col≥6 自然向右溢出（与 buildRiver 行为一致）。
    const rowStartX = -((RIVER_COLS - 1) / 2) * stepX;
    // X 位置改为累加同行前面牌的实际宽度，而非固定 col * stepX：
    // 横放（riichi）牌 rotation.y=π/2 后宽度从 TILE_W 变为 TILE_D，
    // 后续牌按实际宽度累加可自然右移避让，避免与横放牌重叠。
    // southRiver 下标即弃牌序号，用 calcRiverSlot 重算即可定位同行前面牌。
    let x = rowStartX;
    for (let i = 0; i < southRiver.length; i++) {
        const prevSlot = calcRiverSlot(i, lp.riverWallRemaining, lp.riverMode);
        if (prevSlot.row !== slot.row) continue;
        x += southRiver[i]!.riichi ? TILE_D + gap : TILE_W + gap;
    }
    // 横放牌中心右移，让左边缘对齐正常竖牌的左边缘
    if (riichi) {
        x += (TILE_D - TILE_W) / 2;
    }
    // 横放（riichi）牌 Z 偏移：近端（+Z/玩家方向）边缘与竖放牌对齐
    const sidewaysZOffset = riichi ? (TILE_D - TILE_W) / 2 : 0;
    const z = lp.riverInset + slot.row * lp.riverRowGap * lp.tileScale + sidewaysZOffset;

    if (!animate) {
        // 初始 / 重建：直接落座最终位置，不触发飞行动画。
        tile.setPosition(x, HALF_H, z);
        if (riichi) {
            tile.mesh.rotation.y = Math.PI / 2;
            tile.mesh.rotation.z = 0;
        } else {
            const seed = slot.row * 10 + slot.col;
            tile.mesh.rotation.y = jitterAngle(seed);
            tile.mesh.rotation.z = tiltAngle(seed);
        }
        sg.add(tile.mesh);
        southRiver.push({ code, tile, riichi });
        return;
    }

    // 起点：自定义（如点击手牌投影出的世界坐标）或默认手牌区（南家手牌右侧），平放，线性飞向牌河。
    const handStartX = startPos?.x ?? 100; // 手牌右侧偏移
    const handStartY = startPos?.y ?? HALF_H;
    const handStartZ = startPos?.z ?? (HALF - lp.handInset); // 手牌 Z 位置
    tile.setPosition(handStartX, handStartY, handStartZ);
    sg.add(tile.mesh);

    // 线性飞到牌河位置
    gsap.to(tile.mesh.position, {
        x: x,
        y: HALF_H,
        z: z,
        duration: 0.25,
        ease: 'power1.inOut', // 接近线性
        onComplete: () => {
            // 到达后设最终角度：立直横放 或 正常抖动。
            if (riichi) {
                tile.mesh.rotation.y = Math.PI / 2;
                tile.mesh.rotation.z = 0;
            } else {
                const seed = slot.row * 10 + slot.col;
                tile.mesh.rotation.y = jitterAngle(seed);
                tile.mesh.rotation.z = tiltAngle(seed);
            }
        },
    });

    southRiver.push({ code, tile, riichi });
}

/** 清空南家牌河：从父节点移除每张牌并释放其几何体（材质 / 纹理为共享缓存，不释放）。 */
function clearSouthRiver(): void {
    for (const { tile } of southRiver) {
        tile.mesh.parent?.remove(tile.mesh);
        tile.dispose();
    }
    southRiver.length = 0;
}

// === 南家副露演示（5 种副露类型：pon / chi / minkan / kakan / ankan）===
// 副露区在主 scene 的 seatGroup[0] 里（桌面靠近桌边，与手牌同 Z 层），位于
// 手牌右侧。副露牌缩小至 tileScale × 0.8。与牌河同款动态管理：逐组追加，
// 新组紧接在已有组右侧。rebuild 时按保存的 type 序列复原。
type MeldType = 'pon' | 'chi' | 'minkan' | 'kakan' | 'ankan';

interface MeldSpec {
    slot: number; // X 方向列位（0 = 最靠近手牌，递增向外）
    sideways?: boolean; // rotation.y = π/2：横放（被夺牌 / 加杠叠加牌）
    faceDown?: boolean; // rotation.x = π：背面朝上（暗杠两侧翻面）
    kakanAttach?: boolean; // 加杠：第4张横放，紧贴第1张横放牌的 Z 负方向（远离玩家）
}

const southMelds: { type: MeldType; tiles: Tile3D[] }[] = [];

/** 每种副露的牌规格（列位 + 朝向）。实际坐标由 addMeld 布局，花色由 getDemoCode 循环。 */
function getMeldConfig(type: MeldType): MeldSpec[] {
    switch (type) {
        case 'pon':
        case 'chi':
            // 3 张，第 1 张横放（被夺牌）
            return [
                { slot: 0, sideways: true },
                { slot: 1 },
                { slot: 2 },
            ];
        case 'minkan':
            // 4 张，第 2 张横放（被夺牌）
            return [
                { slot: 0 },
                { slot: 1, sideways: true },
                { slot: 2 },
                { slot: 3 },
            ];
        case 'kakan':
            // 4 张：第 1 张横放（被夺牌）；第 4 张横放，紧贴第 1 张的 Z 负方向（远离玩家）
            return [
                { slot: 0, sideways: true },
                { slot: 1 },
                { slot: 2 },
                { slot: 0, sideways: true, kakanAttach: true },
            ];
        case 'ankan':
            // 两侧（slot 0、3）背面朝上；中间两张（slot 1、2）正面朝上
            return [
                { slot: 0, faceDown: true },
                { slot: 1 },
                { slot: 2 },
                { slot: 3, faceDown: true },
            ];
    }
}

/** 计算一组副露在 X 方向占用的总宽度（含每张牌后的 innerGap；加杠第 4 张不计）。 */
function calcMeldGroupWidth(specs: MeldSpec[], tileD: number, tileW: number, innerGap: number): number {
    let width = 0;
    for (const spec of specs) {
        if (spec.kakanAttach) continue; // 加杠第4张紧贴第1张 Z 负方向，不占额外 X 宽度
        width += (spec.sideways ? tileD : tileW) + innerGap;
    }
    return width;
}

/**
 * 在 target group 里放置一组副露。纯布局，不管理 southMelds 等状态。
 *
 * groupStartX = 这组副露的左边缘 X 坐标；组内 slot 0 最左，向 +X 累加推进 cursor。
 * 标准规则：所有牌在同一桌面平面，底部对齐（y = halfH）。横放牌仅绕 Y 轴旋转
 * 90°，高度不变、底边（近端）与竖放牌共线。加杠第 4 张（kakanAttach）复用 slot 0
 * 横放牌的 X，紧贴第 1 张横放牌的 Z 负方向（远离玩家）。
 *
 * 返回这组副露的牌引用与占用宽度（含组内间距；加杠第 4 张不计宽度）。
 */
async function createMeldGroup(
    target: THREE.Group,
    type: MeldType,
    groupStartX: number,
    meldTs: number,
    meldZ: number,
): Promise<{ tiles: Tile3D[]; width: number }> {
    const tileW = BASE_TILE_W * meldTs;
    const tileH = BASE_TILE_H * meldTs; // 牌厚（Y 方向）
    const tileD = BASE_TILE_D * meldTs;
    const halfH = tileH / 2;
    const innerGap = 0.8 * meldTs; // 组内间距：牌几乎贴在一起，能看到贴缝线
    // 横放牌（rotation.y = π/2）Z 偏移：让横放牌近端（+Z/玩家方向）边缘
    // 与竖放牌对齐。竖放牌近端 = meldZ + tileD/2；横放牌近端 = z + tileW/2，
    // 令二者相等得 z = meldZ + (tileD - tileW)/2。
    const sidewaysZOffset = (tileD - tileW) / 2;

    // 共享缩小 TileSet（面 / 背 / 侧纹理来自全局 factory，与几何尺寸无关）
    const meldTileSet = new TileSet({ width: tileW, height: tileH, depth: tileD, radius: 1.5 * meldTs });
    const sideTex = factory.getSideTexture();
    const specs = getMeldConfig(type);

    const tiles: Tile3D[] = [];
    // 累加式 X 排列：从 groupStartX（本组左边缘）开始，按每张牌的实际 X 宽度
    // 推进 cursor。横放牌占 tileD、竖放牌占 tileW。
    let cursorX = groupStartX;
    let slot0X = 0; // slot 0 中心，供 kakan 第 4 张复用（X 相同）
    let firstSidewaysZ = 0; // 第 1 张横放牌中心 Z，供 kakan 第 4 张 Z 负方向紧贴
    for (const spec of specs) {
        const tile = new Tile3D(meldTileSet);
        await tile.setCode(getDemoCode(), factory);
        tile.setSideTexture(sideTex);
        await tile.setBack(factory);

        // X：累加实际宽度。加杠第 4 张（kakanAttach）复用 slot 0 横放牌中心，不推进 cursor。
        let x: number;
        if (spec.kakanAttach) {
            x = slot0X;
        } else {
            const xWidth = spec.sideways ? tileD : tileW;
            x = cursorX + xWidth / 2;
            cursorX += xWidth + innerGap;
            if (spec.slot === 0) slot0X = x;
        }

        // Y：所有牌在同一桌面平面（底部对齐），加杠第 4 张不抬高。
        const y = halfH;

        // 旋转：先复位。faceDown 翻面（背面朝上，rotation.x = π）；sideways 横放（rotation.y = π/2）
        tile.mesh.rotation.set(0, 0, 0);
        if (spec.faceDown) tile.mesh.rotation.x = Math.PI;
        if (spec.sideways) tile.mesh.rotation.y = Math.PI / 2;

        // Z：横放牌向 +Z 偏移，底边（近端）与竖放牌对齐。
        // 加杠第 4 张横放，紧贴第 1 张横放牌的 Z 负方向（远离玩家）。
        let tileZ: number;
        if (spec.kakanAttach) {
            tileZ = firstSidewaysZ - tileW - innerGap;
        } else if (spec.sideways) {
            tileZ = meldZ + sidewaysZOffset;
            firstSidewaysZ = tileZ;
        } else {
            tileZ = meldZ;
        }
        tile.setPosition(x, y, tileZ);
        target.add(tile.mesh);
        tiles.push(tile);
    }

    return { tiles, width: calcMeldGroupWidth(specs, tileD, tileW, innerGap) };
}

/**
 * 向南家副露区追加一组副露。
 *
 * 布局方向：副露锚定在桌子右边缘，向 -X 方向生长。第一组右边缘 = HALF - meldEdgeInset
 * （紧贴桌子右边）；此后每组右边缘 = 前组左边缘 - groupGap。单组内摆放交给
 * createMeldGroup（四家共用同一布局）。rebuild 时由 init() 用保存的 type 序列复原。
 */
async function addMeld(type: MeldType): Promise<void> {
    const sg = seatGroups[0];
    if (!sg) return;

    const meldTs = lp.tileScale * 0.8;
    const innerGap = 0.8 * meldTs;
    const groupGap = lp.meldGroupGap * meldTs; // 组间间距：稍大，能看到组分界
    const meldZ = HALF - lp.handInset; // 与手牌同 Z 层
    const meldTileD = BASE_TILE_D * meldTs;
    const meldTileW = BASE_TILE_W * meldTs;

    // rightEdge = 新组的右边缘可用位置。从桌子右边缘起向左扣减已有组占用。
    // 第一组（i=0）无前置 gap；后续组每组前置 groupGap。
    let rightEdge = HALF - lp.meldEdgeInset;
    for (let i = 0; i < southMelds.length; i++) {
        if (i > 0) rightEdge -= groupGap;
        rightEdge -= calcMeldGroupWidth(getMeldConfig(southMelds[i]!.type), meldTileD, meldTileW, innerGap);
    }
    if (southMelds.length > 0) rightEdge -= groupGap;
    const currentWidth = calcMeldGroupWidth(getMeldConfig(type), meldTileD, meldTileW, innerGap);
    const groupStartX = rightEdge - currentWidth;

    const { tiles } = await createMeldGroup(sg, type, groupStartX, meldTs, meldZ);
    southMelds.push({ type, tiles });
}

/** 清空南家副露：从父节点移除每张牌并释放几何体（材质 / 纹理为共享缓存，不释放）。 */
function clearMelds(): void {
    for (const meld of southMelds) {
        for (const tile of meld.tiles) {
            tile.mesh.parent?.remove(tile.mesh);
            tile.dispose();
        }
    }
    southMelds.length = 0;
}

/** 其他三家的静态副露类型（init 创建，覆盖全部 5 种副露以便调试）。 */
const SEAT_MELD_TYPES: MeldType[][] = [
    [],                   // seat 0（南）：动态，由 GUI 按钮添加
    ['pon', 'chi'],       // seat 1（西）
    ['minkan', 'kakan'],  // seat 2（北）
    ['ankan', 'pon'],     // seat 3（东）
];

async function init(): Promise<void> {
    codeIdx = 0; // restart the demo tile cycle so every rebuild looks consistent

    for (let seat = 0; seat < 4; seat++) {
        const seatGroup = new THREE.Group();
        seatGroup.rotation.y = SEAT_ROTATIONS[seat]!;

        // River always lives inside the seat group.
        await buildRiver(seatGroup, seat);

        // Hand: south seat uses a screen-space overlay (decoupled) when handMode
        // is on; otherwise it lies flat in the table like the other seats.
        if (seat === 0) {
            if (lp.handMode) {
                await buildCameraHand();
            } else {
                await buildHand(seatGroup, HALF - lp.handInset, seat);
            }
        } else {
            await buildHand(seatGroup, HALF - getHandInset(seat), seat);
        }

        scene.add(seatGroup);
        seatGroups.push(seatGroup);
    }

    // 为其他三家创建静态副露（南家 seat 0 用动态 southMelds 管理）。
    // 与南家共用 createMeldGroup，四家布局完全一致；副露锚定桌子右边缘（局部坐标
    // HALF - meldEdgeInset），向 -X 生长。副露直接加入目标 seatGroup，rebuild 时随
    // seatGroup 一起销毁重建。局部坐标，由 seatGroup.rotation.y 自动旋转到方位。
    for (let seat = 1; seat < 4; seat++) {
        const sg = seatGroups[seat]!;
        const meldTs = lp.tileScale * 0.8;
        const groupGap = lp.meldGroupGap * meldTs;
        const meldZ = HALF - getHandInset(seat);
        const meldTileD = BASE_TILE_D * meldTs;
        const meldTileW = BASE_TILE_W * meldTs;
        const innerGap = 0.8 * meldTs;

        // rightEdge 逻辑与 addMeld 一致：第一组右边缘贴桌子右边，后续组接在前组左侧。
        let rightEdge = HALF - lp.meldEdgeInset;
        const meldTypes = SEAT_MELD_TYPES[seat]!;
        for (let m = 0; m < meldTypes.length; m++) {
            const meldType = meldTypes[m]!;
            if (m > 0) rightEdge -= groupGap;
            const width = calcMeldGroupWidth(getMeldConfig(meldType), meldTileD, meldTileW, innerGap);
            const groupStartX = rightEdge - width;
            await createMeldGroup(sg, meldType, groupStartX, meldTs, meldZ);
            rightEdge = groupStartX; // 下一组右边缘 = 本组左边缘
        }
    }

    // 复原南家动态牌河：rebuild 时 disposeGroup 已清掉 seatGroups[0]（含旧牌河几何体），
    // 这里用保存的 code 序列逐一重建。首次启动 southRiver 为空 → 等价无操作。
    {
        const savedCodes = southRiver.map((r) => ({ code: r.code, riichi: r.riichi }));
        southRiver.length = 0;
        for (const item of savedCodes) {
            await addRiverTile(item.code, item.riichi, false);
        }
    }

    // 复原南家动态副露：rebuild 时 disposeGroup 已清掉 seatGroups[0]（含旧副露几何体），
    // 这里用保存的 type 序列逐一重建。首次启动 southMelds 为空 → 不预创建，由 GUI 按钮添加。
    {
        const savedTypes = southMelds.map((m) => m.type);
        southMelds.length = 0;
        for (const t of savedTypes) {
            await addMeld(t);
        }
    }
}

function disposeGroup(g: THREE.Object3D): void {
    scene.remove(g);
    g.traverse((obj) => {
        if (obj instanceof THREE.Mesh) obj.geometry.dispose();
    });
}

// === Rebuild: tear down the table, seats and decoupled hand, then reconstruct ===
function rebuild(): void {
    for (const g of seatGroups) disposeGroup(g);
    seatGroups.length = 0;
    // 清掉南家 overlay 手牌（不在 seatGroups 里，需单独清；几何体释放，材质 / 纹理共享）
    for (const mesh of handTiles) {
        cameraHandGroup.remove(mesh);
        mesh.geometry.dispose();
    }
    handTiles.length = 0;
    TILE_W = BASE_TILE_W * lp.tileScale;
    TILE_H = BASE_TILE_H * lp.tileScale;
    TILE_D = BASE_TILE_D * lp.tileScale;
    HALF = lp.tableSize / 2;
    HALF_H = TILE_H / 2;
    HAND_STEP = TILE_W + 0.5 * lp.tileScale;
    HAND_DRAWN_GAP = TILE_W * 0.35;
    buildTable();
    void init().catch((err) => console.error('[table] rebuild failed:', err));
}

// === OrbitControls (drag to orbit; clamped above the table) ===
const controls = new OrbitControls(camera, renderer.domElement);
// 必须在第一次 controls.update() 之前设正确 target：默认 (0,0,0) 会让
// controls.update() 用错误 target 反算球面坐标，首次拖拽 / Z 滑块即跳。
controls.target.set(0, lp.cameraTargetY, lp.cameraTargetZ);
controls.minAzimuthAngle = 0;
controls.maxAzimuthAngle = 0;
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI / 2 - 0.05;
controls.minDistance = 200;
controls.maxDistance = 3000;
controls.update(); // 用正确 target 同步内部 spherical
controlsReady = true;
updateCamera(); // controlsReady 已 true，这次同步 target 并对齐相机

// === lil-gui ===
const gui = new GUI({ title: '2.5D 牌桌调试' });

// Refresh every lil-gui controller display (used after import / load / reset).
function syncGUI(): void {
    for (const controller of gui.controllersRecursive()) {
        controller.updateDisplay();
    }
}

// === Reverse-sync: OrbitControls drag → lil-gui display ===
// Fired on every OrbitControls 'change' (drag + damping frames). updateDisplay()
// only refreshes the DOM inputs — it does NOT fire onChange — so updateCamera
// is never re-entered. isSyncing is a belt-and-braces guard regardless.
let isSyncing = false;

function syncFromCamera(): void {
    if (isSyncing || !controlsReady) return;
    isSyncing = true;

    const dx = camera.position.x - controls.target.x;
    const dy = camera.position.y - controls.target.y;
    const dz = camera.position.z - controls.target.z;

    lp.cameraDistance = Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz));
    // updateCamera uses rad measured from +Y toward +Z (y=cos·d, z=sin·d), so
    // atan2(dz, dy) recovers it: 0 = pure top-down, 90 = horizontal.
    lp.cameraTilt = Math.round(((Math.atan2(dz, dy) * 180) / Math.PI) * 10) / 10;
    lp.cameraTargetY = Math.round(controls.target.y);
    lp.cameraTargetZ = Math.round(controls.target.z);

    // X 轴锁定：不从相机反算 cameraOffsetX / cameraTargetX（保持 0）。
    // controls.target.x 可能被 OrbitControls 改动，强制拉回 0。
    if (Math.abs(controls.target.x) > 0.1) {
        controls.target.x = 0;
    }

    // cameraOffsetZ is an absolute position offset; subtract the tilt/distance
    // base so that re-running updateCamera lands back on the same spot.
    const rad = (lp.cameraTilt * Math.PI) / 180;
    const baseZ = Math.sin(rad) * lp.cameraDistance;
    lp.cameraOffsetZ = Math.round(camera.position.z - baseZ);

    syncGUI();
    isSyncing = false;
}

controls.addEventListener('change', syncFromCamera);

// === Config management ===
function exportConfig(): void {
    const json = JSON.stringify(lp, null, 2);
    navigator.clipboard.writeText(json).then(() => {
        console.log('[table-config] Copied to clipboard:\n' + json);
    });
}

function exportURL(): void {
    const json = JSON.stringify(lp);
    const url = location.origin + location.pathname + '?config=' + encodeURIComponent(json);
    navigator.clipboard.writeText(url).then(() => {
        console.log('[table-config] URL copied:\n' + url);
    });
}

async function importConfig(): Promise<void> {
    try {
        const text = await navigator.clipboard.readText();
        const imported = JSON.parse(text);
        if (!validateConfig(imported)) {
            console.error('[table-config] Import failed: invalid config');
            return;
        }
        Object.assign(lp, imported);
        rebuild();
        updateCamera();
        applyVisuals();
        syncGUI();
        console.log('[table-config] Imported:', imported);
    } catch (e) {
        console.error('[table-config] Import failed:', e);
    }
}

function saveConfig(): void {
    localStorage.setItem('table-config', JSON.stringify(lp));
    console.log('[table-config] Saved to localStorage');
}

function loadConfig(): void {
    const saved = localStorage.getItem('table-config');
    if (!saved) {
        console.warn('[table-config] No saved config');
        return;
    }
    try {
        const imported = JSON.parse(saved);
        if (!validateConfig(imported)) {
            console.error('[table-config] Load failed: invalid config');
            return;
        }
        Object.assign(lp, imported);
        rebuild();
        updateCamera();
        applyVisuals();
        syncGUI();
        console.log('[table-config] Loaded from localStorage');
    } catch (e) {
        console.error('[table-config] Load failed:', e);
    }
}

function resetConfig(): void {
    Object.assign(lp, DEFAULTS);
    rebuild();
    updateCamera();
    applyVisuals();
    syncGUI();
    console.log('[table-config] Reset to defaults');
}

// === 视觉 controls (camera + lighting; camera changes are instant, no rebuild) ===
const visualFolder = gui.addFolder('💡 视觉');
visualFolder.close();
visualFolder.add(lp, 'cameraTilt', 0, 60, 1).name('倾斜角 (°)').onChange(updateCamera);
visualFolder.add(lp, 'cameraDistance', 250, 2000, 10).name('相机距离').onChange(updateCamera);
visualFolder.add(lp, 'fov', 10, 60, 0.1).name('视野 FOV').onChange(updateCamera);
visualFolder.add(lp, 'cameraZoom', 0.5, 3, 0.01).name('相机缩放').onChange(updateCamera);
visualFolder.add(lp, 'cameraTargetY', -500, 500, 1).name('目标 Y 偏移').onChange(updateCamera);
visualFolder.add(lp, 'cameraTargetZ', -500, 500, 1).name('目标 Z 偏移').onChange(updateCamera);
visualFolder.add(lp, 'cameraOffsetZ', -500, 500, 1).name('位置 Z 偏移').onChange(updateCamera);
visualFolder.add(lp, 'ambient', 0, 20, 0.01).name('环境光').onChange((v: number) => {
    ambient.intensity = v;
});
visualFolder.add(lp, 'mainLight', 0, 10, 0.01).name('主光源').onChange((v: number) => {
    dirLight.intensity = v;
});
visualFolder.addColor(lp, 'tableColor').name('桌布颜色').onChange((v: string) => {
    tableMat.color.set(v);
});
visualFolder.add(lp, 'hemiIntensity', 0, 20, 0.01).name('半球光强度').onChange((v: number) => {
    hemiLight.intensity = v;
});
visualFolder.addColor(lp, 'hemiSkyColor').name('天空色').onChange((v: string) => {
    hemiLight.color.set(v);
});
visualFolder.addColor(lp, 'hemiGroundColor').name('地面色').onChange((v: string) => {
    hemiLight.groundColor.set(v);
});
visualFolder.add(lp, 'toneExposure', 0.1, 3, 0.01).name('曝光').onChange((v: number) => {
    renderer.toneMappingExposure = v;
});
visualFolder.add({ showAxes: true }, 'showAxes').name('坐标轴').onChange((v: boolean) => {
    axisGroup.visible = v;
    for (const label of axisLabels) label.visible = v;
});

// === 布局 controls (live table / hand / river / tile tuning; triggers a full rebuild) ===
const layoutFolder = gui.addFolder('📐 布局');
layoutFolder.close();
layoutFolder.add(lp, 'tableSize', 300, 1200, 10).name('桌面大小').onChange(rebuild);
layoutFolder.add(lp, 'tileScale', 0.5, 2.0, 0.01).name('牌尺寸').onChange(rebuild);
layoutFolder.add(lp, 'handTileScale', 0.5, 5, 0.1).name('手牌大小').onChange(rebuild);
layoutFolder.add(lp, 'handMode').name('南家手牌 overlay').onChange(rebuild);
layoutFolder.add(lp, 'opponentHandStand').name('三家手牌立起').onChange(rebuild);
layoutFolder.add(lp, 'handInset', 10, 300, 1).name('我方手牌边距').onChange(rebuild);
layoutFolder.add(lp, 'opponentHandInset', 10, 300, 1).name('对方手牌边距').onChange(rebuild);
layoutFolder.add(lp, 'sideHandInset', 10, 300, 1).name('左右手牌边距').onChange(rebuild);
layoutFolder.add(lp, 'riverInset', 50, 500, 1).name('牌河距中心').onChange(rebuild);
layoutFolder.add(lp, 'tileGap', 0, 20, 1).name('牌间距').onChange(rebuild);
layoutFolder.add(lp, 'riverRowGap', 20, 80, 1).name('牌河行间距').onChange(rebuild);
layoutFolder.add(lp, 'riverJitter', 0, 10, 0.5).name('牌河抖动 (°)').onChange(rebuild);
layoutFolder.add(lp, 'riverWallRemaining', 0, 30, 1).name('牌墙剩余').onChange(rebuild);
layoutFolder.add(lp, 'riverMode', ['auto', 'extend', 'row4']).name('牌河换行').onChange(rebuild);

// === 配置管理 (import / export / save / load / reset) ===
const configFolder = gui.addFolder('⚙️ 配置管理');
configFolder.close();
configFolder.add({ export: exportConfig }, 'export').name('📋 导出JSON');
configFolder.add({ exportURL: exportURL }, 'exportURL').name('🔗 导出URL');
configFolder.add({ import: importConfig }, 'import').name('📥 导入');
configFolder.add({ save: saveConfig }, 'save').name('💾 本地保存');
configFolder.add({ load: loadConfig }, 'load').name('📂 恢复');
configFolder.add({ reset: resetConfig }, 'reset').name('↺ 重置默认');

// === 牌河演示（南家动态牌河：逐张弃牌 / 批量 / 清空）===
const demoFolder = gui.addFolder('🎬 牌河演示');
demoFolder.add({ discard: () => { void addRiverTile(); } }, 'discard').name('➕ 弃牌');
demoFolder
    .add({ discard5: async () => { for (let i = 0; i < 5; i++) await addRiverTile(); } }, 'discard5')
    .name('➕ 弃5张');
demoFolder
    .add({ riichi: () => { void addRiverTile(undefined, true); } }, 'riichi')
    .name('🎯 立直弃牌');
demoFolder.add({ clear: clearSouthRiver }, 'clear').name('🗑️ 清空');

// === 副露（南家动态副露：逐组添加 / 清空）===
const meldFolder = gui.addFolder('🀄 副露');
meldFolder.add({ pon: () => { void addMeld('pon'); } }, 'pon').name('➕ 碰');
meldFolder.add({ chi: () => { void addMeld('chi'); } }, 'chi').name('➕ 吃');
meldFolder.add({ minkan: () => { void addMeld('minkan'); } }, 'minkan').name('➕ 大明杠');
meldFolder.add({ kakan: () => { void addMeld('kakan'); } }, 'kakan').name('➕ 加杠');
meldFolder.add({ ankan: () => { void addMeld('ankan'); } }, 'ankan').name('➕ 暗杠');
meldFolder.add(lp, 'meldEdgeInset', 0, 100, 1).name('副露距桌边').onChange(rebuild);
meldFolder.add(lp, 'meldGroupGap', 0, 30, 1).name('副露组间距').onChange(rebuild);
meldFolder.add({ clear: clearMelds }, 'clear').name('🗑️ 清空');

// === 点击手牌 → 弃牌（南家 overlay 手牌）===
// 手牌在独立正交场景 handScene，用 handCamera raycast 命中 overlay 手牌，
// 命中即触发弃牌（飞行起点用默认桌面手牌区，不传屏幕坐标）。
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

renderer.domElement.addEventListener('pointerdown', (event) => {
    if (handTiles.length === 0) return;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(pointer, handCamera);
    const intersects = raycaster.intersectObjects(handTiles);
    if (intersects.length === 0) return;

    const hit = intersects[0]!;
    const clickedMesh = hit.object as THREE.Mesh;

    // 视觉反馈：被点击手牌弹一下（yoyo 回弹到原 scale）
    gsap.fromTo(
        clickedMesh.scale,
        { x: 1, y: 1, z: 1 },
        { x: 1.15, y: 1.15, z: 1.15, duration: 0.1, yoyo: true, repeat: 1, ease: 'power2.out' },
    );

    // overlay 手牌在屏幕空间，弃牌飞行起点用默认桌面手牌区（不传屏幕坐标）。
    void addRiverTile(undefined, false, true);
});

// === Resize ===
let resizeTimer: number | null = null;
window.addEventListener('resize', () => {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    updateHandCamera();

    // debounce rebuild（200ms 后才重建牌）
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => rebuild(), 200);
});

// === Render loop ===
// 主场景 + 南家 overlay 手牌场景叠加渲染。autoClear 关闭，手动清除：
// 先清颜色 + 深度画主场景，再清深度画 overlay 手牌（保留主画面颜色）。
renderer.autoClear = false;
function animate(): void {
    requestAnimationFrame(animate);
    controls.update();
    renderer.clear();
    renderer.render(scene, camera);
    renderer.clearDepth();
    renderer.render(handScene, handCamera);
}
animate();

init()
    .then(async () => {
        // 初始放 6 张弃牌，让南家牌河有起始状态（可继续点「弃牌」追加）。
        for (let i = 0; i < 6; i++) await addRiverTile(undefined, false, false);
    })
    .catch((err) => console.error('[table] init failed:', err));
