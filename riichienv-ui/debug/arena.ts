import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { gsap } from 'gsap';

/**
 * "Black-gold arena" stage: dark void, one warm key spotlight over the
 * table, low gold rim lights in the corners, glossy round stage with a
 * thin gold ring, and a faint additive light cone under the spotlight.
 */

export interface Arena {
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    controls: OrbitControls;
    spot: THREE.SpotLight;
    rimLights: THREE.PointLight[];
    onTick(cb: (dt: number, t: number) => void): void;
    flyTo(pos: [number, number, number], target: [number, number, number]): void;
}

export const STAGE_TOP_Y = -250;

export function createArena(parent: HTMLElement): Arena {
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.9;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    parent.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x050505);
    scene.fog = new THREE.FogExp2(0x050505, 0.00032);

    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.22;
    pmrem.dispose();

    const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 1, 8000);
    camera.position.set(520, 620, 680);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI / 2 - 0.06;
    controls.minDistance = 300;
    controls.maxDistance = 2500;
    controls.target.set(0, 20, 0);

    // --- Stage disc -----------------------------------------------------
    const stage = new THREE.Mesh(
        new THREE.CylinderGeometry(1600, 1600, 40, 96),
        new THREE.MeshPhysicalMaterial({
            color: 0x08080a,
            roughness: 0.32,
            metalness: 0.15,
            clearcoat: 1,
            clearcoatRoughness: 0.22,
        }),
    );
    stage.position.y = STAGE_TOP_Y - 20;
    stage.receiveShadow = true;
    scene.add(stage);

    const stageRing = new THREE.Mesh(
        new THREE.TorusGeometry(1200, 2.5, 8, 160),
        new THREE.MeshStandardMaterial({
            color: 0xd4af37,
            emissive: 0xd4af37,
            emissiveIntensity: 0.45,
            roughness: 0.3,
            metalness: 1,
        }),
    );
    stageRing.rotation.x = Math.PI / 2;
    stageRing.position.y = STAGE_TOP_Y + 1;
    scene.add(stageRing);

    // --- Lights ---------------------------------------------------------
    const spot = new THREE.SpotLight(0xfff2dd, 1.5, 0, 0.55, 0.45, 0);
    spot.position.set(0, 1200, 0);
    spot.target.position.set(0, 0, 0);
    spot.castShadow = true;
    spot.shadow.mapSize.set(2048, 2048);
    spot.shadow.camera.near = 500;
    spot.shadow.camera.far = 1800;
    spot.shadow.bias = -0.0002;
    spot.shadow.normalBias = 1.5;
    scene.add(spot, spot.target);

    const rimLights: THREE.PointLight[] = [];
    const corners: [number, number, number][] = [
        [950, 80, 950],
        [950, 80, -950],
        [-950, 80, 950],
        [-950, 80, -950],
    ];
    for (const [x, y, z] of corners) {
        const p = new THREE.PointLight(0xd4af37, 0.55, 0, 0);
        p.position.set(x, y, z);
        scene.add(p);
        rimLights.push(p);
    }
    scene.add(new THREE.AmbientLight(0xffffff, 0.035));

    // Faint volumetric light shaft under the key light.
    const shaft = new THREE.Mesh(
        new THREE.ConeGeometry(720, 1150, 64, 1, true),
        new THREE.MeshBasicMaterial({
            color: 0xfff2dd,
            transparent: true,
            opacity: 0.03,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
            depthWrite: false,
            fog: false,
        }),
    );
    shaft.position.y = 625; // apex ~1200 (spot), base ~50 (just above felt)
    scene.add(shaft);

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
        rimLights,
        onTick(cb) {
            tickCbs.push(cb);
        },
        flyTo(pos, target) {
            gsap.to(camera.position, { x: pos[0], y: pos[1], z: pos[2], duration: 1.4, ease: 'power2.inOut' });
            gsap.to(controls.target, { x: target[0], y: target[1], z: target[2], duration: 1.4, ease: 'power2.inOut' });
        },
    };
}
