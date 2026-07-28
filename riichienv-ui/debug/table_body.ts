import * as THREE from 'three';
import { STAGE_TOP_Y } from './arena.js';

/**
 * Octagonal obsidian altar: black felt playing surface with gold inlay
 * lines, a metal octagonal rim with a glowing gold trim strip, and a
 * tapered 8-sided pedestal dropping to the stage with a gold base ring.
 *
 * The octagon has 4 long sides (the seat sides, facing ±X/±Z) and 4
 * short diagonal sides. Surface top is y=0.
 */

const SURF_HALF = 500; // playing surface flat-to-flat = 1000mm
const SURF_CUT = 180;  // corner cut along each edge → long side 640, diagonal ~255
const RIM_OVERHANG = 55;
const RIM_TOP = 22;
const RIM_BOTTOM = -20;

/** Octagon vertices in shape space (x, y), starting at the +y long side. */
function octagonPoints(half: number, cut: number): [number, number][] {
    return [
        [half - cut, half],
        [-(half - cut), half],
        [-half, half - cut],
        [-half, -(half - cut)],
        [-(half - cut), -half],
        [half - cut, -half],
        [half, -(half - cut)],
        [half, half - cut],
    ];
}

function octagonShape(half: number, cut: number): THREE.Shape {
    const pts = octagonPoints(half, cut);
    const shape = new THREE.Shape();
    shape.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
    shape.closePath();
    return shape;
}

function octagonPath(half: number, cut: number): THREE.Path {
    const pts = octagonPoints(half, cut);
    const path = new THREE.Path();
    path.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) path.lineTo(pts[i][0], pts[i][1]);
    path.closePath();
    return path;
}

/** Uniform outward offset (d > 0 grows, d < 0 shrinks). */
function offsetOctagon(half: number, cut: number, d: number): { half: number; cut: number } {
    const h2 = half + d;
    const c2 = cut + d * (2 - Math.SQRT2);
    return { half: h2, cut: c2 };
}

/** Black felt: dark base + fine noise + radial vignette + gold inlays. */
function makeFeltTexture(): THREE.CanvasTexture {
    const S = 512;
    const canvas = document.createElement('canvas');
    canvas.width = S;
    canvas.height = S;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('table_body: 2d context unavailable');

    ctx.fillStyle = '#0c0c0e';
    ctx.fillRect(0, 0, S, S);

    // Fine noise, ±5% brightness.
    const img = ctx.getImageData(0, 0, S, S);
    const data = img.data;
    for (let i = 0; i < data.length; i += 4) {
        const n = (Math.random() - 0.5) * 0.1 * 255;
        data[i] = Math.max(0, Math.min(255, data[i] + n));
        data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + n));
        data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + n));
    }
    ctx.putImageData(img, 0, 0);

    // Radial vignette: edges sink into darkness.
    const vg = ctx.createRadialGradient(S / 2, S / 2, S * 0.18, S / 2, S / 2, S * 0.52);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.38)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, S, S);

    const gold = '#c9a227';
    ctx.strokeStyle = gold;
    ctx.shadowColor = gold;

    // Central discard-area square: 340mm of 1000mm → 0.34 * S.
    const sq = S * 0.34;
    ctx.lineWidth = 3;
    ctx.shadowBlur = 14;
    ctx.strokeRect((S - sq) / 2, (S - sq) / 2, sq, sq);

    // One short gold line inside each seat edge (~90mm in from the edge).
    const len = S * 0.24;
    const inset = S * 0.09;
    ctx.lineWidth = 2;
    ctx.shadowBlur = 8;
    ctx.globalAlpha = 0.85;
    for (const [x1, y1, x2, y2] of [
        [S / 2 - len / 2, inset, S / 2 + len / 2, inset],
        [S / 2 - len / 2, S - inset, S / 2 + len / 2, S - inset],
        [inset, S / 2 - len / 2, inset, S / 2 + len / 2],
        [S - inset, S / 2 - len / 2, S - inset, S / 2 + len / 2],
    ] as [number, number, number, number][]) {
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
    }
    ctx.globalAlpha = 1;

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    // ShapeGeometry UVs are raw shape coordinates (mm, ±SURF_HALF).
    const span = SURF_HALF * 2;
    texture.repeat.set(1 / span, 1 / span);
    texture.offset.set(0.5, 0.5);
    return texture;
}

