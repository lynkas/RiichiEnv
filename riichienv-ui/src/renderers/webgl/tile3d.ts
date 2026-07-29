import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { TileTextureFactory } from './textures.js';
import type { TileSet } from './tileset.js';

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
 * (3/height) is wider than the rounded bevel region (arcUvRatio ≈ 10%), the
 * entire bottom bevel renders gold — the bevel never samples the cream half
 * of the gradient.
 *
 * BoxGeometry/RoundedBoxGeometry material group order is
 * [+X, -X, +Y, -Y, +Z, -Z]. +Y is the glyph face; -Y is the back-design
 * face; the four remaining groups are the sides and share one material.
 *
 * The top (+Y) face is a ShaderMaterial that composites the glyph PNG
 * (transparent background, RGB = stroke colour, alpha = shape mask) over a
 * cream base colour uniform: `mix(bgColor, tex.rgb, tex.a)`. Because the
 * base colour comes from a uniform rather than the texture, mipmapping of
 * the alpha channel only softens edges — it never bleaches the strokes.
 * The material ignores scene lighting, so the face reads at a constant
 * brightness.
 *
 * All dimensions, colours and shader parameters come from the {@link TileSet}
 * passed to the constructor — nothing is hardcoded here. The mesh origin is
 * at the geometric centre, so setPosition(x, height/2, z) rests the tile on
 * the table (y=0).
 */
export class Tile3D {
    mesh: THREE.Mesh;
    materials: THREE.Material[];
    tileSet: TileSet;

    constructor(tileSet: TileSet) {
        this.tileSet = tileSet;
        const c = tileSet.config;

        const geo = new RoundedBoxGeometry(c.width, c.height, c.depth, tileSet.segments, c.radius);

        // Side material: cream base, replaced by a cream→gold gradient `map`
        // (set via setSideTexture). White colour so the map renders
        // unmultiplied.
        const sideMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0 });
        // Top (+Y) face material: cream lacquer + SVG glyph. The glyph PNG is
        // transparent (alpha = shape mask, RGB = stroke colour); the shader
        // composites it over a cream base colour uniform so mipmapping never
        // washes out the strokes.
        const topMat = new THREE.ShaderMaterial({
            uniforms: {
                texMap: { value: null },
                bgColor: { value: new THREE.Color(c.bgColor) },
                saturation: { value: c.saturation },
            },
            vertexShader: `
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform sampler2D texMap;
                uniform vec3 bgColor;
                uniform float saturation;
                varying vec2 vUv;
                void main() {
                    vec4 tex = texture2D(texMap, vUv);
                    float luma = dot(tex.rgb, vec3(0.299, 0.587, 0.114));
                    vec3 vivid = mix(vec3(luma), tex.rgb, saturation);
                    vec3 base = mix(bgColor, vivid, tex.a);
                    gl_FragColor = vec4(base, 1.0);
                    #include <colorspace_fragment>
                }
            `,
        });
        // Bottom (-Y) face material: back-design texture set via
        // setBottomTexture. Coloured from the tileset's back colour.
        const bottomMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1.0, metalness: 0, emissive: c.backColor, emissiveIntensity: 0.2 });

        // [+X, -X, +Y, -Y, +Z, -Z]
        this.materials = [sideMat, sideMat, topMat, bottomMat, sideMat, sideMat];
        this.mesh = new THREE.Mesh(geo, this.materials);
        this.mesh.castShadow = true;
        this.mesh.receiveShadow = true;
    }

    /**
     * Apply the shared side gradient (cream top, gold bottom band) to all
     * four side faces. Cached by TileTextureFactory so all tiles share one
     * canvas texture.
     */
    setSideTexture(tex: THREE.Texture): void {
        const sideMat = this.materials[0] as THREE.MeshStandardMaterial;
        sideMat.map = tex;
        sideMat.color.setHex(0xffffff);
        sideMat.needsUpdate = true;
    }

    /** Paint the -Y face with the resolved back-design texture. */
    setBottomTexture(tex: THREE.Texture): void {
        const mat = this.materials[3] as THREE.MeshStandardMaterial;
        mat.map = tex;
        mat.needsUpdate = true;
    }

    /**
     * Tint the -Y (back) face material colour. Note: when a back-design
     * texture is bound via setBottomTexture, this colour multiplies the
     * texture (white = neutral). To change the back's gold frame instead,
     * regenerate the back texture (TileTextureFactory.getBackTexture) and
     * call setBottomTexture. The companion side-band colour is handled by the
     * caller via TileTextureFactory.getSideTexture(color) + setSideTexture.
     */
    setBackColor(hexColor: number): void {
        const mat = this.materials[3] as THREE.MeshStandardMaterial;
        mat.color.setHex(hexColor);
        mat.needsUpdate = true;
    }

    /**
     * Resolve `code` to its face texture (SVG → Canvas → CanvasTexture via
     * `factory.getFaceTexture`) and bind it to the +Y ShaderMaterial's
     * `texMap` uniform. The shader composites the transparent glyph PNG over
     * the cream base colour. Blank codes (per the tileset, e.g. 白板 P / 5z)
     * render no glyph — texMap is left null so the shader samples full
     * transparency and shows the pure cream bgColor.
     */
    async setCode(code: string, factory: TileTextureFactory): Promise<void> {
        if (this.tileSet.config.blankCodes.includes(code)) {
            const topMat = this.materials[2];
            if (topMat instanceof THREE.ShaderMaterial) {
                topMat.uniforms.texMap.value = null;
            }
            this.mesh.userData.tileCode = code;
            return;
        }

        const tex = await factory.getFaceTexture(code);
        const topMat = this.materials[2];
        if (topMat instanceof THREE.ShaderMaterial) {
            topMat.uniforms.texMap.value = tex;
        }
        this.mesh.userData.tileCode = code;
    }

    /** Resolve the back design through `factory` and paint the -Y face. */
    async setBack(factory: TileTextureFactory): Promise<void> {
        const tex = await factory.getBackTexture();
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
