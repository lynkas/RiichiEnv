import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { gsap } from 'gsap';

/**
 * Black-gold dice for the console dome. 12mm rounded cubes, black
 * clearcoat body, gold pips (1 and 4 in red-orange). spinTo() tumples a
 * die with GSAP and settles exactly on the target face-up orientation.
 */

// BoxGeometry material slot order: [+X, -X, +Y, -Y, +Z, -Z].
// Opposite faces sum to 7: 1/6 on ±Y, 2/5 on ±X, 3/4 on ±Z.
const FACE_BY_SLOT = [2, 5, 1, 6, 3, 4];

// Euler rotations that bring the given value to +Y.
const UP_EULER: Record<number, [number, number, number]> = {
    1: [0, 0, 0],
    2: [0, 0, Math.PI / 2],
    3: [-Math.PI / 2, 0, 0],
    4: [Math.PI / 2, 0, 0],
    5: [0, 0, -Math.PI / 2],
    6: [Math.PI, 0, 0],
};

const DIE_SIZE = 12;

function makeFaceTexture(value: number): THREE.CanvasTexture {
    const S = 128;
    const canvas = document.createElement('canvas');
    canvas.width = S;
    canvas.height = S;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('dice: 2d context unavailable');

    ctx.fillStyle = '#111111';
    ctx.fillRect(0, 0, S, S);

    const color = value === 1 || value === 4 ? '#ff3322' : '#e8c454';
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;

    const m = S * 0.27; // pip margin from centre
    const c = S / 2;
    const spots: [number, number][] = [];
    if (value % 2 === 1) spots.push([c, c]);
    if (value >= 2) spots.push([c - m, c - m], [c + m, c + m]);
    if (value >= 4) spots.push([c + m, c - m], [c - m, c + m]);
    if (value === 6) spots.push([c - m, c], [c + m, c]);

    const r = value === 1 ? S * 0.14 : S * 0.085;
    for (const [x, y] of spots) {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

class Die {
    readonly mesh: THREE.Mesh;
    private readonly baseY: number;

    constructor(x: number, y: number, z: number) {
        const geo = new RoundedBoxGeometry(DIE_SIZE, DIE_SIZE, DIE_SIZE, 3, 1.6);
        const materials = FACE_BY_SLOT.map(
            (v) =>
                new THREE.MeshPhysicalMaterial({
                    map: makeFaceTexture(v),
                    roughness: 0.25,
                    metalness: 0.1,
                    clearcoat: 1,
                    clearcoatRoughness: 0.15,
                }),
        );
        this.mesh = new THREE.Mesh(geo, materials);
        this.mesh.castShadow = true;
        this.mesh.position.set(x, y, z);
        this.baseY = y;
        const start = UP_EULER[1 + Math.floor(Math.random() * 6)];
        this.mesh.rotation.set(start[0], start[1], start[2]);
    }

    /** Tumble ~1.2s, then snap exactly onto the value-up orientation. */
    spinTo(value: number): Promise<void> {
        return new Promise((resolve) => {
            const [ex, ey, ez] = UP_EULER[value];
            const spins = 2 + Math.floor(Math.random() * 2);
            const tl = gsap.timeline({
                onComplete: () => {
                    this.mesh.rotation.set(ex, ey, ez);
                    this.mesh.position.y = this.baseY;
                    resolve();
                },
            });
            tl.to(
                this.mesh.rotation,
                {
                    x: ex + Math.PI * 2 * spins,
                    y: ey + Math.PI * 2 * (spins - 1),
                    z: ez + Math.PI * 2 * spins,
                    duration: 1.2,
                    ease: 'power2.out',
                },
                0,
            );
            tl.to(
                this.mesh.position,
                { y: this.baseY + 16, duration: 0.24, ease: 'power1.out', yoyo: true, repeat: 3 },
                0,
            );
        });
    }
}

export class DicePair {
    private readonly d1: Die;
    private readonly d2: Die;

    constructor(parent: THREE.Object3D, baseY: number) {
        this.d1 = new Die(-14, baseY, 0);
        this.d2 = new Die(14, baseY, 0);
        parent.add(this.d1.mesh, this.d2.mesh);
    }

    /** Roll both dice; resolves with the two face values. */
    async roll(): Promise<[number, number]> {
        const a = 1 + Math.floor(Math.random() * 6);
        const b = 1 + Math.floor(Math.random() * 6);
        await Promise.all([this.d1.spinTo(a), this.d2.spinTo(b)]);
        return [a, b];
    }
}
