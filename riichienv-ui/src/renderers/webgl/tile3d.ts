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
 * The top (+Y) face is a MeshStandardMaterial whose `map_fragment` chunk is
 * replaced so the glyph texture (transparent background, RGB = stroke colour,
 * alpha = shape mask) is composited *over* the cream base colour rather than
 * multiplied into it: `diffuseColor.rgb = mix(bgColor, vivid, glyph.a)`.
 * Because the base colour comes from `material.color`, mipmapping of the alpha
 * channel only softens edges — it never bleaches the strokes.
 *
 * Using MeshStandardMaterial (rather than a standalone ShaderMaterial) is what
 * makes the glyph face take part in rendering at all: it receives lighting and
 * shadows, and it goes through the renderer's tone mapping and exposure like
 * every other surface. A standalone ShaderMaterial has to opt into each of
 * those by hand, and any it misses puts the face on a different response curve
 * from the tile's own sides — which reads as a sticker on a plastic block.
 *
 * All three materials share the Fresnel rim highlight (see `patchTileShader`),
 * so the rim reads on the glyph face too — the largest visible surface under a
 * top-down camera.
 *
 * All dimensions, colours and shader parameters come from the {@link TileSet}
 * passed to the constructor — nothing is hardcoded here. The mesh origin is
 * at the geometric centre, so setPosition(x, height/2, z) rests the tile on
 * the table (y=0).
 */

/**
 * 1x1 fully transparent glyph, used as the `map` of a blank face (白板) and as
 * the initial map of every top face.
 *
 * The top face's injected shader unconditionally samples `map`, and three.js
 * only declares the `map` sampler and `vMapUv` when a texture is actually
 * bound. Binding this placeholder instead of leaving `map` null keeps `USE_MAP`
 * defined for the lifetime of the material, so the injected code always
 * compiles and swapping in a real glyph never triggers a shader recompile.
 * Alpha 0 composites to the pure base colour.
 */
/**
 * Shared RoundedBoxGeometry cache, keyed by dimensions.
 *
 * A table holds ~140 tiles in at most a handful of distinct sizes (table tile,
 * meld tile at 0.8x, overlay hand tile), yet every Tile3D used to build its own
 * RoundedBoxGeometry — 140 separate vertex buffers of identical content. The
 * cache is refcounted rather than permanent so `dispose()` still frees GPU
 * memory once the last tile of a given size is gone.
 */
interface CachedGeometry {
    geometry: RoundedBoxGeometry;
    refs: number;
}
const geometryCache = new Map<string, CachedGeometry>();

function geometryKey(w: number, h: number, d: number, seg: number, r: number): string {
    return `${w}|${h}|${d}|${seg}|${r}`;
}

function acquireGeometry(
    w: number,
    h: number,
    d: number,
    seg: number,
    r: number,
): { geometry: RoundedBoxGeometry; key: string } {
    const key = geometryKey(w, h, d, seg, r);
    let entry = geometryCache.get(key);
    if (!entry) {
        entry = { geometry: new RoundedBoxGeometry(w, h, d, seg, r), refs: 0 };
        geometryCache.set(key, entry);
    }
    entry.refs++;
    return { geometry: entry.geometry, key };
}

function releaseGeometry(key: string): void {
    const entry = geometryCache.get(key);
    if (!entry) return;
    entry.refs--;
    if (entry.refs <= 0) {
        entry.geometry.dispose();
        geometryCache.delete(key);
    }
}

/** Distinct tile geometries currently alive — for debug readouts. */
export function tileGeometryCacheSize(): number {
    return geometryCache.size;
}

let blankGlyphTexture: THREE.DataTexture | null = null;
function getBlankGlyphTexture(): THREE.DataTexture {
    if (!blankGlyphTexture) {
        blankGlyphTexture = new THREE.DataTexture(
            new Uint8Array([0, 0, 0, 0]),
            1,
            1,
            THREE.RGBAFormat,
        );
        blankGlyphTexture.colorSpace = THREE.SRGBColorSpace;
        blankGlyphTexture.needsUpdate = true;
    }
    return blankGlyphTexture;
}

/**
 * Viewport size in device pixels, shared by every outline material by
 * reference — update it once via {@link setOutlineViewport} and all tiles
 * follow. Needed to convert the desired pixel width into clip space.
 */
const outlineViewport = { value: new THREE.Vector2(1, 1) };

/**
 * Key-light direction in world space, shared by every outline material.
 *
 * Used to vary line weight with lighting: hand-drawn contours are heavier on the
 * shadow side of a form and lighter where the light hits. A perfectly uniform
 * line is the giveaway that a shader drew it.
 */
