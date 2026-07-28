import * as THREE from 'three';
import { Tile3D } from '../src/renderers/webgl/tile3d.js';
import { TextureCache } from '../src/renderers/webgl/textures.js';
import { SEAT_ROTATIONS } from './console.js';
import type { DealResult } from './deck.js';

/**
 * Table layout: per-seat wall (face-down double-layer stacks, with the
 * dead wall + dora indicator on seat 0), open standing hands on black
 * gold-edged racks, rivers with a riichi turn for the demo riichi seat,
 * and example melds (pon for everyone, ankan for the dealer).
 *
 * Everything is built in a seat-local frame (+Z toward the player) and
 * rotated by the seat's Y rotation.
 */

const TILE_W = 21;
const TILE_H = 16.5;
const TILE_D = 28;

const WALL_Z = 360;
const WALL_STEP = TILE_W + 0.6;
const DEAD_GAP = WALL_STEP / 2;

const HAND_Z = 432;
const HAND_STEP = TILE_W + 1.4;
const HAND_Y = TILE_D / 2;

const RIVER_Z0 = 178;
const RIVER_STEP_X = TILE_W + 1.5;
const RIVER_STEP_Z = TILE_D + 2.5;

const MELD_Z = 430;

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
                emissiveIntensity: 0.25,
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
            // ±2° deterministic jitter.
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
            emissiveIntensity: 0.3,
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
            t.setPosition(300 + i * (TILE_W + 1.5), TILE_H / 2, MELD_Z + (i === 1 ? 12 : 0));
            if (i === 1) t.mesh.rotation.y = Math.PI / 2;
            sg.add(t.mesh);
        });

        // Dealer's concealed kan: ends face-down, middle two face-up.
        // Placed centre-side of the pon so it stays clear of the cut corner.
        if (ankan) {
            ankan.forEach((code, i) => {
                const t = this.makeTile(code, tasks);
                t.setPosition(300 + i * (TILE_W + 1.5), TILE_H / 2, MELD_Z - 36);
                if (i === 0 || i === 3) t.flip();
                sg.add(t.mesh);
            });
        }
    }
}
