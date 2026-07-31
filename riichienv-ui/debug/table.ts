import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import GUI from 'lil-gui';
import gsap from 'gsap';
import {
    Tile3D,
    tileGeometryCacheSize,
    setOutlineViewport,
    setOutlineLightDirection,
    setOutlineDepthRange,
} from '../src/renderers/webgl/tile3d.js';
import { TileTextureFactory } from '../src/renderers/webgl/textures.js';
import { TileSet } from '../src/renderers/webgl/tileset.js';
import { ContactShadows } from './contact_shadows.js';
import { createPostChain, POST_DEFAULTS, type PostSettings } from './post.js';
import { makeFeltDetailTexture, makeFeltNapNormalTexture } from './felt.js';

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
    // --- 光照：一盏有明确方向的主光 + 一盏冷色补光。
    //     不要再加白色补光去救暗面 —— 那会把明暗压平，正是「廉价感」的来源。
    //     暗部的颜色由 hemi 的 sky/ground 和冷色补光给，不由额外的白光给。
    ambient: 0.14,
    mainLight: 1.6,
    mainLightColor: '#fff8f0', // key light：只留一点暖，避免整体发黄
    fillLight: 0.5,
    fillLightColor: '#7fa6e8', // 冷色补光（对侧，制造冷暗部）
    hemiIntensity: 0.4,
    hemiSkyColor: '#dde3ee', // 天光：收掉一些蓝，避免把中性牌面染冷
    hemiGroundColor: '#4a3a2c', // 桌面暖反弹
    // overlay 手牌（独立正交场景）复用上面同一组光照值，只留一个整体倍率。
    // 原来 handScene 只有一盏 AmbientLight —— 纯 ambient 完全均匀，牌面没有
    // 任何明暗和高光。给它独立的强度数值是下一个坑：两个场景的参数会各自漂移，
    // 你在桌面上调好的值搬到手牌就不对。手牌可以比桌面亮一点（它是 UI，要好
    // 读），但那应该是一个刻意的倍率，不是另一套数字。
    handLightBoost: 1.15,
    tableColor: '#505a89', // 抬亮 + 降饱和。雀魂桌布实测 L=54.8 / B−R=+60，我们原来 38.8 / +70 —— 太暗太蓝
    // exposure 回到 1.0，tone mapping 换 Neutral。ACESFilmic 压高光去饱和是为
    // 写实电影设计的，二次元要的鲜艳色块会被它洗成灰的；exposure 0.5 又在上面
    // 再压一档，然后逼着把灯堆亮来对抗 —— 两头打架。
    toneExposure: 1.0,
    // 材质 / 光照（GUI 🎨 材质 面板可调）
    tileBgColor: 0xe4e4e1, // 牌面底色：中性近白。雀魂实测 RGB(220,220,218)，B−R=−2 —— 不是冷也不是暖
    tileSaturation: 1.15, // 花色饱和度（现在在线性空间生效，>1.3 会截断）
    tileRadius: 1.5, // 圆角半径（mm）
    // Rim light 默认关：Fresnel 在掠射角最强（长方体上就是侧面），一直在和「侧面
    // 该更暗」打对台；它是冷色的，也是最后一点偏蓝的来源；而参考图的牌边缘本来
    // 就没有发光。它原本的作用——让牌从背景里浮出来——现在由描边接管了。
    rimIntensity: 0, // Rim light 强度（uniform，实时生效）
    rimColor: '#9fc4ff', // Rim light 颜色（uniform，实时生效）
    // 笔画粗细分三档：默认 0.01，一二饼 0.015，三~九饼 0.018。
    // 单一全局值行不通 —— 1饼/2饼是大圈、幺鸡笔画密，能救 9饼 的量会把它们糊成一坨。
    // 逐牌型的绝对值在 tileset.ts 的 glyphWeightByCode。
    glyphWeight: 0.01,
    glyphWeightScale: 1, // 乘在解析出的粗细上，用来整体缩放而不打乱三档比例
    faceRoughness: 0.45, // 牌面粗糙度：调高一点，收窄高光区域、压掉牌面反光感
    useSdfGlyph: true, // 480×640 的场。桌面尺寸下贴图 mipmap 会把细笔画平均掉，字面发淡
    // --- 硬边高光 ---
    // 长方体上每个面 N·L 恒定、diffuse 本来就是平的，所以 ramp 没什么梯度可切；
    // 宽软的 GGX 高光才是平面上唯一真正连续的东西，也就是「渲染感」的来源。
    specHard: true,
    specThreshold: 0.0065, // 实测校准：magenta 标记扫描出来的，估的 0.05 高了约 10 倍
    specSoftness: 0.35,
    specIntensity: 0,
    specColor: '#eaf2ff',
    specEnvScale: 0.06, // 环境高光是无形状的宽面反光，只能压不能硬化
    inkSpecSuppress: 0.9, // 高光/rim 不打在笔画上 —— 高光是加性且与 albedo 无关，会把近黑笔画抬成灰
    // --- Cel ramp（明暗阶跃化）---
    // 在 diffuse 累加完成之后量化，所以是把整套灯（主光/冷补光/半球/环境/IBL）
    // 的结果一起分区，而不是只 ramp 某一盏灯的 NdotL。默认只作用在牌面和牌背，
    // 侧面保持连续 —— 侧面渐变是厚度感的来源。
    ramp: true,
    rampSides: false,
    rampSteps: 3,
    rampSoftness: 0.055,
    rampFloor: 0.38,
    rampRange: 1.25,
    rampShadowTint: '#9fb0d8',
    // --- 描边（inverted hull）---
    // 逐牌的背面外扩壳，在「屏幕平面内」外扩、深度完全不动。线宽是 device px，
    // 全画面恒定 —— 桌面牌和 3x 的 overlay 手牌线重一样，这才像墨线。
    // 相邻牌之间会自然出现接缝线 —— 这是「粒粒分明」的来源。
    outline: true,
    outlineWidth: 3, // 描边线宽，单位 device px（屏幕空间恒定）
    outlineColor: '#232830',
    // 线宽跟着光照走：背光侧重、受光侧轻，再叠一层随距离变细。
    // 完全均匀的线是「shader 画的」而不是「笔画的」最明显的破绽。
    outlineShadowBoost: 1.45,
    outlineLitScale: 0.55,
    outlineFarScale: 0.7,
    // 距离雾：给远端一点柔化和纵深。用它而不是 DOF —— BokehPass 要为深度多渲染
    // 一遍整个场景，而 22.6° FOV 下 ~700mm 深的主体弥散圈极小，不值。
    //
    // 用「线性 Fog + near/far」而不是 FogExp2。指数雾的浓度是从相机起算的，
    // 相机离桌子 1500 多，结果连近处的牌也被雾掉两成 —— 实测把近端牌从 216 拉到
    // 186、中间调从 41.4% 打回 31.9%，把之前压值域的成果吃掉了。
    // 线性雾的 near 落在最近的牌之前，近端零雾、只有远端起效。
    fogNearScale: 0.82, // × cameraDistance
    fogFarScale: 3.0, // × cameraDistance
    fogColor: '#242c4a',
    sideTopColor: '#c2c1bc', // 侧面色：中性，且明确比牌面暗（竖面吃光少，漆面更哑）
    sideBottomColor: '#c8a030', // 侧面金色（hex string，addColor）
    sideBottomHeight: 6, // 侧面金色高度（mm）
    iblIntensity: 0.3, // IBL 环境贴图强度
    showAxes: false, // 坐标轴 helper（默认关，评估画面时三根彩色柱会干扰判断）
    feltDetail: true, // 桌布程序化纹理（斑驳 + 织纹 + 渐晕）
    // 斑驳幅度。默认接近关闭 —— value noise 每个八度都是平滑团块，粗细同步增长，
    // 实测粗/细比 1.14（绒毛只有 0.41），那就是「一块一块」。往上拖会重新出现斑块。
    feltMottle: 0.02,
    feltVignette: 0.22, // 桌布径向渐晕（体积感，不是噪声）
    showZones: true, // 座位分区叠层（中性淡化后；关掉可对比）
    // --- 桌布布料感 ---
    // 法线贴图给绒毛的凹凸（漫反射对光的响应），sheen 给布料特有的掠射光泽。
    // 光靠 albedo 变化只是「画上去的」，不会像布。
    // 绒毛是唯一「只加细纹、不加粗结构」的东西 —— 实测粗/细比 0.41，而 detail map
    // 的斑驳噪声是 1.14（粗≈细，那才是「一块一块」）。所以布料感靠绒毛，斑驳几乎关掉。
    feltNap: 0.5, // 绒毛法线强度
    // 8 而不是 22：repeat 22 时绒毛特征小于一个像素，亚像素的法线贴图只能产生噪声、
    // 不可能像布。8 让中频特征落在 ~6px，是可分辨的织纹尺度。
    feltNapRepeat: 8, // 绒毛平铺次数（越大绒毛越细）
    // Sheen carries more than its own brightness: the lobe is normal-dependent, so
    // it amplifies the nap normal map. Measured local cloth variation at the table's
    // camera distance: flat colour 1.21, detail map 1.47, +nap at sheen 0.6 -> 1.79,
    // but dropping sheen to 0.35 took it back to 1.54. Keep the sheen and re-level
    // the cloth with `tableColor`, not by cutting it.
    feltSheen: 0.6, // 布料掠射光泽强度
    feltSheenRough: 0.75, // 光泽的粗糙度（越大越散）
    feltSheenColor: '#93a6cf', // 光泽颜色
    // --- 接触阴影 ---
    // 牌底下一圈软阴影，贴在桌面上，与光照方向无关。见 contact_shadows.ts：
    // 有角度的方向光只会投出斜影，而那盏灯同时负责形体明暗，两者必须解耦。
    contactShadows: true,
    contactShadowOpacity: 0.45,
    contactShadowSpread: 1.3,
    // shadow map 默认关：现在的接地感来自接触阴影。打开可以对比斜影。
    castShadows: false,
    // --- 金边发光（给 bloom 提供真正超过 1.0 的光源）---
    goldEmissive: 2.4,
    // --- 后处理 ---
    ...POST_DEFAULTS,
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
/**
 * Soft radial backdrop instead of a flat colour.
 *
 * Raising the black floor in the grade pass (see `lift` in post.ts) lifts the
 * empty area outside the table too, and a flat fill turns into a conspicuous
 * grey wedge in the corners. A gradient reads as an environment falling off into
 * darkness rather than as an unpainted region — and an anime frame very rarely
 * has a pure black void in it anyway.
 */