const outlineLightDir = { value: new THREE.Vector3(0, 1, 0) };

/**
 * View-space depth range over which the line thins out, as (near, far). Distant
 * lines lightening is the other half of the hand-drawn read, and it gives the
 * frame a depth hierarchy the constant-width version had none of.
 *
 * Note this is *not* the world-space-width bug from before: the base width stays
 * in device pixels, and this is a bounded, deliberate falloff on top.
 */
const outlineDepthRange = { value: new THREE.Vector2(1100, 1950) };

/** Tell the outline shader the current drawing-buffer size, in device pixels. */
export function setOutlineViewport(widthPx: number, heightPx: number): void {
    outlineViewport.value.set(Math.max(widthPx, 1), Math.max(heightPx, 1));
}

/** Point the line-weight variation at the scene's key light (world space). */
export function setOutlineLightDirection(x: number, y: number, z: number): void {
    outlineLightDir.value.set(x, y, z).normalize();
}

/** View-space depth range over which outlines thin out. */
export function setOutlineDepthRange(near: number, far: number): void {
    outlineDepthRange.value.set(near, Math.max(far, near + 1));
}

/**
 * Inverted-hull outline material.
 *
 * Only backfaces are drawn, and each vertex is displaced **within the screen
 * plane** — the shell is widened in clip-space XY while z and w are copied
 * through untouched. Two consequences, both essential:
 *
 * 1. **Depth is unchanged**, so a shell fragment always sits at the depth of the
 *    surface it came from. It can therefore write depth safely: it never lands
 *    in front of its own tile, and it still wins against the felt underneath.
 *
 *    The obvious implementation — `position + normal * width` in object space —
 *    fails here. Displacing along the normal pushes camera-facing geometry
 *    *toward* the camera, so around the rounded bevel the shell projects onto the
 *    tile while sitting nearer than the tile's own surface, and at grazing angles
 *    it eats inward and paints near-black over the lacquer and the gold band.
 *    Measured on this scene: ~5400 tile pixels replaced at a mean luma delta of
 *    127, which read as the melds and the far wall turning grey.
 *
 *    Suppressing that with `depthWrite: false` + an early renderOrder trades one
 *    bug for another: the shell then cannot protect itself, and the table surface
 *    — drawn after it — paints over the entire contour. That is why the table
 *    tiles ended up with no outline at all while the screen-space hand, which has
 *    no felt behind it, kept one.
 *
 * 2. **Width is constant in pixels**, not in millimetres. That is what makes the
 *    line read as ink: a world-space width scaled by tile size keeps the
 *    *relative* weight constant, so the 3x overlay-hand tiles get a heavy border
 *    while the table tiles get a hairline — visibly two different styles in one
 *    frame. Deriving the offset from the actual `projectionMatrix` also means
 *    perspective and orthographic cameras both come out right with no per-scene
 *    special case.
 *
 * A screen-space normal/depth edge filter was the alternative. It gives uniform
 * width too, but it edges *everything* in frame — table rim, pedestal — and the
 * hand lives in a separate scene with its own camera, so it would need its own
 * pass. Per-object hulls stay scoped to the tiles and inherit every transform the
 * tile already has (seat rotation, riichi turn, the gsap discard flight, the
 * click scale bounce).
 *
 * Both the tone-mapping and colour-space chunks are included deliberately. With
 * the post chain on, the scene renders to a linear render target, three forces
 * NoToneMapping in materials and both chunks compile to no-ops (OutputPass does
 * the work). With post off it renders straight to the canvas and the chunks
 * apply. Leaving them out is what put the old glyph face on a different response
 * curve from the rest of the tile; an outline is near-black so it would have been
 * subtle, but it would have been the same class of bug.
 */
