import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { gsap } from 'gsap';
import {
    AMBIENT_INTENSITY,
    CAMERA_FAR,
    CAMERA_FOV,
    CAMERA_NEAR,
    CAMERA_POSITION,
    CAMERA_TARGET,
    ENVIRONMENT_INTENSITY,
    FOG_COLOR,
    FOG_DENSITY,
    RIM_LIGHT_INTENSITY,
    SCENE_BACKGROUND,
    SPOT_COLOR,
    SPOT_INTENSITY,
    STAGE_RADIUS,
    STAGE_TOP_Y,
    TONE_MAPPING_EXPOSURE,
} from './layout.js';

/**
 * Clean UI arena: dark backdrop, one soft key spotlight, bright ambient
 * fill, dim gold corner accents. No volumetric shaft, no heavy fog —
 * matches the flat CSS-3D renderer look. The stage disc is kept only as
 * a base for the pedestal and sits mostly outside the closer camera.
 */

export interface Arena {
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    controls: OrbitControls;
    spot: THREE.SpotLight;
    ambient: THREE.AmbientLight;
    rimLights: THREE.PointLight[];
    fog: THREE.FogExp2;
    onTick(cb: (dt: number, t: number) => void): void;
    flyTo(pos: [number, number, number], target: [number, number, number]): void;
}

export function createArena(parent: HTMLElement): Arena {
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    parent.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(SCENE_BACKGROUND);
    // Fog object always present (density 0 = invisible) so the GUI can
    // dial it up live without rebuilding the scene.
    const fog = new THREE.FogExp2(FOG_COLOR, FOG_DENSITY);
    scene.fog = fog;

    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = ENVIRONMENT_INTENSITY;
    pmrem.dispose();

    const camera = new THREE.PerspectiveCamera(
        CAMERA_FOV,
        window.innerWidth / window.innerHeight,
        CAMERA_NEAR,
        CAMERA_FAR,
    );
    camera.position.set(...CAMERA_POSITION);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI / 2 - 0.04;
    controls.minDistance = 200;
    controls.maxDistance = 2000;
    controls.target.set(...CAMERA_TARGET);

    // --- Stage disc (pedestal base, peripheral) -------------------------
    const stage = new THREE.Mesh(
        new THREE.CylinderGeometry(STAGE_RADIUS, STAGE_RADIUS, 40, 96),
        new THREE.MeshPhysicalMaterial({
            color: 0x08080a,
            roughness: 0.45,
            metalness: 0.15,
            clearcoat: 0.6,
            clearcoatRoughness: 0.4,
        }),
    );
    stage.position.y = STAGE_TOP_Y - 20;
    stage.receiveShadow = true;
    scene.add(stage);

    const stageRing = new THREE.Mesh(
        new THREE.TorusGeometry(STAGE_RADIUS * 0.75, 2.5, 8, 160),
        new THREE.MeshStandardMaterial({
            color: 0xd4af37,
            emissive: 0xd4af37,
            emissiveIntensity: 0.2,
            roughness: 0.3,
            metalness: 1,
        }),
    );
    stageRing.rotation.x = Math.PI / 2;
    stageRing.position.y = STAGE_TOP_Y + 1;
    scene.add(stageRing);

    // --- Lights (clean, even UI lighting) -------------------------------
    const spot = new THREE.SpotLight(SPOT_COLOR, SPOT_INTENSITY, 0, 0.6, 0.5, 0);
    spot.position.set(0, 1200, 0);
    spot.target.position.set(0, 0, 0);
    spot.castShadow = true;
    spot.shadow.mapSize.set(2048, 2048);
    spot.shadow.camera.near = 200;
    spot.shadow.camera.far = 2000;
    spot.shadow.bias = -0.0002;
    spot.shadow.normalBias = 1.5;
    scene.add(spot, spot.target);

    const ambient = new THREE.AmbientLight(0xffffff, AMBIENT_INTENSITY);
    scene.add(ambient);

    const rimLights: THREE.PointLight[] = [];
    const corners: [number, number, number][] = [
        [950, 80, 950],
        [950, 80, -950],
        [-950, 80, 950],
        [-950, 80, -950],
    ];
    for (const [x, y, z] of corners) {
        const p = new THREE.PointLight(0xd4af37, RIM_LIGHT_INTENSITY, 0, 0);
        p.position.set(x, y, z);
        scene.add(p);
        rimLights.push(p);
    }

    // (The theatrical volumetric light shaft is intentionally removed.)

    // --- Loop / resize ----------------------------------------------------
    const tickCbs: ((dt: number, t: number) => void)[] = [];
    const clock = new THREE.Clock();
    renderer.setAnimationLoop(() => {
        const dt = Math.min(clock.getDelta(), 0.05);
        for (const cb of tickCbs) cb(dt, clock.elapsedTime);
        controls.update();
        renderer.render(scene, camera);
    });

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    return {
        scene,
        camera,
        renderer,
        controls,
        spot,
        ambient,
        rimLights,
        fog,
        onTick(cb) {
            tickCbs.push(cb);
        },
        flyTo(pos, target) {
            gsap.to(camera.position, { x: pos[0], y: pos[1], z: pos[2], duration: 1.4, ease: 'power2.inOut' });
            gsap.to(controls.target, { x: target[0], y: target[1], z: target[2], duration: 1.4, ease: 'power2.inOut' });
        },
    };
}