export function buildTableBody(parent: THREE.Object3D): THREE.Group {
    const group = new THREE.Group();
    group.name = 'table-body';

    // --- Playing surface (felt) ----------------------------------------
    const felt = new THREE.Mesh(
        new THREE.ShapeGeometry(octagonShape(SURF_HALF, SURF_CUT)),
        new THREE.MeshStandardMaterial({ map: makeFeltTexture(), roughness: 0.9, metalness: 0.02 }),
    );
    felt.rotation.x = -Math.PI / 2;
    felt.receiveShadow = true;
    group.add(felt);

    // --- Metal rim (octagonal ring) -------------------------------------
    const rimOuter = offsetOctagon(SURF_HALF, SURF_CUT, RIM_OVERHANG);
    const rimShape = octagonShape(rimOuter.half, rimOuter.cut);
    rimShape.holes.push(octagonPath(SURF_HALF, SURF_CUT));
    const rim = new THREE.Mesh(
        new THREE.ExtrudeGeometry(rimShape, { depth: RIM_TOP - RIM_BOTTOM, bevelEnabled: false }),
        new THREE.MeshStandardMaterial({ color: 0x0d0d0f, roughness: 0.42, metalness: 0.85 }),
    );
    rim.rotation.x = -Math.PI / 2;
    rim.position.y = RIM_BOTTOM;
    rim.castShadow = true;
    rim.receiveShadow = true;
    group.add(rim);

    // --- Glowing gold trim strip on the rim's top outer edge ------------
    const trimInner = offsetOctagon(rimOuter.half, rimOuter.cut, -7);
    const trimShape = octagonShape(rimOuter.half, rimOuter.cut);
    trimShape.holes.push(octagonPath(trimInner.half, trimInner.cut));
    const trim = new THREE.Mesh(
        new THREE.ExtrudeGeometry(trimShape, { depth: 2, bevelEnabled: false }),
        new THREE.MeshStandardMaterial({
            color: 0xd4af37,
            emissive: 0xd4af37,
            emissiveIntensity: 0.35,
            roughness: 0.3,
            metalness: 1,
        }),
    );
    trim.rotation.x = -Math.PI / 2;
    trim.position.y = RIM_TOP;
    group.add(trim);

    // --- Underside slab closing the table bottom -------------------------
    const slab = new THREE.Mesh(
        new THREE.CylinderGeometry(500 / Math.cos(Math.PI / 8), 500 / Math.cos(Math.PI / 8), 19.5, 8, 1),
        new THREE.MeshStandardMaterial({ color: 0x0b0b0d, roughness: 0.5, metalness: 0.7 }),
    );
    slab.rotation.y = Math.PI / 8;
    slab.position.y = -10.25; // top at -0.5, just below the felt (no z-fight)
    slab.castShadow = true;
    group.add(slab);

    // --- Tapered pedestal (8-sided frustum) ------------------------------
    const pedestalH = RIM_BOTTOM - STAGE_TOP_Y; // 230
    const pedestal = new THREE.Mesh(
        new THREE.CylinderGeometry(430, 310, pedestalH, 8, 1),
        new THREE.MeshStandardMaterial({ color: 0x0c0c0e, roughness: 0.55, metalness: 0.8 }),
    );
    pedestal.rotation.y = Math.PI / 8; // flats face the seat directions
    pedestal.position.y = STAGE_TOP_Y + pedestalH / 2;
    pedestal.castShadow = true;
    pedestal.receiveShadow = true;
    group.add(pedestal);

    // --- Gold base ring at the foot --------------------------------------
    const base = new THREE.Mesh(
        new THREE.CylinderGeometry(335, 345, 12, 8, 1),
        new THREE.MeshStandardMaterial({
            color: 0xd4af37,
            emissive: 0xd4af37,
            emissiveIntensity: 0.18,
            roughness: 0.32,
            metalness: 1,
        }),
    );
    base.rotation.y = Math.PI / 8;
    base.position.y = STAGE_TOP_Y + 6;
    base.castShadow = true;
    group.add(base);

    parent.add(group);
    return group;
}
