import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';

/**
 * Post-processing chain: bloom + colour grade, rendered through a multisampled
 * half-float target.
 *
 * Three details matter more than the pass list:
 *
 * 1. **Half-float target.** When the renderer draws into a render target it
 *    skips tone mapping in the materials (three expects OutputPass to do it).
 *    So the buffer bloom sees is linear HDR, and values above 1.0 survive —
 *    which is what makes a *threshold* meaningful. On an LDR 8-bit buffer
 *    everything is already clamped and thresholded bloom either does nothing
 *    or fogs the whole frame.
 *
 * 2. **Antialiasing via MSAA + SMAA.** EffectComposer bypasses the default
 *    framebuffer, so the `antialias: true` passed to WebGLRenderer stops applying,
 *    and adding post-processing without replacing it makes the image *worse* — the
 *    classic "why is it aliased now" trap.
 *
 *    `samples: 4` on the composer's target is the obvious replacement. It was
 *    dropped at one point on suspicion that a multisampled float target, swapped
 *    between two buffers and resolved every frame, was behind an intermittent
 *    screen-aligned rectangle going black. Later bisection pinned that artefact
 *    on UnrealBloomPass instead (now off by default — see `bloomEnabled`), so
 *    MSAA is re-enabled. SMAA stays on top of it, after tone mapping: MSAA only
 *    helps geometry edges, not the shader-driven edges inside tiles.
 *
 * 3. **Threshold instead of a selective-bloom pass.** Proper selective bloom
 *    means rendering the scene a second time with every non-glowing material
 *    swapped to black. With ~400 tile materials that is a lot of machinery for
 *    the same result you get by putting the glow above 1.0 and everything else
 *    below it. Emissive values are authored to exceed 1.0; lit surfaces land
 *    under it.
 *
 *    This only works while that separation actually holds, and it is fragile:
 *    hardening the specular raised the tile faces to roughly the same level as
 *    the threshold, so bloom started harvesting every highlight in the frame and
 *    veiling the cloth around the tile clusters by ~10 luma — the image read as
 *    slightly out of focus. Meanwhile the gold trim it was added for was not
 *    crossing the threshold at all (measured: bloom changed the trim by under
 *    2 luma, i.e. nothing).
 *
 *    So the threshold sits well clear of the lit surfaces, and anything that is
 *    supposed to glow is pushed above it explicitly. A cel highlight is a flat
 *    shape and must never bloom; only genuinely emissive things should.
 *
 * The overlay hand is deliberately *not* part of this chain. It used to be a
 * RenderPass injected between the other passes with `clear = false, clearDepth =
 * true`, which is an unusual construct: a scene render writing into a
 * ping-ponged post buffer, relying on EffectComposer's read/write bookkeeping
 * being where you assume. It also bought nothing — the hand is UI and was already
 * composited after grading, so it received neither bloom nor grade. The caller now
 * draws it straight to the canvas after `composer.render()`, which is simpler and
 * removes a whole class of buffer-ordering failure.
 */