function makeBackdropTexture(): THREE.CanvasTexture {
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('table: 2d context unavailable');
    // Centred a little above the middle, roughly where the table sits.
    const grad = ctx.createRadialGradient(size * 0.5, size * 0.42, size * 0.05, size * 0.5, size * 0.42, size * 0.72);
    grad.addColorStop(0, '#2b3459');
    grad.addColorStop(0.55, '#1a2038');
    grad.addColorStop(1, '#0d1120');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    // UVMapping makes three draw it as a fitted full-screen backdrop rather
    // than treating it as an environment projection.
    texture.mapping = THREE.UVMapping;
    return texture;
}
scene.background = makeBackdropTexture();
// Linear haze toward the backdrop colour, bracketed so it starts just in front
// of the nearest tile. Cheap depth separation, and the one genuinely soft thing
// in the frame.
scene.fog = new THREE.Fog(lp.fogColor, 1, 2);

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
axisGroup.visible = lp.showAxes;
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
for (const label of axisLabels) label.visible = lp.showAxes;
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
    // Thin-out range keyed off the camera distance, so orbiting or zooming does
    // not leave every line pinned at one end of the falloff.
    setOutlineDepthRange(lp.cameraDistance * 0.72, lp.cameraDistance * 1.28);
    const fog = scene.fog as THREE.Fog | null;
    if (fog) {
        fog.near = lp.cameraDistance * lp.fogNearScale;
        fog.far = lp.cameraDistance * lp.fogFarScale;
    }
}
updateCamera();

// === Renderer ===
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
// The outline shader converts its pixel width into clip space, so it needs the
// drawing-buffer size. One shared uniform drives every tile.
setOutlineViewport(
    window.innerWidth * renderer.getPixelRatio(),
    window.innerHeight * renderer.getPixelRatio(),
);
// Shadow mapping is off by default — grounding comes from the contact-shadow
// decals instead (see contact_shadows.ts). Kept switchable so the slanted
// cast-shadow look can be compared directly.
renderer.shadowMap.enabled = lp.castShadows;
// PCFSoftShadowMap is deprecated as of three r18x and silently falls back to
// PCFShadowMap; VSM is the current soft option.
renderer.shadowMap.type = THREE.VSMShadowMap;
// Khronos PBR Neutral: keeps saturated colour blocks saturated instead of
// rolling them off to grey the way ACESFilmic does. Applied by OutputPass at
// the end of the post chain, not in the materials.
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMappingExposure = lp.toneExposure;
document.body.appendChild(renderer.domElement);