function createOutlineMaterial(
    widthPx: number,
    color: THREE.ColorRepresentation,
    shadowBoost: number,
    litScale: number,
    farScale: number,
): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
        uniforms: {
            // ShaderMaterial gets none of three's automatic uniform plumbing, so
            // opting into `fog: true` without also supplying UniformsLib.fog
            // makes the renderer throw every frame trying to write
            // `uniforms.fogColor.value`. Spread rather than merged: the shared
            // outline uniforms below must stay shared *by reference*, and
            // UniformsUtils.merge would clone them.
            ...THREE.UniformsLib.fog,
            outlineWidth: { value: widthPx },
            outlineColor: { value: new THREE.Color(color) },
            outlineShadowBoost: { value: shadowBoost },
            outlineLitScale: { value: litScale },
            outlineFarScale: { value: farScale },
            outlineViewport,
            outlineLightDir,
            outlineDepthRange,
        },
        vertexShader: /* glsl */ `
            #include <common>
            #include <fog_pars_vertex>

            uniform float outlineWidth;
            uniform vec2 outlineViewport;
            uniform vec3 outlineLightDir;
            uniform vec2 outlineDepthRange;
            uniform float outlineShadowBoost;
            uniform float outlineLitScale;
            uniform float outlineFarScale;

            void main() {
                vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
                vec4 clip = projectionMatrix * mvPosition;

                // Project the normal to find which way "outward" points on
                // screen, then step that way by a number of pixels.
                vec3 viewNormal = normalize( normalMatrix * normal );
                vec4 clipOffset = projectionMatrix * vec4( mvPosition.xyz + viewNormal, 1.0 );
                vec2 delta = clipOffset.xy / clipOffset.w - clip.xy / clip.w;

                // A face pointing straight at (or away from) the camera projects
                // to nothing and contributes no silhouette — guard the normalize.
                float len = length( delta );
                vec2 dir = len > 1e-6 ? delta / len : vec2( 0.0 );

                // --- Variable line weight ---
                // Heavier where the form turns away from the key light, lighter
                // where the light lands. This is what a pen does, and it is the
                // difference between a contour and a uniform stroke.
                vec3 worldNormal = normalize( mat3( modelMatrix ) * normal );
                float lit = clamp( dot( worldNormal, outlineLightDir ) * 0.5 + 0.5, 0.0, 1.0 );
                float weight = mix( outlineShadowBoost, outlineLitScale, lit );

                // Distant lines thin out, giving the frame a depth hierarchy.
                float depth = -mvPosition.z;
                float t = clamp(
                    ( depth - outlineDepthRange.x ) /
                    max( outlineDepthRange.y - outlineDepthRange.x, 1e-3 ),
                    0.0,
                    1.0
                );
                weight *= mix( 1.0, outlineFarScale, t );

                // NDC spans 2 units across the viewport, so one pixel is
                // 2/size. Scaling by clip.w converts the NDC step back to clip
                // space; z and w are left alone so depth is untouched.
                clip.xy += dir * ( outlineWidth * weight * 2.0 / outlineViewport ) * clip.w;

                gl_Position = clip;

                #include <fog_vertex>
            }
        `,
        fragmentShader: /* glsl */ `
            #include <common>
            #include <fog_pars_fragment>
            uniform vec3 outlineColor;
            void main() {
                gl_FragColor = vec4( outlineColor, 1.0 );
                #include <tonemapping_fragment>
                #include <colorspace_fragment>
                #include <fog_fragment>
            }
        `,
        side: THREE.BackSide,
        // Distant ink should fade with the tiles it belongs to, not stay at full
        // strength while the tile behind it washes out into the haze.
        fog: true,
    });
}

/** Per-material uniforms injected by {@link patchTileShader}. */
interface TileShaderUniforms {
    rimIntensity: { value: number };
    rimColor: { value: THREE.Color };
    glyphSaturation: { value: number };
    /** Single-channel signed distance field for the glyph shape. */
    sdfMap: { value: THREE.Texture | null };
    /** 1 = take the glyph edge from the SDF, 0 = from the colour map's alpha. */
    sdfEnabled: { value: number };
    /** Signed-distance offset that dilates (>0) or erodes (<0) the strokes. */
    glyphWeight: { value: number };
    /** 0 = continuous PBR shading, 1 = quantised cel bands. */
    rampEnabled: { value: number };
    rampSteps: { value: number };
    rampSoftness: { value: number };
    rampFloor: { value: number };
    rampRange: { value: number };
    rampShadowTint: { value: THREE.Color };
    /** 0 = smooth GGX falloff, 1 = hard-edged highlight. */
    specHard: { value: number };
    specThreshold: { value: number };
    specSoftness: { value: number };
    specIntensity: { value: number };
    specColor: { value: THREE.Color };
    specEnvScale: { value: number };
    /** How strongly specular and rim are held off the glyph ink, 0..1. */
    inkSpecSuppress: { value: number };
}

/**
 * Patch a MeshStandardMaterial's fragment shader with the tile's shared
 * Fresnel rim highlight, and — when `glyph` is set — the glyph-over-base
 * composite for the top face.
 *
 * `rimIntensity` / `rimColor` / `glyphSaturation` are real uniforms rather than
 * values interpolated into the shader source, so a debug GUI can drive them
 * without rebuilding every tile in the scene.
 *
 * `customProgramCacheKey` is required: three.js derives its program cache key
 * from the material's *parameters*, which do not capture source injected by
 * `onBeforeCompile`. Without a distinguishing key, a patched material and an
 * unpatched one with otherwise identical parameters share a compiled program,
 * and whichever compiled first silently wins.
 */
