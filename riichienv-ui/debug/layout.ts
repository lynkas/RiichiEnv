import * as THREE from 'three';
import { Tile3D } from '../src/renderers/webgl/tile3d.js';
import { TextureCache } from '../src/renderers/webgl/textures.js';
import type { DealResult } from './deck.js';

// ============================================================
// Centralised visual constants for the 3D mahjong table.
//
// Every debug module (arena / table_body / console / layout) reads
// its dimensions, positions, camera and lighting from here so the
// whole scene can be retuned from one place. Values target a clean
// "CSS-3D UI" look: large readable tiles, steep top-down camera,
// bright even lighting, no theatrical fog or volumetric shafts.
// ============================================================

// --- Tile geometry (x1.5 realistic mm, for UI readability) ---
export const TILE_W = 32; // width  (real mahjong ~21mm)
export const TILE_H = 24; // thickness (~16.5mm)
export const TILE_D = 42; // length (~28mm)

// --- Tile spacing (derived from tile dims) ---
export const WALL_STEP = TILE_W + 0.6;
export const DEAD_GAP = WALL_STEP / 2;
export const HAND_STEP = TILE_W + 1.4;
export const HAND_Y = TILE_D / 2;
export const RIVER_STEP_X = TILE_W + 1.5;
export const RIVER_STEP_Z = TILE_D + 2.5;

// --- Table surface (octagon) ---
export const TABLE_SIZE = 800; // flat-to-flat
export const SURF_HALF = TABLE_SIZE / 2; // 400
export const SURF_CUT = 144; // corner cut -> long seat side = 512mm

// --- Rim / pedestal ---
export const RIM_OVERHANG = 50;
export const RIM_TOP = 22;
export const RIM_BOTTOM = -20;

// --- Seat-local layout positions (+Z toward the player) ---
export const WALL_Z = 260;
export const HAND_Z = 320;
export const RIVER_Z0 = 120;
export const MELD_Z = 300;
export const MELD_X0 = 230; // first meld tile X (right of the hand)

// --- Central console (tower + scoreboards) ---
export const TOWER_TIER1_H = 28;
export const TOWER_TIER2_H = 17;
export const TOWER_TOP = TOWER_TIER1_H + TOWER_TIER2_H; // 45
export const TOWER_FF1 = 272; // tier1 flat-to-flat (was 340)
export const TOWER_FF2 = 232; // tier2 flat-to-flat (was 290)
export const BOARD_DIST = 205; // scoreboard distance from centre

// --- Stage (kept for the pedestal base; mostly off-screen) ---
export const STAGE_TOP_Y = -250;
export const STAGE_RADIUS = 1600;

// --- Camera (matches CSS perspective ~1800px -> FOV 25, pitch ~48 deg) ---
export const CAMERA_FOV = 25;
export const CAMERA_POSITION: [number, number, number] = [360, 700, 480];
export const CAMERA_TARGET: [number, number, number] = [0, 20, 0];
export const CAMERA_NEAR = 1;
export const CAMERA_FAR = 6000;

// --- Lighting / atmosphere (clean UI, no theatrical effects) ---
export const SCENE_BACKGROUND = 0x0b0b14;
export const AMBIENT_INTENSITY = 0.1;
export const SPOT_COLOR = 0xfff2dd;
export const SPOT_INTENSITY = 1.2;
export const RIM_LIGHT_INTENSITY = 0.18;
export const FOG_COLOR = 0x0b0b14;
export const FOG_DENSITY = 0; // 0 = invisible (object kept for GUI tuning)
export const TONE_MAPPING_EXPOSURE = 1.0;
export const ENVIRONMENT_INTENSITY = 0.3;

// --- Seat rotations & winds (south=0, west=pi/2, north=pi, east=-pi/2).
//     Moved here so console.ts can import layout constants without a cycle. ---
export const SEAT_ROTATIONS: Record<3 | 4, number[]> = {
    4: [0, Math.PI / 2, Math.PI, -Math.PI / 2],
    3: [0, Math.PI / 2, -Math.PI / 2],
};
export const SEAT_WINDS: Record<3 | 4, string[]> = {
    4: ['東', '南', '西', '北'],
    3: ['東', '南', '西'],
};