// === IBL: 程序化环境贴图（RoomEnvironment），给 MeshStandardMaterial 提供环境反射 ===
const pmremGenerator = new THREE.PMREMGenerator(renderer);
const envTexture = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
pmremGenerator.dispose();
scene.environment = envTexture;
scene.environmentIntensity = lp.iblIntensity;

// === Lighting ===
// Two directional lights, both with a purpose:
//   key  — warm, steep, from the upper right. The only shadow caster.
//   fill — cool, low, from the opposite side. Gives the dark side a *colour*
//          instead of just lifting it, which is where the anime read comes
//          from (warm light / cool shadow).
// The previous setup had four white directionals (key + 3 fills) from four
// directions plus ambient plus hemi. That is near-omnidirectional white light:
// no gradient across any surface, no silhouette, no form. Needing three fills
// to rescue the dark side is itself the tell that the key direction was never
// chosen.
const dirLight = new THREE.DirectionalLight(lp.mainLightColor, lp.mainLight);
// Elevation ~72 degrees, not the ~50 it was.
//
// This is what removes the bright line along the bevel between the top face and
// the sides. A rounded edge sweeps its normal from vertical to horizontal, so at a
// 50-degree key a 45-degree stretch of bevel points almost straight at the light
// and picks up N.L of 0.99 against the flat top's 0.77 — 29% more light than the
// face it borders, on a *darker* albedo. Measured, the bevel ran 25 luma above the
// top face. Raising the key so the flat top is the most-lit orientation in the
// tile leaves nothing on the bevel able to beat it: the profile across the edge
// goes flat (231/230) instead of spiking to 236.
//
// The azimuth is unchanged, so the warm-key / cool-fill split is intact; the sides
// actually separate *better* (they drop from 156 to 144) because a steeper key
// rakes them less.
dirLight.position.set(420, 1588, 300);
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
// Tiles are thin boxes lit at a grazing angle — normalBias does far more for
// their self-shadowing acne than bias alone.
dirLight.shadow.normalBias = 0.6;
scene.add(dirLight);

const fillLight = new THREE.DirectionalLight(lp.fillLightColor, lp.fillLight);
fillLight.position.set(-380, 240, -320);
fillLight.castShadow = false;
scene.add(fillLight);

const ambient = new THREE.AmbientLight(0xa4aab6, lp.ambient);
scene.add(ambient);

// HemisphereLight: cool sky above, warm table bounce below.
const hemiLight = new THREE.HemisphereLight(lp.hemiSkyColor, lp.hemiGroundColor, lp.hemiIntensity);
scene.add(hemiLight);

// === Shared materials for the rebuildable table layer ===
// Geometry is recreated on every rebuild (tableSize changes), but materials
// persist so the live cloth-colour / zone texture controls keep working.
// Cloth. Three things make it read as fabric rather than as a painted plane:
//
//  - `map` is a *detail* map (values around white), so `color` still carries the
//    hue and the live cloth-colour control keeps working. Large-scale mottling.
//  - `normalMap` is a tiled nap at fibre scale. This is the one that matters: paint
//    and weave differ in how they respond to light, not in how they are coloured.
//  - `sheen` is three's cloth lobe — a grazing-angle retroreflection that is
//    exactly the "brushed baize catches the light near the far edge" look, and it
//    cannot be faked with roughness.
// `let`, not const: the detail map is baked into a canvas, so changing its
// amplitude means regenerating and swapping the texture.
let feltDetailTexture = makeFeltDetailTexture({
    mottle: lp.feltMottle,
    vignette: lp.feltVignette,
});
// What the current texture was actually baked with, so a rebuild can be skipped
// when nothing relevant changed.
let bakedFeltMottle = lp.feltMottle;
let bakedFeltVignette = lp.feltVignette;
const feltNapTexture = makeFeltNapNormalTexture();
feltNapTexture.repeat.set(lp.feltNapRepeat, lp.feltNapRepeat);
// Highest anisotropy the driver allows — see the note in felt.ts.
feltNapTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
const tableMat = new THREE.MeshPhysicalMaterial({
    color: lp.tableColor,
    map: feltDetailTexture,
    normalMap: feltNapTexture,
    normalScale: new THREE.Vector2(lp.feltNap, lp.feltNap),
    roughness: 0.92,
    metalness: 0,
    sheen: lp.feltSheen,
    sheenRoughness: lp.feltSheenRough,
    sheenColor: new THREE.Color(lp.feltSheenColor),
});

/**
 * Rebuild the cloth detail map from `lp` and swap it in.
 *
 * The map is a baked canvas, so its amplitudes cannot be uniforms. The old
 * texture is disposed rather than left to GC — it is a 1024^2 RGBA upload.
 */
function rebuildFeltDetail(): void {
    const next = makeFeltDetailTexture({
        mottle: lp.feltMottle,
        vignette: lp.feltVignette,
    });
    feltDetailTexture.dispose();
    feltDetailTexture = next;
    bakedFeltMottle = lp.feltMottle;
    bakedFeltVignette = lp.feltVignette;
    if (lp.feltDetail) {
        tableMat.map = feltDetailTexture;
        tableMat.needsUpdate = true;
    }
}

/**
 * Rebuild only if the baked values are actually stale.
 *
 * Called from `applyVisuals`, which every light control also runs — regenerating a
 * 1024^2 canvas on each of those would make the whole GUI feel broken. Routing it
 * through here rather than binding the sliders straight to `rebuildFeltDetail` also
 * means config import / load / reset pick the change up, which they otherwise
 * would not: those paths set `lp` wholesale and call `applyVisuals`.
 */
function maybeRebuildFeltDetail(): void {
    if (lp.feltMottle !== bakedFeltMottle || lp.feltVignette !== bakedFeltVignette) {
        rebuildFeltDetail();
    }
}