function patchTileShader(
    mat: THREE.MeshStandardMaterial,
    uniforms: TileShaderUniforms,
    opts: { glyph: boolean; ramp: boolean },
): void {
    mat.onBeforeCompile = (shader) => {
        shader.uniforms.rimIntensity = uniforms.rimIntensity;
        shader.uniforms.rimColor = uniforms.rimColor;
        shader.uniforms.glyphSaturation = uniforms.glyphSaturation;
        shader.uniforms.sdfMap = uniforms.sdfMap;
        shader.uniforms.sdfEnabled = uniforms.sdfEnabled;
        shader.uniforms.glyphWeight = uniforms.glyphWeight;
        shader.uniforms.rampEnabled = uniforms.rampEnabled;
        shader.uniforms.rampSteps = uniforms.rampSteps;
        shader.uniforms.rampSoftness = uniforms.rampSoftness;
        shader.uniforms.rampFloor = uniforms.rampFloor;
        shader.uniforms.rampRange = uniforms.rampRange;
        shader.uniforms.rampShadowTint = uniforms.rampShadowTint;
        shader.uniforms.specHard = uniforms.specHard;
        shader.uniforms.specThreshold = uniforms.specThreshold;
        shader.uniforms.specSoftness = uniforms.specSoftness;
        shader.uniforms.specIntensity = uniforms.specIntensity;
        shader.uniforms.specColor = uniforms.specColor;
        shader.uniforms.specEnvScale = uniforms.specEnvScale;
        shader.uniforms.inkSpecSuppress = uniforms.inkSpecSuppress;

        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <common>',
            `#include <common>
             uniform float rimIntensity;
             uniform vec3 rimColor;
             uniform float glyphSaturation;
             uniform sampler2D sdfMap;
             uniform float sdfEnabled;
             uniform float glyphWeight;
             uniform float rampEnabled;
             uniform float rampSteps;
             uniform float rampSoftness;
             uniform float rampFloor;
             uniform float rampRange;
             uniform vec3 rampShadowTint;
             uniform float specHard;
             uniform float specThreshold;
             uniform float specSoftness;
             uniform float specIntensity;
             uniform vec3 specColor;
             uniform float specEnvScale;
             uniform float inkSpecSuppress;

             // Glyph coverage of the current fragment, set by the glyph patch and
             // read by the rim and specular patches further down. Zero on the side
             // and back materials, which never run the glyph patch.
             float tileInkMask = 0.0;`,
        );

        if (opts.glyph) {
            // Composite instead of multiply. `map_fragment` would do
            // `diffuseColor *= texture(map, vMapUv)`, which turns the glyph's
            // transparent background into black; we want the base colour there.
            //
            // The sampled value is linear (three decodes the sRGB map on
            // sample) and so is `diffuseColor.rgb` (from material.color), so
            // the mix happens in linear space. The saturation boost therefore
            // uses Rec.709 linear luma weights, not the gamma-space ones.
            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <map_fragment>',
                `// Coverage and colour come from different places on purpose.
                 //
                 // Coverage: the colour map's alpha is mipmapped, so a thin stroke
                 // minified to a few pixels has its alpha averaged toward zero and
                 // the glyph fades out. The SDF is thresholded per-pixel against
                 // the on-screen gradient instead, so coverage holds at any scale.
                 //
                 // Colour: sampled at mip 0 when the SDF is driving coverage. This
                 // matters as much as the coverage does. Averaged mips carry a
                 // washed-out blend of stroke and transparent background, and the
                 // un-premultiply below cannot recover it — with a divisor floor of
                 // 0.25 against a true mip alpha of ~0.05 the stroke comes back
                 // about five times too pale. Measured on a table-distance frame,
                 // the darkest 10% of tile pixels sat at 147-165 when the strokes
                 // are actually near-black. Filtering the colour is pointless here
                 // anyway: the SDF already antialiases the edge.
                 vec4 glyphTexel;
                 if ( sdfEnabled > 0.5 ) {
                     glyphTexel = textureLod( map, vMapUv, 0.0 );
                 } else {
                     glyphTexel = texture2D( map, vMapUv );
                 }

                 float glyphAlpha = glyphTexel.a;
                 if ( sdfEnabled > 0.5 ) {
                      float sd = textureLod( sdfMap, vMapUv, 0.0 ).r;
                     float aa = max( fwidth( sd ), 1e-5 );
                     // Shifting the threshold below 0.5 dilates the strokes.
                     float edge = 0.5 - glyphWeight;
                     glyphAlpha = smoothstep( edge - aa, edge + aa, sd );
                 }

                 // Recover un-premultiplied stroke colour. Near the outline the
                 // colour map's own alpha approaches 0, and the SDF may still
                 // report full coverage there; without this the strokes pick up
                 // a dark fringe from the transparent background.
                 vec3 glyphRgb = glyphTexel.rgb / max( glyphTexel.a, 0.25 );
                 float glyphLuma = dot( glyphRgb, vec3( 0.2126, 0.7152, 0.0722 ) );
                 vec3 glyphVivid = clamp(
                     mix( vec3( glyphLuma ), glyphRgb, glyphSaturation ),
                     0.0,
                     1.0
                 );
                 diffuseColor.rgb = mix( diffuseColor.rgb, glyphVivid, glyphAlpha );
                 tileInkMask = glyphAlpha;`,
            );
        }

        if (opts.ramp) {
            // Quantise the diffuse response into flat bands.
            //
            // Injected after <aomap_fragment>, i.e. once `reflectedLight` is
            // fully accumulated — so it bands the *result* of every light in the
            // rig at once (key, cool fill, hemisphere, ambient, IBL) rather than
            // ramping a single NdotL. Ramping one light's NdotL and leaving the
            // rest continuous is what produces the usual "bands floating on top
            // of a gradient" look.
            //
            // Dividing the accumulated diffuse by the albedo recovers the light
            // level on its own, so the bands land in the same place regardless of
            // whether the surface is cream lacquer, a dark glyph stroke or the
            // gold band — the terminator stays a property of the lighting, not of
            // the texture.
            //
            // Specular is deliberately left alone: it is the only remaining cue
            // that these are lacquered objects, and banding it as well flattens
            // the tile into a paper cut-out.
            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <aomap_fragment>',
                `#include <aomap_fragment>
                 if ( rampEnabled > 0.5 ) {
                     vec3 rampAlbedo = max( material.diffuseColor, vec3( 1e-3 ) );
                     vec3 rampDiffuse = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;
                     float rampLevel = dot(
                         rampDiffuse / rampAlbedo,
                         vec3( 0.2126, 0.7152, 0.0722 )
                     );

                     float x = clamp( rampLevel / max( rampRange, 1e-3 ), 0.0, 1.0 );
                     float n = max( rampSteps, 1.0 );

                     // Band index plus a soft crossing at each boundary, so the
                     // terminator is antialiased instead of stair-stepped.
                     float scaled = x * n;
                     float band = floor( scaled );
                     float frac = scaled - band;
                     float w = clamp( rampSoftness, 0.002, 0.49 );
                     float q = ( band + smoothstep( 0.5 - w, 0.5 + w, frac ) ) / n;

                     // Darkest band sits at rampFloor, not at black: a cel shadow
                     // is a tinted lighter colour, not an absence of light.
                     float y = mix( rampFloor, 1.0, q );
                     vec3 tint = mix( rampShadowTint, vec3( 1.0 ), q );

                     float target = y * max( rampRange, 1e-3 );
                     float scale = target / max( rampLevel, 1e-4 );
                     reflectedLight.directDiffuse *= scale * tint;
                     reflectedLight.indirectDiffuse *= scale * tint;
                 }`,
            );
        }

        // Hard-edged specular.
        //
        // GGX gives a smooth radial falloff; cel art gives a flat shape with a
        // defined edge. Thresholding the *accumulated* direct specular keeps the
        // highlight wherever the BRDF actually put it (so it still tracks the key
        // light and the surface normal) while throwing away the falloff, which is
        // the part that reads as a render.
        //
        // Roughness still matters: it sets how big the region above the threshold
        // is, i.e. the size of the resulting blob.
        //
        // The environment specular is handled separately — it is a broad
        // view-dependent wash with no shape to harden, so it is simply scaled.
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <aomap_fragment>',
            `#include <aomap_fragment>
             // Keep specular off the line work.
             //
             // Specular is additive and albedo-independent — physically correct for
             // a dielectric, since F0 is ~0.04 whether the surface under it is white
             // lacquer or black ink. But that means the highlight lifts near-black
             // strokes to grey, and on a tile the strokes are the whole point: the
             // face reads pale and unreadable while the lacquer looks glossy. Cel art
             // puts the highlight on the lacquer and leaves the ink alone.
             float inkKeep = 1.0 - tileInkMask * inkSpecSuppress;
             reflectedLight.indirectSpecular *= specEnvScale * inkKeep;
             if ( specHard > 0.5 ) {
                 float specLevel = dot(
                     reflectedLight.directSpecular,
                     vec3( 0.2126, 0.7152, 0.0722 )
                 );
                 float w = max( specThreshold * specSoftness, 1e-5 );
                 float hit = smoothstep( specThreshold - w, specThreshold + w, specLevel );
                 reflectedLight.directSpecular = specColor * ( hit * specIntensity * inkKeep );
             } else {
                 reflectedLight.directSpecular *= inkKeep;
             }`,
        );

        // Fresnel rim, added as emissive so it survives regardless of how the
        // surface is lit.
        //
        // The view direction must special-case orthographic projection, the
        // same way three's own `lights_fragment_begin` does. Under an ortho
        // camera the real view direction is constant (0,0,1) in view space,
        // but `normalize(vViewPosition)` gives the direction to the view-space
        // origin, which swings wide for anything far from screen centre. The
        // screen-space overlay hand is exactly that case: its tiles face the
        // camera dead-on, yet an unguarded Fresnel reports rimFactor ~1 across
        // the whole glyph face and floods it with rim colour.
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <emissivemap_fragment>',
            `#include <emissivemap_fragment>
             vec3 rimViewDir = isOrthographic
                 ? vec3( 0.0, 0.0, 1.0 )
                 : normalize( vViewPosition );
             float rimFactor = 1.0 - abs( dot( normal, rimViewDir ) );
             rimFactor = pow( rimFactor, 2.5 );
             totalEmissiveRadiance += rimColor * ( rimFactor * rimIntensity )
                 * ( 1.0 - tileInkMask * inkSpecSuppress );`,
        );
    };

    mat.customProgramCacheKey = () =>
        `tile3d-rim${opts.glyph ? '-glyph' : ''}${opts.ramp ? '-ramp' : ''}`;
}
export class Tile3D {
    mesh: THREE.Mesh;
    materials: THREE.Material[];
    tileSet: TileSet;