export interface PostSettings {
    enabled: boolean;
    /**
     * Bloom on/off. Default **false**.
     *
     * Off because it is the one pass in this chain that has been observed to
     * misbehave — an intermittent screen-aligned rectangle going black while the
     * camera moves, confirmed by bisection to disappear when this pass is disabled.
     * It is also the most complex: a five-level mip pyramid, its own clear-colour
     * juggling, and it both samples from and additively blends back into the
     * composer's read buffer, so a mismatch at any pyramid level lands as exactly
     * that kind of rectangular artefact.
     *
     * Turning it off costs nothing measurable: with `bloomThreshold` at 1.6 and the
     * only emissive object in the scene (the gold trim at `goldEmissive` 2.4) topping
     * out at a linear luma of 0.90, the threshold was never crossed. A whole-frame
     * diff with it on versus off is *identical* — 0 pixels different.
     *
     * If a genuine glow is wanted later, the trim needs `goldEmissive` above ~5 to
     * clear the threshold at all — and at that point prefer a small purpose-built
     * bloom (downsample, separable blur, additive composite) over re-enabling this
     * pass, rather than re-introducing the artefact.
     */
    bloomEnabled: boolean;
    gradeEnabled: boolean;
    smaaEnabled: boolean;
    bloomStrength: number;
    bloomRadius: number;
    bloomThreshold: number;
    /**
     * Tone-mapping exposure. Default 0.85.
     *
     * This is the only lever that actually reaches overall tile brightness. The
     * Khronos Neutral curve compresses the top end hard, so changes to tile albedo
     * or to the cel ramp's headroom get squashed: measured, dropping the albedo 10
     * luma moved the rendered lacquer median by 4, and cutting rampRange from 1.25
     * to 1.05 moved it by 2. Exposure sits before the curve and moves the whole
     * frame through it.
     *
     * 0.72 matches a Mahjong Soul reference frame: lacquer mean 206.1 against its
     * 204.9, cloth median 74.3 against its 74.7, tile-to-cloth gap 136 against 132.
     *
     * Calibrated against the *table area only*. Measuring the reference whole-frame
     * reads high, because white UI text and panels land in the same bright low-chroma
     * bucket as tile lacquer — that inflated the reference lacquer mean to 220 and
     * hid the fact that the render was still ~15 luma hot.
     */
    exposure: number;
    saturation: number;
    contrast: number;
    /**
     * Linear value that `contrast` pivots around. Default 0.055.
     *
     * The usual 0.18 mid-grey pivot is wrong for this frame. The cloth sits near
     * 0.04 in linear — far *below* the pivot — so raising contrast to recover
     * punch drove the cloth down with the shadows instead of leaving it put:
     * measured, contrast 1.14 at a 0.18 pivot took the cloth from 55.8 to 28.8
     * and collapsed midtone occupancy from 37% back to 6%.
     *
     * Pivoting near the cloth's own value instead deepens the void and lifts the
     * tiles while leaving the largest area of the frame where it is — which is
     * what "keep the midtones, restore the anchors" actually requires.
     */
    contrastPivot: number;
    /**
     * Raises the black floor, remapping [0,1] to [lift,1] in linear space.
     *
     * Keep this small. An additive shift in linear space lifts darks far more than
     * lights in perceptual terms (sRGB is a power curve), which makes it a very
     * effective way to open up shadows — and an equally effective way to destroy
     * the image if overdone. At 0.045 it took the frame's 1st-percentile luma from
     * 0 to 22 and the 5th from 0 to 27: no true black anywhere, RMS contrast down
     * 21%, and the whole thing read as grey and washed out.
     *
     * A cel frame is midtone-dominant in its large flat areas but still needs its
     * anchors — genuine black in the linework, clean white in the highlights. Get
     * the midtones from where the surfaces actually sit (cloth albedo, tile
     * albedo), not by lifting everything including the blacks.
     */
    lift: number;
    vignette: number;
    /**
     * Static screen-space grain, as a peak amplitude in linear space.
     *
     * Weighted toward the midtones so it never crushes the blacks or dirties the
     * highlights. Static rather than animated: film grain that crawls reads as
     * video noise, whereas a fixed fine texture reads as paper — and a game frame
     * that shimmers when nothing is moving looks broken.
     *
     * This is the "something in the frame is soft" element. Depth of field would
     * be the other candidate and is deliberately not used: BokehPass needs a
     * second full scene render for depth, and at a 22.6 degree FOV over a ~700mm
     * deep subject the circle of confusion is tiny, so the cost buys almost
     * nothing. Fog does the depth separation instead, for free.
     */
    grain: number;
    /** Cool tint pushed into the shadows, warm into the highlights. */
    splitTone: number;
}

export const POST_DEFAULTS: PostSettings = {
    enabled: true,
    bloomEnabled: false,
    gradeEnabled: true,
    smaaEnabled: true,
    bloomStrength: 0.22,
    bloomRadius: 0.3,
    bloomThreshold: 1.6,
    exposure: 0.72,
    saturation: 1.12,
    contrast: 1.24,
    contrastPivot: 0.04,
    lift: 0.006,
    vignette: 0.28,
    grain: 0.005,
    splitTone: 0.1,
};

/**
 * Grade pass. Runs in linear HDR *before* OutputPass, so tone mapping and the
 * sRGB encode still happen last and this only has to shape the light.
 */
const GradeShader = {
    name: 'GradeShader',
    uniforms: {
        tDiffuse: { value: null as THREE.Texture | null },
        saturation: { value: 1.0 },
        contrast: { value: 1.0 },
        contrastPivot: { value: 0.18 },
        lift: { value: 0.0 },
        vignette: { value: 0.0 },
        grain: { value: 0.0 },
        splitTone: { value: 0.0 },
        shadowTint: { value: new THREE.Color(0x6f8fd0) },
        highlightTint: { value: new THREE.Color(0xffe6c0) },
    },
    vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }
    `,
    fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform float saturation;
        uniform float contrast;
        uniform float contrastPivot;
        uniform float lift;
        uniform float vignette;
        uniform float grain;
        uniform float splitTone;
        uniform vec3 shadowTint;
        uniform vec3 highlightTint;
        varying vec2 vUv;

        void main() {
            vec4 texel = texture2D( tDiffuse, vUv );
            vec3 c = texel.rgb;

            // Rec.709 linear luma — the buffer is linear at this point.
            float luma = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );

            c = mix( vec3( luma ), c, saturation );
            // Contrast about a tunable pivot, in linear. The pivot sits near the
            // cloth's own value, not at 18% grey — see contrastPivot.
            c = ( c - contrastPivot ) * contrast + contrastPivot;
            // Raise the black floor: [0,1] -> [lift,1]. Compresses the range
            // from below, which is what moves pixels into the midtones.
            c = lift + c * ( 1.0 - lift );

            // Split toning: cool the dark end, warm the bright end. Cheap way
            // to get the warm-light / cool-shadow separation to read even where
            // the lighting alone did not carry it.
            float t = clamp( luma * 1.6, 0.0, 1.0 );
            vec3 tint = mix( shadowTint, highlightTint, t );
            c = mix( c, c * tint * 1.35, splitTone );

            // Radial vignette, measured from frame centre in aspect-free UV.
            vec2 d = vUv - 0.5;
            float r = length( d ) * 1.41421356;
            c *= 1.0 - vignette * smoothstep( 0.45, 1.0, r );

            // Fine static grain. Hashed from the pixel coordinate so it is fixed
            // in screen space, and weighted by a midtone bell so the blacks stay
            // clean and the highlights stay clean.
            if ( grain > 0.0 ) {
                float n = fract( sin( dot( gl_FragCoord.xy, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
                float mid = 1.0 - abs( clamp( luma * 2.4, 0.0, 2.0 ) - 1.0 );
                c += ( n - 0.5 ) * 2.0 * grain * mid;
            }

            gl_FragColor = vec4( max( c, vec3( 0.0 ) ), texel.a );
        }
    `,
};