// Sync lighting / material values from lp back into the three.js objects.
function applyVisuals(): void {
    ambient.intensity = lp.ambient;
    dirLight.intensity = lp.mainLight;
    dirLight.color.set(lp.mainLightColor);
    fillLight.intensity = lp.fillLight;
    fillLight.color.set(lp.fillLightColor);
    hemiLight.intensity = lp.hemiIntensity;
    hemiLight.color.set(lp.hemiSkyColor);
    hemiLight.groundColor.set(lp.hemiGroundColor);
    tableMat.color.set(lp.tableColor);
    applyHandLights();
    maybeRebuildFeltDetail();
    // Line weight follows the key light, so it has to track it.
    setOutlineLightDirection(dirLight.position.x, dirLight.position.y, dirLight.position.z);
    const fog = scene.fog as THREE.Fog | null;
    if (fog) {
        // Keyed off camera distance so orbiting does not push the table out of
        // the fog band entirely.
        fog.near = lp.cameraDistance * lp.fogNearScale;
        fog.far = lp.cameraDistance * lp.fogFarScale;
        fog.color.set(lp.fogColor);
    }
    borderMat.emissiveIntensity = lp.goldEmissive;
    renderer.shadowMap.enabled = lp.castShadows;
    contactShadows.setVisible(lp.contactShadows);
    contactShadows.setOpacity(lp.contactShadowOpacity);
    contactShadows.spread = lp.contactShadowSpread;
    post.apply(lp as PostSettings);
    refreshContactShadows();
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

    // Line work only — no tinted quadrants.
    //
    // This layer used to fill the four seat triangles and the central area with
    // translucent green-grey. Two problems, and fixing the first exposed the
    // second: over a blue cloth the green is a hue clash that reads as staining
    // (it was the largest source of colour patchiness on the cloth, green-vs-blue
    // balance spread 3.76 against 2.89 without it), and once the tints were made
    // neutral the *value* steps became more obvious still — four flat patches with
    // hard diagonal seams, which is worse.
    //
    // Zoning does not need fills. The reference art marks the table with thin
    // inlay lines and leaves the cloth continuous, so that is what this draws.
    const line = 'rgba(214, 226, 245, 0.10)';
    const gold = 'rgba(212, 184, 128, 0.12)';

    // Two faint diagonals hinting the seat boundaries.
    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(size, size);
    ctx.moveTo(size, 0);
    ctx.lineTo(0, size);
    ctx.stroke();

    // Central discard area, outlined rather than filled.
    const sq = size * 0.30;
    ctx.strokeStyle = gold;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(half - sq / 2, half - sq / 2, sq, sq);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    return texture;
}

const zoneMat = new THREE.MeshBasicMaterial({
    map: makeZoneTexture(),
    transparent: true,
    depthWrite: false,
});

// Gold trim. `emissiveIntensity` is deliberately above 1.0: the bloom pass
// thresholds at 1.0 in linear HDR, so this is what actually glows. Lit
// surfaces stay below it and are left alone.
const borderMat = new THREE.MeshStandardMaterial({
    color: 0xc8a030,
    roughness: 0.3,
    metalness: 0.6,
    emissive: 0xc8a030,
    emissiveIntensity: lp.goldEmissive,
});

// === Rebuildable table layer (cloth + zone overlay + gold border bars) ===
let tableGroup: THREE.Group | null = null;
let zoneMesh: THREE.Mesh | null = null;

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
    zone.visible = lp.showZones;
    zoneMesh = zone;
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

// === Contact shadows =====================================================
// A soft pool under every tile that rests on the table. Footprints are read
// from world-space bounding boxes, so flat / standing / sideways tiles all work
// without special cases. One InstancedMesh, one draw call.
const contactShadows = new ContactShadows(scene, {
    opacity: lp.contactShadowOpacity,
    spread: lp.contactShadowSpread,
});

// Rebuilt at most once per frame, on demand: tiles arrive asynchronously and
// discards fly in under gsap, so positions are not final when they are created.
let contactShadowsDirty = true;
function refreshContactShadows(): void {
    contactShadowsDirty = true;
}

/**
 * Tile meshes belonging to the main scene. The overlay hand lives in its own
 * screen-space scene hundreds of units below the table and must be excluded —
 * otherwise its tiles pass the "resting on the table" test on a technicality
 * and scatter shadow quads across the frame.
 */
function* tableTileMeshes(): Generator<THREE.Object3D> {
    for (const tile of liveTiles) {
        let root: THREE.Object3D = tile.mesh;
        while (root.parent) root = root.parent;
        if (root === scene) yield tile.mesh;
    }
}

// === Four-seat layout (each rotated 90° around the table) ===
// Seat order: 南 / 西 / 北 / 东. All positions below are in the local south
// frame (+Z toward the south edge); the per-seat group rotation places them.
const SEAT_ROTATIONS = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
const RIVER_COLS = 6;
const HAND_COUNT = 13;
const MELDS_PER_SEAT = 2; // 每家展示的副露组数（每组让手牌减少 3 张）
const DEMO_RIVER_COUNT = 24; // 演示极端牌河（>18 触发换行策略）

const seatGroups: THREE.Group[] = [];

// === Live tile registry ===
// Every Tile3D currently in either scene. Two jobs:
//   1. lets the material GUI drive shader uniforms (rim, saturation) on tiles
//      that already exist, instead of rebuilding all ~140 of them per slider
//      tick;
//   2. gives rebuild() something to call dispose() on. Each Tile3D owns three
//      MeshStandardMaterials with injected programs; the old teardown only
//      disposed geometry, so every rebuild leaked ~420 materials — and almost
//      every GUI control triggers a rebuild.
const liveTiles = new Set<Tile3D>();

function trackTile(tile: Tile3D): Tile3D {
    liveTiles.add(tile);
    return tile;
}

function forEachTile(fn: (tile: Tile3D) => void): void {
    for (const tile of liveTiles) fn(tile);
}

/** Dispose and forget a single tile (geometry + its three materials). */
function releaseTile(tile: Tile3D): void {
    liveTiles.delete(tile);
    tile.dispose();
}

/** Dispose every tracked tile. Textures are shared caches and survive. */
function releaseAllTiles(): void {
    for (const tile of liveTiles) tile.dispose();
    liveTiles.clear();
}

/**
 * TileSet spec for a tile of the given physical size, with every appearance
 * value pulled from `lp`. `scale` only affects the corner radius, which is
 * authored in base-tile mm and has to track the tile's size.
 *
 * Previously each of the six creation sites carried its own copy of this
 * object literal, so a new appearance parameter meant editing six blocks.
 */
function tileSetFor(width: number, height: number, depth: number, scale: number): TileSet {
    return new TileSet({
        width,
        height,
        depth,
        radius: lp.tileRadius * scale,
        bgColor: lp.tileBgColor,
        saturation: lp.tileSaturation,
        faceRoughness: lp.faceRoughness,
        sideTopColor: lp.sideTopColor,
        sideBottomColor: lp.sideBottomColor,
        sideBottomHeight: lp.sideBottomHeight,
        rimIntensity: lp.rimIntensity,
        rimColor: lp.rimColor,
        useSdfGlyph: lp.useSdfGlyph,
        glyphWeight: lp.glyphWeight,
        glyphWeightScale: lp.glyphWeightScale,
        specHard: lp.specHard,
        specThreshold: lp.specThreshold,
        specSoftness: lp.specSoftness,
        specIntensity: lp.specIntensity,
        specColor: lp.specColor,
        specEnvScale: lp.specEnvScale,
        inkSpecSuppress: lp.inkSpecSuppress,
        ramp: lp.ramp,
        rampSides: lp.rampSides,
        rampSteps: lp.rampSteps,
        rampSoftness: lp.rampSoftness,
        rampFloor: lp.rampFloor,
        rampRange: lp.rampRange,
        rampShadowTint: lp.rampShadowTint,
        outline: lp.outline,
        outlineWidth: lp.outlineWidth,
        outlineColor: lp.outlineColor,
        outlineShadowBoost: lp.outlineShadowBoost,
        outlineLitScale: lp.outlineLitScale,
        outlineFarScale: lp.outlineFarScale,
    });
}

