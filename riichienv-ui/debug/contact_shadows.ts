import * as THREE from 'three';

/**
 * Soft contact shadows for tiles, as a single InstancedMesh of blurred quads
 * lying on the table.
 *
 * Why not a shadow map: a directional light casts a *slanted* shadow, and its
 * angle is tied to the same light that produces the form shading. Wanting a
 * small pool of shadow directly under each tile while keeping an angled key
 * light means the two have to be decoupled — so the contact shadow becomes a
 * decal, not a light-transport result. This is also what the stylised mahjong
 * clients do: the grounding cue is art-directed, not simulated.
 *
 * Footprints come from each tile's world-space bounding box, so a tile that is
 * standing upright, laid flat or turned sideways (riichi) all get a correctly
 * shaped pool with no per-case code. The ±3° river jitter is ignored — the blob
 * is soft enough that an axis-aligned footprint is indistinguishable.
 *
 * One draw call regardless of tile count.
 */

export interface ContactShadowOptions {
    /** Max instances the buffer can hold. */
    capacity?: number;
    /** Height above the table surface. Small enough to read as contact. */
    y?: number;
    /** Footprint multiplier — how far the soft edge spreads past the tile. */
    spread?: number;
    /** Darkness of the pool centre, 0..1. */
    opacity?: number;
}

/**
 * Footprint multiplier the blob texture is authored against. Changing `spread`
 * away from this at runtime just scales the whole pool, which is a usable knob;
 * the texture stays matched to this value.
 */
const DEFAULT_SPREAD = 1.3;

/** Blurred rounded-rect silhouette: black RGB, blob in the alpha channel. */
function makeBlobTexture(size = 128): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('contact_shadows: 2d context unavailable');

    // Draw the shape fully off-canvas and let only its shadow land on the
    // canvas — the standard way to get a cheap, well-behaved gaussian blur out
    // of Canvas2D without depending on ctx.filter.
    // The inset is tied to the quad's `spread`: at spread 1.3 the shape should
    // occupy 1/1.3 of the quad so its edge lands exactly on the tile's
    // footprint, and the blur then falls off *outward* from that edge. That is
    // what produces a small, distinct ring at the tile's base rather than
    // either a hidden pool (shape smaller than the tile) or a wide smudge on
    // the felt (shape much larger).
    const insetFraction = (1 - 1 / DEFAULT_SPREAD) / 2;
    const inset = size * insetFraction;
    const w = size - inset * 2;
    const h = size - inset * 2;
    const r = Math.min(w, h) * 0.14;
    const off = size * 2;

    ctx.clearRect(0, 0, size, size);
    ctx.shadowColor = 'rgba(0, 0, 0, 1)';
    ctx.shadowBlur = size * 0.09;
    ctx.shadowOffsetX = off;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.roundRect(inset - off, inset, w, h, r);
    ctx.fill();

    const texture = new THREE.CanvasTexture(canvas);
    // Alpha-only blob; no colour to decode.
    texture.colorSpace = THREE.NoColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    return texture;
}

export class ContactShadows {
    readonly mesh: THREE.InstancedMesh;
    private readonly material: THREE.MeshBasicMaterial;
    private readonly texture: THREE.CanvasTexture;
    private readonly dummy = new THREE.Object3D();
    private readonly box = new THREE.Box3();
    private readonly capacity: number;

    y: number;
    spread: number;

    constructor(parent: THREE.Object3D, opts: ContactShadowOptions = {}) {
        this.capacity = opts.capacity ?? 320;
        this.y = opts.y ?? 0.9;
        this.spread = opts.spread ?? DEFAULT_SPREAD;

        this.texture = makeBlobTexture();
        this.material = new THREE.MeshBasicMaterial({
            map: this.texture,
            transparent: true,
            opacity: opts.opacity ?? 0.45,
            // Never occlude the tiles that sit on top of it, and never fight
            // the felt or the zone overlay for depth.
            depthWrite: false,
            toneMapped: false,
        });

        // Unit plane in XY; each instance rotates it flat and scales it to the
        // tile's footprint.
        const geo = new THREE.PlaneGeometry(1, 1);
        this.mesh = new THREE.InstancedMesh(geo, this.material, this.capacity);
        this.mesh.name = 'contact-shadows';
        this.mesh.count = 0;
        this.mesh.frustumCulled = false;
        // After the felt (0) and the zone overlay (1), before the tiles.
        this.mesh.renderOrder = 2;
        this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        parent.add(this.mesh);
    }

    /**
     * Rebuild the instance list from `meshes`, keeping only those actually
     * resting on the table (world AABB bottom within `groundEpsilon` of y=0).
     * Returns the number of shadows placed.
     */
    update(meshes: Iterable<THREE.Object3D>, groundEpsilon = 0.75): number {
        let i = 0;
        for (const mesh of meshes) {
            if (i >= this.capacity) break;
            if (!mesh.parent) continue; // detached mid-rebuild

            // Box3.setFromObject only calls updateWorldMatrix(false, false) —
            // it refreshes the object but NOT its ancestors. Tiles live under
            // per-seat groups that carry the 90°/180°/270° seat rotation, and
            // this runs before the renderer has walked the graph, so without
            // updating parents first the box comes back in seat-local space and
            // every pool lands rotated off its tile.
            mesh.updateWorldMatrix(true, false);
            this.box.setFromObject(mesh);
            if (!Number.isFinite(this.box.min.y) || this.box.min.y > groundEpsilon) continue;

            const cx = (this.box.min.x + this.box.max.x) / 2;
            const cz = (this.box.min.z + this.box.max.z) / 2;
            const sx = (this.box.max.x - this.box.min.x) * this.spread;
            const sz = (this.box.max.z - this.box.min.z) * this.spread;

            // YXZ so the -90° X rotation lays the plane flat and any later Y
            // spin happens in world space around it.
            this.dummy.rotation.order = 'YXZ';
            this.dummy.rotation.set(-Math.PI / 2, 0, 0);
            this.dummy.position.set(cx, this.y, cz);
            this.dummy.scale.set(sx, sz, 1);
            this.dummy.updateMatrix();
            this.mesh.setMatrixAt(i, this.dummy.matrix);
            i++;
        }
        this.mesh.count = i;
        this.mesh.instanceMatrix.needsUpdate = true;
        return i;
    }

    setOpacity(v: number): void {
        this.material.opacity = v;
    }

    setVisible(v: boolean): void {
        this.mesh.visible = v;
    }

    dispose(): void {
        this.mesh.parent?.remove(this.mesh);
        this.mesh.geometry.dispose();
        this.material.dispose();
        this.texture.dispose();
    }
}