export interface PostChain {
    composer: EffectComposer;
    bloomPass: UnrealBloomPass;
    gradePass: ShaderPass;
    smaaPass: SMAAPass;
    setSize(width: number, height: number): void;
    apply(s: PostSettings): void;
    dispose(): void;
}

export function createPostChain(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
): PostChain {
    const size = renderer.getSize(new THREE.Vector2());
    const pixelRatio = renderer.getPixelRatio();
    // Floor of 2, not 1.5: at DPR=1 a 1.5x buffer ends in a 1.5:1 *fractional*
    // bilinear downsample on the final pass, which undersamples and shows up as
    // moire/jaggies on 1080p screens (and runs SMAA at the wrong resolution).
    // 2x is an integer ratio, so the 2:1 downsample approximates a box filter —
    // effectively 2x SSAA. At DPR=2 the ratio is already 2, so nothing changes
    // on 2K/Retina screens, which is why the artefact only appeared at 1080p.
    const internalRatio = Math.max(pixelRatio, 2);

    const target = new THREE.WebGLRenderTarget(
        size.x * internalRatio,
        size.y * internalRatio,
        {
            type: THREE.HalfFloatType,
            colorSpace: THREE.LinearSRGBColorSpace,
            // MSAA x4. Previously dropped as the suspect for the black-rectangle
            // artefact; bisection later blamed UnrealBloomPass instead, so this
            // is safe to re-enable while bloom stays off by default.
            samples: 4,
        },
    );

    const composer = new EffectComposer(renderer, target);
    composer.setPixelRatio(internalRatio);
    composer.setSize(size.x, size.y);

    composer.addPass(new RenderPass(scene, camera));

    const bloomPass = new UnrealBloomPass(
        new THREE.Vector2(size.x, size.y),
        POST_DEFAULTS.bloomStrength,
        POST_DEFAULTS.bloomRadius,
        POST_DEFAULTS.bloomThreshold,
    );
    composer.addPass(bloomPass);

    const gradePass = new ShaderPass(GradeShader);
    composer.addPass(gradePass);

    // Tone mapping + sRGB encode.
    composer.addPass(new OutputPass());

    // Antialiasing last, after tone mapping, so edge detection runs on the values
    // actually being displayed rather than on linear HDR where a bright edge and a
    // very bright one are far apart numerically but identical once mapped.
    const smaaPass = new SMAAPass();
    composer.addPass(smaaPass);

    function apply(s: PostSettings): void {
        // Toggleable so the chain can be bisected when something goes wrong in it.
        bloomPass.enabled = s.bloomEnabled;
        gradePass.enabled = s.gradeEnabled;
        smaaPass.enabled = s.smaaEnabled;
        bloomPass.strength = s.bloomStrength;
        bloomPass.radius = s.bloomRadius;
        bloomPass.threshold = s.bloomThreshold;
        gradePass.uniforms.saturation.value = s.saturation;
        gradePass.uniforms.contrast.value = s.contrast;
        gradePass.uniforms.contrastPivot.value = s.contrastPivot;
        gradePass.uniforms.lift.value = s.lift;
        gradePass.uniforms.vignette.value = s.vignette;
        gradePass.uniforms.grain.value = s.grain;
        gradePass.uniforms.splitTone.value = s.splitTone;
        renderer.toneMappingExposure = s.exposure;
    }
    apply(POST_DEFAULTS);

    return {
        composer,
        bloomPass,
        gradePass,
        smaaPass,
        setSize(width, height) {
            // Same 2x floor as the constructor — see internalRatio above.
            const ratio = Math.max(renderer.getPixelRatio(), 2);
            composer.setPixelRatio(ratio);
            composer.setSize(width, height);
        },
        apply,
        dispose() {
            composer.dispose();
            target.dispose();
        },
    };
}