// === 南家屏幕 overlay 手牌（独立正交场景，渲染在主画面之上）===
// 南家手牌脱离桌面 3D 场景，用正交相机在屏幕空间底部居中绘制，
// 牌大小由 handTileScale 控制（与桌面 tileScale 解耦）。
const handScene = new THREE.Scene();
const handCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
handCamera.position.z = 100;

// The overlay hand used to be lit by a single AmbientLight. Ambient is
// perfectly uniform: a MeshStandardMaterial under it alone has no gradient, no
// highlight, and its normals do nothing — the tiles come out as flat colour
// swatches. These are the tiles the player looks at ~90% of the time, so they
// need a real key direction like anything else.
//
// Rig and values mirror the table's (see applyHandLights): same warm key, same
// cool directional fill, same hemisphere and environment. The tiles here are
// rotated to face the camera, so the key sits up-and-left of the viewer to put
// the gradient across the glyph face.
const handAmbient = new THREE.AmbientLight(0x8fa8d8, 0);
const handKeyLight = new THREE.DirectionalLight(0xffffff, 0);
handKeyLight.position.set(-0.45, 0.85, 1);
const handFillLight = new THREE.DirectionalLight(0xffffff, 0);
handFillLight.position.set(0.7, -0.3, 0.6);
const handHemiLight = new THREE.HemisphereLight(0xffffff, 0x000000, 0);
handScene.add(handAmbient, handKeyLight, handFillLight, handHemiLight);
handScene.environment = envTexture;
handScene.environmentIntensity = lp.iblIntensity;

// === Post-processing =====================================================
// Bloom + colour grade over the table. The overlay hand is drawn separately, in
// the render loop, straight to the canvas after the chain — see post.ts.
const post = createPostChain(renderer, scene, camera);

/**
 * Push the table's lighting values into the overlay hand scene, scaled by
 * `handLightBoost`. One set of numbers drives the whole picture, so the table
 * and the overlay cannot drift apart.
 */
function applyHandLights(): void {
    const k = lp.handLightBoost;
    handKeyLight.intensity = lp.mainLight * k;
    handKeyLight.color.set(lp.mainLightColor);
    handFillLight.intensity = lp.fillLight * k;
    handFillLight.color.set(lp.fillLightColor);
    handAmbient.intensity = lp.ambient * k;
    handHemiLight.intensity = lp.hemiIntensity * k;
    handHemiLight.color.set(lp.hemiSkyColor);
    handHemiLight.groundColor.set(lp.hemiGroundColor);
}
const cameraHandGroup = new THREE.Group();
handScene.add(cameraHandGroup);
// 南家 overlay 手牌 mesh 引用（用于 raycast 点击）
const handTiles: THREE.Mesh[] = [];
// The Tile3D behind each entry of `handTiles`, so teardown can go through
// releaseTile. Disposing `mesh.geometry` directly is wrong now that geometry is
// shared from a refcounted cache: the overlay tiles all share one entry, so the
// first dispose frees a buffer the other seven are still drawing with.
const handTileObjects: Tile3D[] = [];

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
    const sideTex = factory.getSideTexture(lp.sideBottomColor, lp.sideTopColor, lp.sideBottomHeight);
    const stand = lp.opponentHandStand && seat !== 0;
    const handCount = HAND_COUNT - MELDS_PER_SEAT * 3;
    const handLeftX = calcHandLeftX();
    for (let i = 0; i < handCount; i++) {
        const tile = trackTile(new Tile3D(tileSetFor(TILE_W, TILE_H, TILE_D, lp.tileScale)));
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
        const tile = trackTile(new Tile3D(tileSetFor(TILE_W, TILE_H, TILE_D, lp.tileScale)));
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
    // 清空旧手牌。走 releaseTile 而不是直接 dispose 几何体 —— 几何体来自引用计数的
    // 共享缓存，直接 dispose 会释放其他 7 张牌还在用的顶点缓冲。
    for (const tile of handTileObjects) {
        tile.mesh.parent?.remove(tile.mesh);
        releaseTile(tile);
    }
    handTiles.length = 0;
    handTileObjects.length = 0;

    const hs = calcHandScale();
    const hw = BASE_TILE_W * hs;
    const hh = BASE_TILE_H * hs;
    const hd = BASE_TILE_D * hs;
    const radius = lp.tileRadius * hs;
    const handStep = hw + 0.5 * hs;
    const handDrawnGap = hw * 0.35;
    const sideTex = factory.getSideTexture(lp.sideBottomColor, lp.sideTopColor, lp.sideBottomHeight);

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
        const tile = trackTile(new Tile3D(tileSetFor(hw, hh, hd, hs)));
        await tile.setCode(getDemoCode(), factory);
        tile.setSideTexture(sideTex);
        await tile.setBack(factory);
        // 立式面向摄像机（+Z）：rotation.x = π/2 把 +Y 花色面转到 +Z
        tile.mesh.rotation.x = Math.PI / 2;
        tile.setPosition(x, y, 0);
        cameraHandGroup.add(tile.mesh);
        handTiles.push(tile.mesh);
        handTileObjects.push(tile);
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
    const sideTex = factory.getSideTexture(lp.sideBottomColor, lp.sideTopColor, lp.sideBottomHeight);
    const stepX = TILE_W + lp.tileGap * lp.tileScale; // river column step (live-tunable; gap scales with tileScale)
    for (let i = 0; i < DEMO_RIVER_COUNT; i++) {
        const slot = calcRiverSlot(i, lp.riverWallRemaining, lp.riverMode);
        const tile = trackTile(new Tile3D(tileSetFor(TILE_W, TILE_H, TILE_D, lp.tileScale)));
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

    const sideTex = factory.getSideTexture(lp.sideBottomColor, lp.sideTopColor, lp.sideBottomHeight);
    const tile = trackTile(new Tile3D(tileSetFor(TILE_W, TILE_H, TILE_D, lp.tileScale)));
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
        refreshContactShadows();
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
            refreshContactShadows();
        },
    });

    southRiver.push({ code, tile, riichi });
}

