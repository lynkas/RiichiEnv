import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import GUI from 'lil-gui';

export interface DebugScene {
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    controls: OrbitControls;
    gui: GUI;
    dirLight: THREE.DirectionalLight;
    ambientLight: THREE.AmbientLight;
    table: THREE.Mesh;
}

/**
 * Shared debug playground: dark backdrop, green felt table, a shadow-casting
 * key light, soft ambient, PMREM environment for subtle reflections, plus
 * OrbitControls + lil-gui. Returns handles so callers can populate the scene.
 */
export function setupDebugScene(container: HTMLElement): DebugScene {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a2e);

    const camera = new THREE.PerspectiveCamera(
        45,
        container.clientWidth / container.clientHeight,
        1,
        5000,
    );
    camera.position.set(400, 500, 560);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0, 0);

    // Key light (shadow caster)
    const dirLight = new THREE.DirectionalLight(0xfff5e6, 0.8);
    dirLight.position.set(200, 400, 200);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.camera.near = 100;
    dirLight.shadow.camera.far = 1500;
    dirLight.shadow.camera.left = -500;
    dirLight.shadow.camera.right = 500;
    dirLight.shadow.camera.top = 500;
    dirLight.shadow.camera.bottom = -500;
    scene.add(dirLight);

    // Fill
    const ambientLight = new THREE.AmbientLight(0x404040, 0.3);
    scene.add(ambientLight);

    // Image-based lighting for subtle reflections on tile faces
    const pmremGen = new THREE.PMREMGenerator(renderer);
    scene.environment = pmremGen.fromScene(new RoomEnvironment(), 0.04).texture;

    // Felt table
    const tableGeo = new THREE.PlaneGeometry(800, 800);
    const tableMat = new THREE.MeshStandardMaterial({ color: 0x1a3a2a, roughness: 0.8 });
    const table = new THREE.Mesh(tableGeo, tableMat);
    table.rotation.x = -Math.PI / 2;
    table.receiveShadow = true;
    scene.add(table);

    const gui = new GUI();

    function resize() {
        const w = container.clientWidth;
        const h = container.clientHeight;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
    }
    window.addEventListener('resize', resize);

    function animate() {
        requestAnimationFrame(animate);
        controls.update();
        renderer.render(scene, camera);
    }
    animate();

    return { scene, camera, renderer, controls, gui, dirLight, ambientLight, table };
}