// ============================================================
// TableLayout — per-seat wall, open hands on racks, rivers, melds.
// Built in a seat-local frame (+Z toward the player), rotated by the
// seat's Y rotation.
// ============================================================
export class TableLayout {
    private group: THREE.Group | null = null;
    private readonly parent: THREE.Object3D;
    private readonly cache: TextureCache;

    constructor(parent: THREE.Object3D, cache: TextureCache) {
        this.parent = parent;
        this.cache = cache;
    }

    async build(dealData: DealResult, players: 3 | 4, dealer: number, riichiSeat: number): Promise<void> {
        this.clear();
        this.group = new THREE.Group();
        this.group.name = 'table-layout';
        this.parent.add(this.group);

        const tasks: Promise<void>[] = [];
        const rots = SEAT_ROTATIONS[players];
        for (let seat = 0; seat < players; seat++) {
            const sg = new THREE.Group();
            sg.rotation.y = rots[seat];
            this.group.add(sg);

            this.buildWall(sg, dealData, seat, tasks);
            this.buildHand(sg, dealData.hands[seat], tasks);
            this.buildRiver(sg, dealData.discards[seat], seat === riichiSeat, seat, tasks);
            this.buildMelds(sg, dealData.ponMelds[seat], seat === dealer ? dealData.ankan : null, tasks);
            this.buildRack(sg);
            if (seat === riichiSeat) this.buildRiichiStick(sg);
        }
        await Promise.all(tasks);
    }

    clear(): void {
        if (!this.group) return;
        this.parent.remove(this.group);
        this.group.traverse((o) => {
            const m = o as THREE.Mesh;
            if (m.geometry) m.geometry.dispose();
            const mat = m.material as THREE.Material | THREE.Material[] | undefined;
            if (Array.isArray(mat)) for (const mm of mat) mm.dispose();
            else if (mat) mat.dispose();
        });
        this.group = null;
    }

    private makeTile(code: string, tasks: Promise<void>[]): Tile3D {
        const t = new Tile3D();
        t.setSideTexture(this.cache.getSide());
        tasks.push(t.setTileCode(code, this.cache));
        tasks.push(t.setBack(this.cache));
        return t;
    }

    // --- Wall (牌山) -----------------------------------------------------
    private buildWall(sg: THREE.Group, dealData: DealResult, seat: number, tasks: Promise<void>[]): void {
        interface Stack {
            bottom: string;
            top: string;
            dead: boolean;
        }
        const stacks: Stack[] = [];
        const wall = dealData.walls[seat];
        for (let i = 0; i + 1 < wall.length; i += 2) {
            stacks.push({ bottom: wall[i], top: wall[i + 1], dead: false });
        }
        if (seat === 0) {
            const dw = dealData.deadWall;
            for (let i = 0; i + 1 < dw.length; i += 2) {
                stacks.push({ bottom: dw[i], top: dw[i + 1], dead: true });
            }
        }

        const gap = seat === 0 ? DEAD_GAP : 0;
        const width = stacks.length * WALL_STEP + gap;
        let x = -width / 2 + WALL_STEP / 2;
        let seenDead = false;

        stacks.forEach((st, i) => {
            if (st.dead && !seenDead) {
                x += gap;
                seenDead = true;
            }
            const bottom = this.makeTile(st.bottom, tasks);
            bottom.setPosition(x, TILE_H / 2, WALL_Z);
            bottom.flip();
            sg.add(bottom.mesh);

            const top = this.makeTile(st.top, tasks);
            top.setPosition(x, TILE_H + TILE_H / 2, WALL_Z);
            // Dora indicator: top tile of the 3rd stack from the dead end.
            const isIndicator = st.dead && i === stacks.length - 3;
            if (!isIndicator) top.flip();
            sg.add(top.mesh);

            x += WALL_STEP;
        });
    }

    // --- Hand (手牌, open / face the seat) --------------------------------
    private buildHand(sg: THREE.Group, hand: string[], tasks: Promise<void>[]): void {
        hand.forEach((code, i) => {
            const t = this.makeTile(code, tasks);
            const x = (i - (hand.length - 1) / 2) * HAND_STEP;
            t.setPosition(x, HAND_Y, HAND_Z);
            // Stand the tile: glyph face (+Y) turned toward the player (+Z).
            t.mesh.rotation.x = Math.PI / 2;
            sg.add(t.mesh);
        });
    }

