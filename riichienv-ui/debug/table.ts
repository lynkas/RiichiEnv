import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import GUI from 'lil-gui';
import { Tile3D } from '../src/renderers/webgl/tile3d.js';
import { TextureCache } from '../src/renderers/webgl/textures.js';

// === Base tile dimensions (actual on-table size = BASE × tileScale) ===
const BASE_TILE_W = 26;
const BASE_TILE_H = 19;
const BASE_TILE_D = 34;

// === Default parameters (equivalent to CSS 3D: perspective 1800px + rotateX 48°) ===
const DEFAULTS = {
    fov: 22.6,
    cameraTilt: 45.3,
    cameraDistance: 1572,
    cameraZoom: 1,
    cameraTargetX: 0,
    cameraTargetY: -47,
    cameraTargetZ: 41,
    cameraOffsetX: 0,
    cameraOffsetZ: 40,
    tableSize: 900,
    tileScale: 1.35,
    riverInset: 200,
    handInset: 118,
    opponentHandInset: 91,
    sideHandInset: 91,
    tileGap: 2,
    riverRowGap: 35,
    riverJitter: 3,
    handMode: 'camera' as 'table' | 'camera',
    opponentHandStand: true,
    ambient: 1,
    mainLight: 1,
    hemiIntensity: 1.5,
    hemiSkyColor: '#ffffff',
    hemiGroundColor: '#444444',
    tableColor: '#0d2818',
    toneExposure: 1.0,
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
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = false;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMappingExposure = lp.toneExposure;
document.body.appendChild(renderer.domElement);

// === Lighting (simple: one key light + ambient; no environment map so manual
//                intensity controls remain responsive) ===
const dirLight = new THREE.DirectionalLight(0xffffff, lp.mainLight);
dirLight.position.set(0, 600, 0);
dirLight.castShadow = false;
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
    cloth.receiveShadow = false;
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
const RIVER_ROWS = 3;
const RIVER_COLS = 6;
const HAND_COUNT = 13;

const seatGroups: THREE.Group[] = [];
let cameraHandGroup: THREE.Group | null = null;
const cache = new TextureCache();

// === Per-seat hand inset (南 = 我方, 北 = 对家, 西/东 = 左右一组) ===
function getHandInset(seat: number): number {
    if (seat === 0) return lp.handInset;          // 南（我方）
    if (seat === 2) return lp.opponentHandInset;   // 北（对家）
    return lp.sideHandInset;                       // 西/东（左右一组）
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

// === Hand area: 13 closed tiles + 1 drawn (tsumo) tile, face up (+Y) ===
// Closest to the table edge. Hand tiles use HAND_STEP so they sit nearly
// edge-to-edge (independent of the river tileGap). `target` is either a seat
// group (table mode / other seats) or the decoupled camera-hand group.
//
// `seat` selects the standing mode: opponent seats (1/2/3) stand upright when
// lp.opponentHandStand is on; the south seat (0, incl. decoupled camera hand)
// always lies flat.
async function buildHand(target: THREE.Object3D, handZ: number, seat: number): Promise<void> {
    const sideTex = cache.getSide();
    const stand = lp.opponentHandStand && seat !== 0;
    for (let i = 0; i < HAND_COUNT; i++) {
        const tile = new Tile3D(TILE_W, TILE_H, TILE_D, 6, 1.5 * lp.tileScale);
        await tile.setTileCode(getDemoCode(), cache);
        tile.setSideTexture(sideTex);
        await tile.setBack(cache);
        const x = (i - (HAND_COUNT - 1) / 2) * HAND_STEP;
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
        const tile = new Tile3D(TILE_W, TILE_H, TILE_D, 6, 1.5 * lp.tileScale);
        await tile.setTileCode(getDemoCode(), cache);
        tile.setSideTexture(sideTex);
        await tile.setBack(cache);
        const lastX = ((HAND_COUNT - 1) - (HAND_COUNT - 1) / 2) * HAND_STEP;
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

// === Decoupled south hand (camera mode) ===
// Lives directly in the scene (NOT inside seatGroup[0]), so it never inherits
// the seat rotation and always faces the camera. Placed at the front table
// edge (+Z, the side nearest the camera) with an optional pitch toward it.
async function buildCameraHand(): Promise<void> {
    if (cameraHandGroup) {
        scene.remove(cameraHandGroup);
        cameraHandGroup.traverse((obj) => {
            if (obj instanceof THREE.Mesh) obj.geometry.dispose();
        });
    }
    cameraHandGroup = new THREE.Group();
    cameraHandGroup.position.set(0, 0, HALF - lp.handInset);
    // rotation.x is recomputed every frame in animate() to face the camera.
    // seat=0 → always flat regardless of opponentHandStand.
    await buildHand(cameraHandGroup, 0, 0);
    scene.add(cameraHandGroup);
}

async function buildRiver(seatGroup: THREE.Group, seat: number): Promise<void> {
    const sideTex = cache.getSide();
    const stepX = TILE_W + lp.tileGap * lp.tileScale; // river column step (live-tunable; gap scales with tileScale)
    for (let row = 0; row < RIVER_ROWS; row++) {
        for (let col = 0; col < RIVER_COLS; col++) {
            const tile = new Tile3D(TILE_W, TILE_H, TILE_D, 6, 1.5 * lp.tileScale);
            await tile.setTileCode(getDemoCode(), cache);
            tile.setSideTexture(sideTex);
            const x = (col - (RIVER_COLS - 1) / 2) * stepX;
            const z = HALF - lp.riverInset - row * lp.riverRowGap * lp.tileScale;
            tile.setPosition(x, HALF_H, z);
            // Deterministic micro-jitter: seeded by seat/row/col so the
            // angles are stable across rebuilds.
            const seed = seat * 100 + row * 10 + col;
            tile.mesh.rotation.y = jitterAngle(seed);
            tile.mesh.rotation.z = tiltAngle(seed);
            seatGroup.add(tile.mesh);
        }
    }
}

async function init(): Promise<void> {
    codeIdx = 0; // restart the demo tile cycle so every rebuild looks consistent
    const southDecoupled = lp.handMode === 'camera';

    for (let seat = 0; seat < 4; seat++) {
        const seatGroup = new THREE.Group();
        seatGroup.rotation.y = SEAT_ROTATIONS[seat]!;

        // River always lives inside the seat group.
        await buildRiver(seatGroup, seat);

        // Hand: skip the south seat when its hand is decoupled (built below).
        if (!(seat === 0 && southDecoupled)) {
            await buildHand(seatGroup, HALF - getHandInset(seat), seat);
        }

        scene.add(seatGroup);
        seatGroups.push(seatGroup);
    }

    if (southDecoupled) {
        await buildCameraHand();
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
    if (cameraHandGroup) {
        disposeGroup(cameraHandGroup);
        cameraHandGroup = null;
    }
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

// === 布局 controls (live table / hand / river / tile tuning; triggers a full rebuild) ===
const layoutFolder = gui.addFolder('📐 布局');
layoutFolder.add(lp, 'tableSize', 300, 1200, 10).name('桌面大小').onChange(rebuild);
layoutFolder.add(lp, 'tileScale', 0.5, 2.0, 0.01).name('牌尺寸').onChange(rebuild);
layoutFolder.add(lp, 'handMode', ['table', 'camera']).name('手牌模式').onChange(rebuild);
layoutFolder.add(lp, 'opponentHandStand').name('三家手牌立起').onChange(rebuild);
layoutFolder.add(lp, 'handInset', 10, 300, 1).name('我方手牌边距').onChange(rebuild);
layoutFolder.add(lp, 'opponentHandInset', 10, 300, 1).name('对方手牌边距').onChange(rebuild);
layoutFolder.add(lp, 'sideHandInset', 10, 300, 1).name('左右手牌边距').onChange(rebuild);
layoutFolder.add(lp, 'riverInset', 20, 200, 1).name('牌河距桌边').onChange(rebuild);
layoutFolder.add(lp, 'tileGap', 0, 20, 1).name('牌间距').onChange(rebuild);
layoutFolder.add(lp, 'riverRowGap', 20, 80, 1).name('牌河行间距').onChange(rebuild);
layoutFolder.add(lp, 'riverJitter', 0, 10, 0.5).name('牌河抖动 (°)').onChange(rebuild);

// === 配置管理 (import / export / save / load / reset) ===
const configFolder = gui.addFolder('⚙️ 配置管理');
configFolder.add({ export: exportConfig }, 'export').name('📋 导出JSON');
configFolder.add({ exportURL: exportURL }, 'exportURL').name('🔗 导出URL');
configFolder.add({ import: importConfig }, 'import').name('📥 导入');
configFolder.add({ save: saveConfig }, 'save').name('💾 本地保存');
configFolder.add({ load: loadConfig }, 'load').name('📂 恢复');
configFolder.add({ reset: resetConfig }, 'reset').name('↺ 重置默认');

// === Resize ===
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// === Render loop ===
function animate(): void {
    requestAnimationFrame(animate);
    controls.update();
    // 手牌 billboard：始终面向相机（仅俯仰，rotation.y 锁定 0）。
    if (cameraHandGroup) {
        const dx = camera.position.x - cameraHandGroup.position.x;
        const dy = camera.position.y - cameraHandGroup.position.y;
        const dz = camera.position.z - cameraHandGroup.position.z;
        // angle = 相机相对手牌的仰角（0 = 水平面, π/2 = 正上方）
        const angle = Math.atan2(dy, Math.sqrt(dx * dx + dz * dz));
        // 正上方 → 0（平躺）；水平面 → π/2（竖起花色朝 +Z/相机）
        cameraHandGroup.rotation.x = Math.PI / 2 - angle;
    }
    renderer.render(scene, camera);
}
animate();

init().catch((err) => console.error('[table] init failed:', err));