/** 清空南家牌河：从父节点移除每张牌并释放其几何体（材质 / 纹理为共享缓存，不释放）。 */
function clearSouthRiver(): void {
    for (const { tile } of southRiver) {
        tile.mesh.parent?.remove(tile.mesh);
        releaseTile(tile);
    }
    southRiver.length = 0;
    refreshContactShadows();
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
    const meldTileSet = tileSetFor(tileW, tileH, tileD, meldTs);
    const sideTex = factory.getSideTexture(lp.sideBottomColor, lp.sideTopColor, lp.sideBottomHeight);
    const specs = getMeldConfig(type);

    const tiles: Tile3D[] = [];
    // 累加式 X 排列：从 groupStartX（本组左边缘）开始，按每张牌的实际 X 宽度
    // 推进 cursor。横放牌占 tileD、竖放牌占 tileW。
    let cursorX = groupStartX;
    let slot0X = 0; // slot 0 中心，供 kakan 第 4 张复用（X 相同）
    let firstSidewaysZ = 0; // 第 1 张横放牌中心 Z，供 kakan 第 4 张 Z 负方向紧贴
    for (const spec of specs) {
        const tile = trackTile(new Tile3D(meldTileSet));
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
    refreshContactShadows();
}

/** 清空南家副露：从父节点移除每张牌并释放几何体（材质 / 纹理为共享缓存，不释放）。 */
function clearMelds(): void {
    for (const meld of southMelds) {
        for (const tile of meld.tiles) {
            tile.mesh.parent?.remove(tile.mesh);
            releaseTile(tile);
        }
    }
    southMelds.length = 0;
    refreshContactShadows();
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

    refreshContactShadows();
}

/**
 * Detach a seat group. Its meshes are all tile meshes, and their geometry and
 * materials are released through the tile registry (releaseAllTiles), so there
 * is nothing to dispose here.
 */
function disposeGroup(g: THREE.Object3D): void {
    scene.remove(g);
}

// === Rebuild: tear down the table, seats and decoupled hand, then reconstruct ===
function rebuild(): void {
    for (const g of seatGroups) disposeGroup(g);
    seatGroups.length = 0;
    // 清掉南家 overlay 手牌（不在 seatGroups 里，需单独从 cameraHandGroup 摘下）
    for (const mesh of handTiles) cameraHandGroup.remove(mesh);
    handTiles.length = 0;
    handTileObjects.length = 0;
    // 释放所有牌的几何体 + 材质。必须在 init() 之前 —— init() 会用保存的
    // code / type 序列重建南家牌河和副露，届时 southRiver / southMelds 里
    // 还持有旧 Tile3D 引用。
    releaseAllTiles();
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
// Every light control routes through applyVisuals so the table and the overlay
// hand stay locked to the same values.
visualFolder.add(lp, 'mainLight', 0, 6, 0.01).name('主光源 (暖)').onChange(applyVisuals);
visualFolder.addColor(lp, 'mainLightColor').name('主光颜色').onChange(applyVisuals);
visualFolder.add(lp, 'fillLight', 0, 3, 0.01).name('补光 (冷)').onChange(applyVisuals);
visualFolder.addColor(lp, 'fillLightColor').name('补光颜色').onChange(applyVisuals);
visualFolder.add(lp, 'ambient', 0, 5, 0.01).name('环境光').onChange(applyVisuals);
visualFolder.add(lp, 'handLightBoost', 0.5, 2, 0.01).name('手牌亮度倍率').onChange(applyVisuals);
visualFolder.addColor(lp, 'tableColor').name('桌布颜色').onChange(applyVisuals);
visualFolder.add(lp, 'fogNearScale', 0.4, 1.2, 0.01).name('雾起点 ×距离').onChange(applyVisuals);
visualFolder.add(lp, 'fogFarScale', 1.2, 6, 0.05).name('雾终点 ×距离').onChange(applyVisuals);
visualFolder.addColor(lp, 'fogColor').name('雾色').onChange(applyVisuals);
visualFolder.add(lp, 'showZones').name('座位分区叠层').onChange((v: boolean) => {
    if (zoneMesh) zoneMesh.visible = v;
});
visualFolder.add(lp, 'feltDetail').name('桌布纹理').onChange((v: boolean) => {
    tableMat.map = v ? feltDetailTexture : null;
    tableMat.needsUpdate = true; // toggles USE_MAP, so the program changes
});
// Regenerating a 1024^2 canvas with per-pixel noise is too slow for every drag
// tick, so these commit on release. `onChange` also fires so a drag still updates
// `lp` live, and the staleness guard makes the eventual rebuild a no-op if the
// value came back to where it started.
visualFolder
    .add(lp, 'feltMottle', 0, 0.15, 0.002)
    .name('斑驳幅度')
    .onFinishChange(maybeRebuildFeltDetail);
visualFolder
    .add(lp, 'feltVignette', 0, 0.6, 0.01)
    .name('桌布渐晕')
    .onFinishChange(maybeRebuildFeltDetail);
visualFolder.add(lp, 'feltNap', 0, 3, 0.05).name('绒毛强度 ⚡').onChange((v: number) => {
    tableMat.normalScale.set(v, v);
});
visualFolder.add(lp, 'feltNapRepeat', 4, 60, 1).name('绒毛密度 ⚡').onChange((v: number) => {
    feltNapTexture.repeat.set(v, v);
});
visualFolder.add(lp, 'feltSheen', 0, 1.5, 0.02).name('布面光泽 ⚡').onChange((v: number) => {
    tableMat.sheen = v;
});
visualFolder.add(lp, 'feltSheenRough', 0.05, 1, 0.02).name('光泽粗糙度 ⚡').onChange((v: number) => {
    tableMat.sheenRoughness = v;
});
visualFolder.addColor(lp, 'feltSheenColor').name('光泽颜色 ⚡').onChange((v: string) => {
    tableMat.sheenColor.set(v);
});
visualFolder.add(lp, 'hemiIntensity', 0, 4, 0.01).name('半球光强度').onChange(applyVisuals);
visualFolder.addColor(lp, 'hemiSkyColor').name('天空色 (冷)').onChange(applyVisuals);
visualFolder.addColor(lp, 'hemiGroundColor').name('地面色 (暖反弹)').onChange(applyVisuals);
visualFolder.add(lp, 'showAxes').name('坐标轴').onChange((v: boolean) => {
    axisGroup.visible = v;
    for (const label of axisLabels) label.visible = v;
});

// === 硬边高光 ===
const specFolder = gui.addFolder('💎 硬边高光');
specFolder.close();
specFolder.add(lp, 'specHard').name('硬边高光 ⚡').onChange((v: boolean) => {
    forEachTile((t) => t.setSpecular({ hard: v }));
});
specFolder.add(lp, 'specThreshold', 0.002, 0.4, 0.002).name('阈值 ⚡').onChange((v: number) => {
    forEachTile((t) => t.setSpecular({ threshold: v }));
});
specFolder.add(lp, 'specSoftness', 0.01, 1, 0.01).name('边缘柔度 ⚡').onChange((v: number) => {
    forEachTile((t) => t.setSpecular({ softness: v }));
});
specFolder.add(lp, 'specIntensity', 0, 2, 0.01).name('高光亮度 ⚡').onChange((v: number) => {
    forEachTile((t) => t.setSpecular({ intensity: v }));
});
specFolder.addColor(lp, 'specColor').name('高光颜色 ⚡').onChange((v: string) => {
    forEachTile((t) => t.setSpecular({ color: v }));
});
specFolder.add(lp, 'specEnvScale', 0, 1.5, 0.01).name('环境高光 ⚡').onChange((v: number) => {
    forEachTile((t) => t.setSpecular({ envScale: v }));
});
specFolder.add(lp, 'inkSpecSuppress', 0, 1, 0.02).name('笔画不吃高光 ⚡').onChange((v: number) => {
    forEachTile((t) => t.setSpecular({ inkSuppress: v }));
});

// === Cel ramp ===
// 除「侧面也阶跃」外全部是 uniform，实时生效。
const rampFolder = gui.addFolder('🎞️ 明暗阶跃');
rampFolder.close();
rampFolder.add(lp, 'ramp').name('阶跃化 ⚡').onChange((v: boolean) => {
    forEachTile((t) => t.setRamp({ enabled: v }));
});
rampFolder.add(lp, 'rampSteps', 1, 6, 1).name('阶数 ⚡').onChange((v: number) => {
    forEachTile((t) => t.setRamp({ steps: v }));
});
rampFolder.add(lp, 'rampSoftness', 0.002, 0.3, 0.002).name('边缘柔度 ⚡').onChange((v: number) => {
    forEachTile((t) => t.setRamp({ softness: v }));
});
rampFolder.add(lp, 'rampFloor', 0.2, 1, 0.01).name('暗部下限 ⚡').onChange((v: number) => {
    forEachTile((t) => t.setRamp({ floor: v }));
});
rampFolder.add(lp, 'rampRange', 0.3, 1.5, 0.01).name('亮部参考 ⚡').onChange((v: number) => {
    forEachTile((t) => t.setRamp({ range: v }));
});
rampFolder.addColor(lp, 'rampShadowTint').name('暗部色调 ⚡').onChange((v: string) => {
    forEachTile((t) => t.setRamp({ shadowTint: v }));
});
rampFolder.add(lp, 'rampSides').name('侧面也阶跃（重建）').onChange(rebuild);

// === 描边 ===
// 全部实时生效（宽度/颜色是 uniform，开关是 mesh.visible），不触发 rebuild。
const outlineFolder = gui.addFolder('✒️ 描边');
outlineFolder.close();
outlineFolder.add(lp, 'outline').name('描边 ⚡').onChange((v: boolean) => {
    forEachTile((t) => t.setOutlineEnabled(v));
});
outlineFolder.add(lp, 'outlineWidth', 0, 8, 0.1).name('线宽 (device px) ⚡').onChange((v: number) => {
    forEachTile((t) => t.setOutlineWidth(v));
});
outlineFolder.add(lp, 'outlineShadowBoost', 0.5, 3, 0.05).name('背光侧线重 ⚡').onChange((v: number) => {
    forEachTile((t) => t.setOutlineWeighting({ shadowBoost: v }));
});
outlineFolder.add(lp, 'outlineLitScale', 0, 1.5, 0.05).name('受光侧线重 ⚡').onChange((v: number) => {
    forEachTile((t) => t.setOutlineWeighting({ litScale: v }));
});
outlineFolder.add(lp, 'outlineFarScale', 0.2, 1.5, 0.05).name('远处线重 ⚡').onChange((v: number) => {
    forEachTile((t) => t.setOutlineWeighting({ farScale: v }));
});
outlineFolder.addColor(lp, 'outlineColor').name('线色 ⚡').onChange((v: string) => {
    forEachTile((t) => t.setOutlineColor(v));
});

// === 阴影 ===
// 接触阴影 = 贴在桌面上的软光斑，与光照方向无关。shadow map = 有角度的斜影。
// 两者可以单独开关，方便直接对比。
const shadowFolder = gui.addFolder('🌑 阴影');
shadowFolder.close();
shadowFolder.add(lp, 'contactShadows').name('接触阴影').onChange(applyVisuals);
shadowFolder.add(lp, 'contactShadowOpacity', 0, 1, 0.01).name('阴影浓度').onChange(applyVisuals);
shadowFolder.add(lp, 'contactShadowSpread', 1, 2.2, 0.01).name('阴影扩散').onChange(applyVisuals);
shadowFolder.add(lp, 'castShadows').name('斜向投影 (shadow map)').onChange(applyVisuals);

// === 后处理 ===
const postFolder = gui.addFolder('✨ 后处理');
postFolder.close();
postFolder.add(lp, 'enabled').name('启用后处理').onChange(applyVisuals);
postFolder.add(lp, 'exposure', 0.1, 3, 0.01).name('曝光').onChange(applyVisuals);
postFolder.add(lp, 'bloomStrength', 0, 2, 0.01).name('Bloom 强度').onChange(applyVisuals);
postFolder.add(lp, 'bloomRadius', 0, 1.5, 0.01).name('Bloom 半径').onChange(applyVisuals);
postFolder
    .add(lp, 'bloomThreshold', 0, 2, 0.01)
    .name('Bloom 阈值')
    .onChange(applyVisuals);
postFolder.add(lp, 'goldEmissive', 0, 4, 0.05).name('金边发光').onChange(applyVisuals);
postFolder.add(lp, 'saturation', 0, 2, 0.01).name('饱和度').onChange(applyVisuals);
postFolder.add(lp, 'contrast', 0.5, 2, 0.01).name('对比度').onChange(applyVisuals);
postFolder.add(lp, 'contrastPivot', 0.01, 0.3, 0.005).name('对比支点').onChange(applyVisuals);
postFolder.add(lp, 'lift', 0, 0.15, 0.002).name('抬黑场').onChange(applyVisuals);
postFolder.add(lp, 'splitTone', 0, 0.5, 0.01).name('冷暖分离').onChange(applyVisuals);
postFolder.add(lp, 'vignette', 0, 1, 0.01).name('暗角').onChange(applyVisuals);
postFolder.add(lp, 'grain', 0, 0.05, 0.001).name('颗粒').onChange(applyVisuals);
// Pass switches, for bisecting the chain when an artefact appears in it.
postFolder.add(lp, 'bloomEnabled').name('· Bloom pass（默认关，见 post.ts）').onChange(applyVisuals);
postFolder.add(lp, 'gradeEnabled').name('· 调色 pass').onChange(applyVisuals);
postFolder.add(lp, 'smaaEnabled').name('· SMAA pass').onChange(applyVisuals);

// === 材质 controls ===
// Rim 强度 / Rim 颜色 / 花色饱和度 are shader uniforms, so they apply live to
// every existing tile. Only the values baked into a texture or into the
// geometry (side gradient, corner radius, face colour) still need a rebuild.
const materialFolder = gui.addFolder('🎨 材质');
materialFolder.close();
materialFolder.addColor(lp, 'tileBgColor').name('牌面底色').onChange(rebuild);
materialFolder.addColor(lp, 'sideTopColor').name('侧面cream色').onChange(rebuild);
materialFolder.addColor(lp, 'sideBottomColor').name('侧面金色').onChange(rebuild);
materialFolder.add(lp, 'tileSaturation', 0, 2, 0.01).name('花色饱和度 ⚡').onChange((v: number) => {
    forEachTile((t) => t.setGlyphSaturation(v));
});
materialFolder.add(lp, 'rimIntensity', 0, 2, 0.01).name('Rim强度 ⚡').onChange((v: number) => {
    forEachTile((t) => t.setRimIntensity(v));
});
materialFolder.addColor(lp, 'rimColor').name('Rim颜色 ⚡').onChange((v: string) => {
    forEachTile((t) => t.setRimColor(v));
});
materialFolder.add(lp, 'faceRoughness', 0, 1, 0.01).name('牌面粗糙度 ⚡').onChange((v: number) => {
    forEachTile((t) => {
        (t.materials[2] as THREE.MeshStandardMaterial).roughness = v;
    });
});
materialFolder
    .add(lp, 'useSdfGlyph')
    .name('SDF 花色边缘 ⚡')
    .onChange((v: boolean) => {
        // The field itself is only fetched when a tile is built with SDF on, so
        // switching it on for the first time needs a rebuild; switching off is
        // just a uniform.
        if (v) rebuild();
        else forEachTile((t) => t.setSdfEnabled(false));
    });
materialFolder.add(lp, 'glyphWeight', -0.05, 0.08, 0.001).name('笔画粗细(默认档) ⚡').onChange((v: number) => {
    forEachTile((t) => t.setGlyphWeight(v));
});
materialFolder.add(lp, 'glyphWeightScale', 0, 2.5, 0.05).name('粗细整体倍率 ⚡').onChange((v: number) => {
    forEachTile((t) => t.setGlyphWeightScale(v));
});
materialFolder.add(lp, 'tileRadius', 0.5, 5, 0.1).name('圆角半径').onChange(rebuild);
materialFolder.add(lp, 'sideBottomHeight', 1, 15, 0.5).name('侧面金色高度').onChange(rebuild);
materialFolder.add(lp, 'iblIntensity', 0, 3, 0.05).name('IBL强度 ⚡').onChange((v: number) => {
    scene.environmentIntensity = v;
    handScene.environmentIntensity = v;
});
materialFolder.add(lp, 'toneExposure', 0.1, 3, 0.01).name('曝光 ⚡').onChange((v: number) => {
    renderer.toneMappingExposure = v;
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

// === Debug handle ===
// Exposed so the scene can be inspected and driven from the console (and by
// screenshot tooling) without reaching into lil-gui's DOM.
(window as unknown as Record<string, unknown>).__tableDebug = {
    scene,
    handScene,
    camera,
    handCamera,
    renderer,
    controls,
    lights: {
        dirLight,
        fillLight,
        ambient,
        hemiLight,
        handKeyLight,
        handFillLight,
        handAmbient,
        handHemiLight,
    },
    lp,
    liveTiles,
    contactShadows,
    post,
    tileGeometryCacheSize,
    rebuild,
    rebuildFeltDetail,
    maybeRebuildFeltDetail,
    applyVisuals,
    updateCamera,
    syncGUI,
};

// === Resize ===
let resizeTimer: number | null = null;
window.addEventListener('resize', () => {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    post.setSize(window.innerWidth, window.innerHeight);
    setOutlineViewport(
        window.innerWidth * renderer.getPixelRatio(),
        window.innerHeight * renderer.getPixelRatio(),
    );
    updateHandCamera();

    // Only the screen-space hand is relaid out — not the whole table.
    //
    // Nothing about the table depends on the viewport: seat layout, river, melds and
    // walls are all in table millimetres. The only viewport-dependent thing is the
    // overlay hand, whose Y comes from window.innerHeight. Rebuilding everything
    // meant a resize threw away 131 tiles and rebuilt them — measured at a 90ms
    // stall, i.e. 5-11 dropped frames, during which the canvas shows nothing and the
    // page's near-black background (#050505) shows through. That is very likely the
    // black flash seen while dragging a window.
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
        void buildCameraHand().catch((err) => console.error('[table] hand relayout failed:', err));
    }, 120);
});

// === Render loop ===
// 主场景 + overlay 手牌都交给 EffectComposer（两个 RenderPass，第二个
// clear=false / clearDepth=true），所以不再需要手动 autoClear 双渲染。
// 关掉 post 时退回直接渲染，用于对比。
function animate(): void {
    requestAnimationFrame(animate);
    controls.update();

    if (contactShadowsDirty) {
        contactShadows.update(tableTileMeshes());
        contactShadowsDirty = false;
    }

    if (lp.enabled) {
        renderer.autoClear = true;
        post.composer.render();
        // Overlay hand straight to the canvas, outside the composer. Depth is
        // cleared so it always draws in front; colour is kept so the graded table
        // stays underneath.
        renderer.autoClear = false;
        renderer.clearDepth();
        renderer.render(handScene, handCamera);
    } else {
        renderer.autoClear = false;
        renderer.clear();
        renderer.render(scene, camera);
        renderer.clearDepth();
        renderer.render(handScene, handCamera);
    }
}
animate();

// Push lp into the scene once at startup — the overlay hand's lights start at
// intensity 0 and are driven entirely from here.
applyVisuals();

init()
    .then(async () => {
        // 初始放 6 张弃牌，让南家牌河有起始状态（可继续点「弃牌」追加）。
        for (let i = 0; i < 6; i++) await addRiverTile(undefined, false, false);
    })
    .catch((err) => console.error('[table] init failed:', err));