    private buildRack(sg: THREE.Group): void {
        const width = 13 * HAND_STEP + 16;
        const rack = new THREE.Mesh(
            new THREE.BoxGeometry(width, 6, 34),
            new THREE.MeshStandardMaterial({ color: 0x0b0b0d, roughness: 0.5, metalness: 0.6 }),
        );
        rack.position.set(0, 3, HAND_Z + 8);
        rack.castShadow = true;
        rack.receiveShadow = true;

        const edge = new THREE.Mesh(
            new THREE.BoxGeometry(width, 1.6, 2),
            new THREE.MeshStandardMaterial({
                color: 0xd4af37,
                emissive: 0xd4af37,
                emissiveIntensity: 0.15,
                roughness: 0.3,
                metalness: 1,
            }),
        );
        edge.position.set(0, 6.4, HAND_Z - 9);
        sg.add(rack, edge);
    }

    // --- River (舍牌) ------------------------------------------------------
    private buildRiver(
        sg: THREE.Group,
        discards: string[],
        riichi: boolean,
        seat: number,
        tasks: Promise<void>[],
    ): void {
        discards.forEach((code, i) => {
            const row = Math.floor(i / 6);
            const col = i % 6;
            const t = this.makeTile(code, tasks);
            const x = (col - 2.5) * RIVER_STEP_X;
            const z = RIVER_Z0 + row * RIVER_STEP_Z;
            t.setPosition(x, TILE_H / 2, z);
            // ±2 deg deterministic jitter.
            const pseudo = Math.sin(i * 12.9898 + seat * 78.233) * 43758.5453;
            const jitter = (pseudo - Math.floor(pseudo) - 0.5) * ((4 * Math.PI) / 180);
            t.mesh.rotation.y = jitter;
            if (riichi && i === 3) t.mesh.rotation.y += Math.PI / 2; // riichi turn
            sg.add(t.mesh);
        });
    }

    private buildRiichiStick(sg: THREE.Group): void {
        const stick = new THREE.Group();
        const black = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.35, metalness: 0.3 });
        const gold = new THREE.MeshStandardMaterial({
            color: 0xd4af37,
            emissive: 0xd4af37,
            emissiveIntensity: 0.2,
            roughness: 0.3,
            metalness: 1,
        });

        const body = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 65, 16), black);
        body.rotation.z = Math.PI / 2; // along local X
        body.castShadow = true;

        const ringL = new THREE.Mesh(new THREE.CylinderGeometry(2.9, 2.9, 3, 16), gold);
        ringL.rotation.z = Math.PI / 2;
        ringL.position.x = -27;
        const ringR = ringL.clone();
        ringR.position.x = 27;

        const dot = new THREE.Mesh(
            new THREE.CylinderGeometry(1.6, 1.6, 4.8, 12),
            new THREE.MeshStandardMaterial({ color: 0xff3322, emissive: 0xff3322, emissiveIntensity: 0.4 }),
        );

        stick.add(body, ringL, ringR, dot);
        stick.position.set(0, 2.4, RIVER_Z0 - 26);
        sg.add(stick);
    }

    // --- Melds (副露) -------------------------------------------------------
    private buildMelds(sg: THREE.Group, pon: string[], ankan: string[] | null, tasks: Promise<void>[]): void {
        // Pon: 3 face-up, middle one sideways and nudged toward the player.
        pon.forEach((code, i) => {
            const t = this.makeTile(code, tasks);
            t.setPosition(MELD_X0 + i * (TILE_W + 1.5), TILE_H / 2, MELD_Z + (i === 1 ? 12 : 0));
            if (i === 1) t.mesh.rotation.y = Math.PI / 2;
            sg.add(t.mesh);
        });

        // Dealer's concealed kan: ends face-down, middle two face-up.
        if (ankan) {
            ankan.forEach((code, i) => {
                const t = this.makeTile(code, tasks);
                t.setPosition(MELD_X0 + i * (TILE_W + 1.5), TILE_H / 2, MELD_Z - 36);
                if (i === 0 || i === 3) t.flip();
                sg.add(t.mesh);
            });
        }
    }
}
