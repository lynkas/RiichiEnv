import * as THREE from 'three';
import { RIM_BOTTOM, RIM_OVERHANG, RIM_TOP, STAGE_TOP_Y, SURF_CUT, SURF_HALF } from './layout.js';

/**
 * Octagonal mahjong table: green felt playing surface with subtle gold
 * inlay lines, a metal octagonal rim with a thin gold trim, and a
 * tapered 8-sided pedestal dropping to the stage. Surface top is y=0.
 *
 * All proportions come from layout.ts (SURF_HALF / SURF_CUT); the
 * pedestal radii scale with the surface so the whole body tracks
 * TABLE_SIZE automatically.
 */

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

/** Green felt: dark green base + fine noise + mild vignette + dim gold inlays. */
function makeFeltTexture(): THREE.CanvasTexture {
    const S = 512;
    const canvas = document.createElement('canvas');
    canvas.width = S;
    canvas.height = S;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('table_body: 2d context unavailable');

    ctx.fillStyle = '#0d2818';
    ctx.fillRect(0, 0, S, S);

    // Fine noise, +/-4% brightness.
    const img = ctx.getImageData(0, 0, S, S);
    const data = img.data;
    for (let i = 0; i < data.length; i += 4) {
        const n = (Math.random() - 0.5) * 0.08 * 255;
        data[i] = Math.max(0, Math.min(255, data[i] + n));
        data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + n));
        data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + n));
    }
    ctx.putImageData(img, 0, 0);

    // Mild radial vignette: edges slightly darker (kept subtle for UI clarity).
    const vg = ctx.createRadialGradient(S / 2, S / 2, S * 0.2, S / 2, S / 2, S * 0.55);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.22)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, S, S);

    // Dim gold inlays (low glow so they read as engraved lines, not neon).
    const gold = '#9a7b22';
    ctx.strokeStyle = gold;
    ctx.shadowColor = gold;

    // Central discard-area square (scales with the surface via UV mapping).
    const sq = S * 0.34;
    ctx.lineWidth = 2.5;
    ctx.shadowBlur = 5;
    ctx.strokeRect((S - sq) / 2, (S - sq) / 2, sq, sq);

    // One short line inside each seat edge.
    const len = S * 0.24;
    const inset = S * 0.09;
    ctx.lineWidth = 1.5;
    ctx.shadowBlur = 3;
    ctx.globalAlpha = 0.7;
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
    // ShapeGeometry UVs are raw shape coordinates (mm, +/- SURF_HALF).
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
        new THREE.MeshStandardMaterial({ map: makeFeltTexture(), roughness: 0.92, metalness: 0.02 }),
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
        new THREE.MeshStandardMaterial({ color: 0x121214, roughness: 0.5, metalness: 0.8 }),
    );
    rim.rotation.x = -Math.PI / 2;
    rim.position.y = RIM_BOTTOM;
    rim.castShadow = true;
    rim.receiveShadow = true;
    group.add(rim);

    // --- Thin gold trim on the rim's top outer edge ---------------------
    const trimInner = offsetOctagon(rimOuter.half, rimOuter.cut, -7);
    const trimShape = octagonShape(rimOuter.half, rimOuter.cut);
    trimShape.holes.push(octagonPath(trimInner.half, trimInner.cut));
    const trim = new THREE.Mesh(
        new THREE.ExtrudeGeometry(trimShape, { depth: 2, bevelEnabled: false }),
        new THREE.MeshStandardMaterial({
            color: 0xd4af37,
            emissive: 0xd4af37,
            emissiveIntensity: 0.12,
            roughness: 0.3,
            metalness: 1,
        }),
    );
    trim.rotation.x = -Math.PI / 2;
    trim.position.y = RIM_TOP;
    group.add(trim);

    // --- Underside slab closing the table bottom -------------------------
    const slabR = SURF_HALF / Math.cos(Math.PI / 8);
    const slab = new THREE.Mesh(
        new THREE.CylinderGeometry(slabR, slabR, 19.5, 8, 1),
        new THREE.MeshStandardMaterial({ color: 0x0b0b0d, roughness: 0.5, metalness: 0.7 }),
    );
    slab.rotation.y = Math.PI / 8;
    slab.position.y = -10.25; // top at -0.5, just below the felt (no z-fight)
    slab.castShadow = true;
    group.add(slab);

    // --- Tapered pedestal (8-sided frustum), radii track SURF_HALF -------
    const pedestalTop = SURF_HALF * 0.86;
    const pedestalBottom = SURF_HALF * 0.62;
    const pedestalH = RIM_BOTTOM - STAGE_TOP_Y;
    const pedestal = new THREE.Mesh(
        new THREE.CylinderGeometry(pedestalTop, pedestalBottom, pedestalH, 8, 1),
        new THREE.MeshStandardMaterial({ color: 0x101012, roughness: 0.6, metalness: 0.75 }),
    );
    pedestal.rotation.y = Math.PI / 8; // flats face the seat directions
    pedestal.position.y = STAGE_TOP_Y + pedestalH / 2;
    pedestal.castShadow = true;
    pedestal.receiveShadow = true;
    group.add(pedestal);

    // --- Gold base ring at the foot --------------------------------------
    const base = new THREE.Mesh(
        new THREE.CylinderGeometry(SURF_HALF * 0.67, SURF_HALF * 0.69, 12, 8, 1),
        new THREE.MeshStandardMaterial({
            color: 0xd4af37,
            emissive: 0xd4af37,
            emissiveIntensity: 0.1,
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