    /** Live shader uniforms shared by this tile's three materials. */
    private readonly shaderUniforms: TileShaderUniforms;
    /** Key into the shared geometry cache, released on dispose. */
    private readonly geometryKey: string;
    /** Weight used for glyphs with no per-code entry. */
    private glyphWeightBase: number;
    /** Multiplier on the resolved weight. */
    private glyphWeightScale: number;
    /** Code currently bound, so the per-glyph offset can be re-resolved. */
    private glyphCode: string | null = null;
    /** Inverted-hull outline shell, a child of `mesh`. */
    readonly outlineMesh: THREE.Mesh;
    private readonly outlineMaterial: THREE.ShaderMaterial;

    constructor(tileSet: TileSet) {
        this.tileSet = tileSet;
        const c = tileSet.config;

        const { geometry: geo, key } = acquireGeometry(
            c.width,
            c.height,
            c.depth,
            tileSet.segments,
            c.radius,
        );
        this.geometryKey = key;
        this.glyphWeightBase = c.glyphWeight;
        this.glyphWeightScale = c.glyphWeightScale;

        this.shaderUniforms = {
            rimIntensity: { value: c.rimIntensity },
            rimColor: { value: new THREE.Color(c.rimColor) },
            glyphSaturation: { value: c.saturation },
            sdfMap: { value: getBlankGlyphTexture() },
            sdfEnabled: { value: 0 },
            glyphWeight: { value: c.glyphWeight },
            rampEnabled: { value: c.ramp ? 1 : 0 },
            rampSteps: { value: c.rampSteps },
            rampSoftness: { value: c.rampSoftness },
            rampFloor: { value: c.rampFloor },
            rampRange: { value: c.rampRange },
            rampShadowTint: { value: new THREE.Color(c.rampShadowTint) },
            specHard: { value: c.specHard ? 1 : 0 },
            specThreshold: { value: c.specThreshold },
            specSoftness: { value: c.specSoftness },
            specIntensity: { value: c.specIntensity },
            specColor: { value: new THREE.Color(c.specColor) },
            specEnvScale: { value: c.specEnvScale },
            inkSpecSuppress: { value: c.inkSpecSuppress },
        };

        // Side material: cream base, replaced by a cream→gold gradient `map`
        // (set via setSideTexture). White colour so the map renders
        // unmultiplied.
        const sideMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0 });
        patchTileShader(sideMat, this.shaderUniforms, { glyph: false, ramp: c.rampSides });

        // Top (+Y) face material: cream lacquer + SVG glyph, composited over
        // the base colour by the patched `map_fragment` chunk. A lit material
        // so the face takes shadows, lighting and tone mapping like the sides.
        const topMat = new THREE.MeshStandardMaterial({
            color: c.bgColor,
            roughness: c.faceRoughness,
            metalness: 0,
            map: getBlankGlyphTexture(),
        });
        patchTileShader(topMat, this.shaderUniforms, { glyph: true, ramp: true });

        // Bottom (-Y) face material: back-design texture set via
        // setBottomTexture. Coloured from the tileset's back colour.
        //
        // The back is left with only a trace of emissive: self-illumination
        // without a bloom pass to catch it just flattens the surface, and the
        // wall puts ~70 backs on screen at once. Raise it once bloom lands.
        const bottomMat = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            roughness: 0.85,
            metalness: 0,
            emissive: c.backColor,
            emissiveIntensity: c.backEmissiveIntensity,
        });
        patchTileShader(bottomMat, this.shaderUniforms, { glyph: false, ramp: true });

        // [+X, -X, +Y, -Y, +Z, -Z]
        this.materials = [sideMat, sideMat, topMat, bottomMat, sideMat, sideMat];
        this.mesh = new THREE.Mesh(geo, this.materials);
        this.mesh.castShadow = true;
        this.mesh.receiveShadow = true;

        // Outline shell, parented to the tile so it inherits every transform
        // automatically. Shares the cached geometry (no extra vertex buffer) and
        // holds no geometry reference of its own — it dies with the tile.
        //
        // No size scaling: the width is in device pixels, so every tile in the
        // frame gets the same line weight regardless of its scale or distance.
        // No renderOrder override either — the shell keeps its source surface's
        // depth, so ordinary depth testing resolves it against both the tile and
        // the table.
        this.outlineMaterial = createOutlineMaterial(
            c.outlineWidth,
            c.outlineColor,
            c.outlineShadowBoost,
            c.outlineLitScale,
            c.outlineFarScale,
        );
        this.outlineMesh = new THREE.Mesh(geo, this.outlineMaterial);
        this.outlineMesh.castShadow = false;
        this.outlineMesh.receiveShadow = false;
        this.outlineMesh.visible = c.outline;
        this.mesh.add(this.outlineMesh);
    }

    /** Live outline thickness, in device pixels. */
    setOutlineWidth(widthPx: number): void {
        this.outlineMaterial.uniforms.outlineWidth.value = widthPx;
    }

    /** Live outline colour. */
    setOutlineColor(color: THREE.ColorRepresentation): void {
        this.outlineMaterial.uniforms.outlineColor.value.set(color);
    }

    /** Live line-weight variation. */
    setOutlineWeighting(opts: { shadowBoost?: number; litScale?: number; farScale?: number }): void {
        const u = this.outlineMaterial.uniforms;
        if (opts.shadowBoost !== undefined) u.outlineShadowBoost.value = opts.shadowBoost;
        if (opts.litScale !== undefined) u.outlineLitScale.value = opts.litScale;
        if (opts.farScale !== undefined) u.outlineFarScale.value = opts.farScale;
    }

    setOutlineEnabled(on: boolean): void {
        this.outlineMesh.visible = on;
    }

    /** Live rim-light intensity — no rebuild needed. */
    setRimIntensity(v: number): void {
        this.shaderUniforms.rimIntensity.value = v;
    }

    /** Live rim-light colour — no rebuild needed. */
    setRimColor(color: THREE.ColorRepresentation): void {
        this.shaderUniforms.rimColor.value.set(color);
    }

    /** Live glyph saturation — no rebuild needed. */
    setGlyphSaturation(v: number): void {
        this.shaderUniforms.glyphSaturation.value = v;
    }

    /** Live hard-specular controls. All uniforms — no rebuild needed. */
    setSpecular(opts: {
        hard?: boolean;
        threshold?: number;
        softness?: number;
        intensity?: number;
        color?: THREE.ColorRepresentation;
        envScale?: number;
        inkSuppress?: number;
    }): void {
        const u = this.shaderUniforms;
        if (opts.hard !== undefined) u.specHard.value = opts.hard ? 1 : 0;
        if (opts.threshold !== undefined) u.specThreshold.value = opts.threshold;
        if (opts.softness !== undefined) u.specSoftness.value = opts.softness;
        if (opts.intensity !== undefined) u.specIntensity.value = opts.intensity;
        if (opts.color !== undefined) u.specColor.value.set(opts.color);
        if (opts.envScale !== undefined) u.specEnvScale.value = opts.envScale;
        if (opts.inkSuppress !== undefined) u.inkSpecSuppress.value = opts.inkSuppress;
    }

    /**
     * Live cel-ramp controls. All uniforms, so they apply to existing tiles
     * without a rebuild — except `rampSides`, which changes which materials carry
     * the injected code and therefore needs one.
     */
    setRamp(opts: {
        enabled?: boolean;
        steps?: number;
        softness?: number;
        floor?: number;
        range?: number;
        shadowTint?: THREE.ColorRepresentation;
    }): void {
        const u = this.shaderUniforms;
        if (opts.enabled !== undefined) u.rampEnabled.value = opts.enabled ? 1 : 0;
        if (opts.steps !== undefined) u.rampSteps.value = opts.steps;
        if (opts.softness !== undefined) u.rampSoftness.value = opts.softness;
        if (opts.floor !== undefined) u.rampFloor.value = opts.floor;
        if (opts.range !== undefined) u.rampRange.value = opts.range;
        if (opts.shadowTint !== undefined) u.rampShadowTint.value.set(opts.shadowTint);
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
     * `factory.getFaceTexture`) and bind it as the +Y material's `map`. The
     * patched `map_fragment` composites the transparent glyph over the cream
     * base colour. Blank codes (per the tileset, e.g. 白板 P / 5z) get the 1x1
     * transparent placeholder, so the face shows the pure cream bgColor.
     *
     * No `needsUpdate` is needed on either path: a map is bound from the
     * constructor onwards, so `USE_MAP` never toggles and three re-reads
     * `material.map` into the sampler uniform every frame.
     */
    async setCode(code: string, factory: TileTextureFactory): Promise<void> {
        const topMat = this.materials[2] as THREE.MeshStandardMaterial;

        this.glyphCode = code;
        this.applyGlyphWeight();

        if (this.tileSet.config.blankCodes.includes(code)) {
            topMat.map = getBlankGlyphTexture();
            this.shaderUniforms.sdfEnabled.value = 0;
            this.mesh.userData.tileCode = code;
            return;
        }

        if (this.tileSet.config.useSdfGlyph) {
            // Colour and shape are fetched together; both are cached per code by
            // the factory, so this costs one rasterise per distinct tile face for
            // the whole table.
            const [colorTex, sdfTex] = await Promise.all([
                factory.getFaceTexture(code),
                factory.getSDF(code),
            ]);
            topMat.map = colorTex;
            this.shaderUniforms.sdfMap.value = sdfTex;
            this.shaderUniforms.sdfEnabled.value = 1;
        } else {
            topMat.map = await factory.getFaceTexture(code);
            this.shaderUniforms.sdfEnabled.value = 0;
        }

        this.mesh.userData.tileCode = code;
    }

    /**
     * Resolve the ink weight for the bound glyph: its own entry if it has one,
     * otherwise the default, then scaled.
     */
    private applyGlyphWeight(): void {
        const override = this.glyphCode
            ? this.tileSet.config.glyphWeightByCode[this.glyphCode]
            : undefined;
        const weight = override ?? this.glyphWeightBase;
        this.shaderUniforms.glyphWeight.value = weight * this.glyphWeightScale;
    }

    /** Live default ink weight, for glyphs with no per-code entry. */
    setGlyphWeight(v: number): void {
        this.glyphWeightBase = v;
        this.applyGlyphWeight();
    }

    /** Live multiplier on the resolved weight. */
    setGlyphWeightScale(v: number): void {
        this.glyphWeightScale = v;
        this.applyGlyphWeight();
    }

    /** Toggle SDF-derived glyph edges at runtime (debug comparison). */
    setSdfEnabled(on: boolean): void {
        if (on && !this.shaderUniforms.sdfMap.value) return;
        this.shaderUniforms.sdfEnabled.value = on ? 1 : 0;
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

    /**
     * Release this tile's geometry reference and its three materials.
     *
     * The materials are per-tile (each carries its own injected program and
     * uniform objects), so leaving them to GC leaks the GPU-side program and
     * texture bindings — and every material/layout slider in the debug GUI
     * rebuilds the whole table. Geometry goes back to the shared cache and is
     * only freed when the last tile of that size releases it. Textures are
     * *not* disposed: they come from TileTextureFactory's shared caches and
     * outlive any single tile.
     */
    dispose(): void {
        releaseGeometry(this.geometryKey);
        // `materials` repeats sideMat four times; dedupe before disposing.
        for (const mat of new Set(this.materials)) mat.dispose();
        this.outlineMaterial.dispose();
    }
}
