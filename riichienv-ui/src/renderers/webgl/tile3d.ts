import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { TextureCache } from './textures';

/**
 * A single mahjong tile built from one RoundedBoxGeometry.
 *
 *  ┌───────────────────────┐  ← +Y face: glyph texture (cream + face)
 *  │   cream lacquer sides  │  upper sides: cream #e4dec8
 *  │   (single rounded box) │
 *  │   gold lacquer sides   │  lower 3mm sides: gold #c8a030 (via side map)
 *  └───────────────────────┘  ← -Y face: back-design texture (gold)
 *
 * One RoundedBoxGeometry keeps the surface curvature continuous all the way
 * around (no mating seam between two stacked boxes). The four side faces
 * (±X, ±Z) share a single material whose `map` is a vertical gradient
 * texture: cream above, gold for the bottom 3 mm. Because the gold band
 * (3/16.5 ≈ 18.2% of V) is wider than the rounded bevel region
 * (arcUvRatio ≈ 10% for radius=2), the entire bottom bevel renders gold —
 * the bevel never samples the cream half of the gradient.
 *
 * BoxGeometry/RoundedBoxGeometry material group order is
 * [+X, -X, +Y, -Y, +Z, -Z]. +Y is the glyph face; -Y is the back-design
 * face; the four remaining groups are the sides and share one material.
 *
 * The mesh origin is at the geometric centre, so setPosition(x, height/2, z)
 * rests the tile on the table (y=0).
 */
export class Tile3D {
    mesh: THREE.Mesh;
    /** All six slot materials (side material appears four times). Debug UIs
     * iterate this for roughness/metalness — duplicates are idempotent. */
    materials: THREE.MeshStandardMaterial[];

    // Real mahjong tile physics: 21mm wide (X) × 16.5mm thick (Y, stacking
    // axis) × 28mm long (Z). 1 unit = 1mm.
    constructor(width = 21, height = 16.5, depth = 28, segments = 6, radius = 2) {
        const geo = new RoundedBoxGeometry(width, height, depth, segments, radius);

        // Side material: cream base, replaced by a cream→gold gradient `map`
        // (set via setSideTexture). White colour so the map renders
        // unmultiplied.
        const sideMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0 });
        // Top (+Y) face material: glyph texture set via setTopTexture.
        // emissive + emissiveMap (= map) keep the glyph face bright so the
        // cream/glyph colour survives directional lighting + ACESFilmic tone
        // mapping instead of washing out to grey.
        const topMat = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            roughness: 0.7,
            metalness: 0,
            emissive: 0xffffff,
            emissiveIntensity: 1.0,
        });
        // Bottom (-Y) face material: back-design texture set via
        // setBottomTexture.
        const bottomMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0 });

        // [+X, -X, +Y, -Y, +Z, -Z]
        this.materials = [sideMat, sideMat, topMat, bottomMat, sideMat, sideMat];
        this.mesh = new THREE.Mesh(geo, this.materials);
        this.mesh.castShadow = true;
        this.mesh.receiveShadow = true;
    }

    /**
     * Apply the shared side gradient (cream top, gold bottom 3 mm) to all
     * four side faces. Cached by TextureCache so all tiles share one canvas
     * texture.
     */
    setSideTexture(tex: THREE.Texture): void {
        const sideMat = this.materials[0];
        sideMat.map = tex;
        sideMat.color.setHex(0xffffff);
        sideMat.needsUpdate = true;
    }

    /** Paint the +Y face with the resolved glyph texture. */
    setTopTexture(tex: THREE.Texture): void {
        this.materials[2].map = tex;
        this.materials[2].emissiveMap = tex;
        this.materials[2].needsUpdate = true;
    }

    /** Paint the -Y face with the resolved back-design texture. */
    setBottomTexture(tex: THREE.Texture): void {
        this.materials[3].map = tex;
        this.materials[3].needsUpdate = true;
    }

    /**
     * Tint the -Y (back) face material colour. Note: when a back-design
     * texture is bound via setBottomTexture, this colour multiplies the
     * texture (white = neutral). To change the back's gold frame instead,
     * regenerate the back texture (TextureCache.getBack) and call
     * setBottomTexture. The companion side-band colour is handled by the
     * caller via TextureCache.getSide(color) + setSideTexture.
     */
    setBackColor(hexColor: number): void {
        this.materials[3].color.setHex(hexColor);
        this.materials[3].needsUpdate = true;
    }

    /** Resolve `code` through `cache` (async SVG→canvas) and paint the +Y face. */
    async setTileCode(code: string, cache: TextureCache): Promise<void> {
        const tex = await cache.get(code);
        this.setTopTexture(tex);
        this.mesh.userData.tileCode = code;
    }

    /** Resolve the back design through `cache` and paint the -Y face. */
    async setBack(cache: TextureCache): Promise<void> {
        const tex = await cache.getBack();
        this.setBottomTexture(tex);
    }

    /**
     * Position the tile's geometric centre at (x, y, z). To rest the tile on
     * the table (bottom face at y=0), pass y = height/2.
     */
    setPosition(x: number, y: number, z: number): void {
        this.mesh.position.set(x, y, z);
    }

    /** Physically flip the tile so the back-design face points up (+Y). */
    flip(): void {
        this.mesh.rotation.x = Math.PI;
    }

    /** Restore the face-up orientation (glyph points up). */
    unflip(): void {
        this.mesh.rotation.x = 0;
    }

    show(): void {
        this.mesh.visible = true;
    }

    hide(): void {
        this.mesh.visible = false;
    }

    dispose(): void {
        this.mesh.geometry.dispose();
        // Materials are not disposed: debug layouts iterate them via
        // `materials` and may still hold references; GC handles them.
    }
}
