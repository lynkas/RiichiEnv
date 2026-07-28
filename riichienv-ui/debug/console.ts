import * as THREE from 'three';
import { DicePair } from './dice.js';
import { makeLedPanel, ledText, ledDot, ledFont, type LedPanel } from './led.js';
import {
    BOARD_DIST,
    SEAT_ROTATIONS,
    SEAT_WINDS,
    TOWER_FF1,
    TOWER_FF2,
    TOWER_TIER1_H,
    TOWER_TIER2_H,
    TOWER_TOP,
} from './layout.js';

/**
 * Central console: a two-tier octagonal crystal tower with glowing gold
 * seams, a glass dome over two dice, per-seat standing scoreboards
 * (gold frame + LED face) and per-seat LED info bars embedded in the
 * upper tier's vertical faces. All proportions come from layout.ts.
 */

export interface ConsoleState {
    players: 3 | 4;
    roundWind: string; // '東' | '南'
    kyokuNum: number; // 1-4
    honba: number;
    riichiSticks: number;
    remaining: number;
    dealer: number; // seat index
    scores: number[];
    riichi: boolean[];
}

interface SeatBoard {
    frameMat: THREE.MeshStandardMaterial;
    panel: LedPanel;
    bar: LedPanel;
    objects: THREE.Object3D[];
}

export class ArenaConsole {
    readonly group = new THREE.Group();
    private readonly dice: DicePair;
    private seatRoot: THREE.Group | null = null;
    private boards: SeatBoard[] = [];
    private pulseT = 0;
    private state: ConsoleState | null = null;

    constructor(parent: THREE.Object3D) {
        this.group.name = 'arena-console';
        parent.add(this.group);
        this.buildTower();
        this.dice = new DicePair(this.group, TOWER_TOP + 2 + 6);
    }

    // --- Static tower -------------------------------------------------
    private buildTower(): void {
        const crystal = new THREE.MeshPhysicalMaterial({
            color: 0x0a0a0c,
            roughness: 0.18,
            metalness: 0.3,
            clearcoat: 1,
            clearcoatRoughness: 0.1,
        });
        const goldGlow = new THREE.MeshStandardMaterial({
            color: 0xd4af37,
            emissive: 0xd4af37,
            emissiveIntensity: 0.45,
            roughness: 0.3,
            metalness: 1,
        });

        const r1 = TOWER_FF1 / 2 / Math.cos(Math.PI / 8); // flat-to-flat TOWER_FF1
        const r2 = TOWER_FF2 / 2 / Math.cos(Math.PI / 8); // flat-to-flat TOWER_FF2

        const tier1 = new THREE.Mesh(new THREE.CylinderGeometry(r1, r1, TOWER_TIER1_H, 8), crystal);
        tier1.rotation.y = Math.PI / 8;
        tier1.position.y = TOWER_TIER1_H / 2;
        tier1.castShadow = true;
        tier1.receiveShadow = true;

        const seam1 = new THREE.Mesh(new THREE.TorusGeometry(r1 - 4, 1.3, 4, 8), goldGlow);
        seam1.rotation.set(Math.PI / 2, 0, Math.PI / 8); // spin in-plane first, then lay flat
        seam1.position.y = TOWER_TIER1_H;

        const tier2 = new THREE.Mesh(new THREE.CylinderGeometry(r2, r2, TOWER_TIER2_H, 8), crystal);
        tier2.rotation.y = Math.PI / 8;
        tier2.position.y = TOWER_TIER1_H + TOWER_TIER2_H / 2;
        tier2.castShadow = true;

        const seam2 = new THREE.Mesh(new THREE.TorusGeometry(r2 - 4, 1.3, 4, 8), goldGlow);
        seam2.rotation.set(Math.PI / 2, 0, Math.PI / 8);
        seam2.position.y = TOWER_TOP;

        // Dice recess: black plate + gold ring + glass dome.
        const plate = new THREE.Mesh(
            new THREE.CylinderGeometry(50, 50, 2, 48),
            new THREE.MeshStandardMaterial({ color: 0x08080a, roughness: 0.4, metalness: 0.4 }),
        );
        plate.position.y = TOWER_TOP + 1;

        const domeRing = new THREE.Mesh(new THREE.TorusGeometry(56, 2, 8, 48), goldGlow);
        domeRing.rotation.x = Math.PI / 2;
        domeRing.position.y = TOWER_TOP + 2;

        const dome = new THREE.Mesh(
            new THREE.SphereGeometry(54, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2),
            new THREE.MeshPhysicalMaterial({
                color: 0xffffff,
                transparent: true,
                opacity: 0.18,
                roughness: 0.05,
                metalness: 0,
                clearcoat: 1,
                depthWrite: false,
            }),
        );
        dome.position.y = TOWER_TOP + 2;

        this.group.add(tier1, seam1, tier2, seam2, plate, domeRing, dome);
    }

    // --- Per-seat scoreboards + info bars ------------------------------
    setSeats(players: 3 | 4): void {
        if (this.seatRoot) {
            this.group.remove(this.seatRoot);
            for (const b of this.boards) {
                b.panel.dispose();
                b.bar.dispose();
                for (const o of b.objects) {
                    const m = o as THREE.Mesh;
                    if (m.geometry) m.geometry.dispose();
                    const mat = m.material as THREE.Material | undefined;
                    if (mat) mat.dispose();
                }
            }
            this.boards = [];
        }
        this.seatRoot = new THREE.Group();
        this.group.add(this.seatRoot);

        const rots = SEAT_ROTATIONS[players];
        for (let i = 0; i < players; i++) {
            const sg = new THREE.Group();
            sg.rotation.y = rots[i];
            this.seatRoot.add(sg);
            this.boards.push(this.buildSeatBoard(sg));
        }
    }

    private buildSeatBoard(sg: THREE.Group): SeatBoard {
        const objects: THREE.Object3D[] = [];

        // Standing scoreboard, tilted back ~10 deg, facing the seat.
        const frameMat = new THREE.MeshStandardMaterial({
            color: 0xd4af37,
            emissive: 0xd4af37,
            emissiveIntensity: 0.12,
            roughness: 0.3,
            metalness: 1,
        });
        const frame = new THREE.Mesh(new THREE.BoxGeometry(186, 78, 4), frameMat);
        frame.position.set(0, 37, 0);

        const glass = new THREE.Mesh(
            new THREE.BoxGeometry(180, 72, 6),
            new THREE.MeshPhysicalMaterial({
                color: 0x0a0a0c,
                roughness: 0.12,
                metalness: 0.2,
                clearcoat: 1,
            }),
        );
        glass.position.set(0, 37, 2);

        const panel = makeLedPanel(172, 64, 4);
        panel.mesh.position.set(0, 37, 5.4);

        const stand = new THREE.Group();
        stand.add(frame, glass, panel.mesh);
        stand.position.set(0, 1, BOARD_DIST);
        stand.rotation.x = -10 * (Math.PI / 180); // lean back, top toward centre
        sg.add(stand);
        objects.push(frame, glass);

        // Info bar embedded in the upper tier's vertical face.
        const bar = makeLedPanel(118, 24, 4);
        bar.mesh.position.set(0, TOWER_TIER1_H + TOWER_TIER2_H / 2, TOWER_FF2 / 2 + 0.8);
        sg.add(bar.mesh);

        return { frameMat, panel, bar, objects };
    }

    // --- State ---------------------------------------------------------
    update(state: ConsoleState): void {
        this.state = state;
        const winds = SEAT_WINDS[state.players];
        const infoText = `${state.roundWind}${state.kyokuNum}局·${state.honba}本场·供托${state.riichiSticks}·残${state.remaining}`;

        for (let i = 0; i < this.boards.length; i++) {
            const seatWind = winds[(i - state.dealer + state.players) % state.players];
            const score = state.scores[i] ?? 0;
            const bright = seatWind === state.roundWind ? 1 : 0.35;
            const riichi = state.riichi[i] ?? false;
            const board = this.boards[i];

            board.panel.setContent((ctx, w, h) => {
                ledText(ctx, seatWind, w * 0.5, h * 0.27, ledFont(900, h * 0.44), bright);
                if (riichi) ledDot(ctx, w * 0.8, h * 0.27, h * 0.07, '#ff3322');
                ledText(ctx, String(score), w * 0.5, h * 0.74, ledFont(700, h * 0.3), 1);
            });
            board.bar.setContent((ctx, w, h) => {
                ledText(ctx, infoText, w * 0.5, h * 0.52, ledFont(700, h * 0.38), 0.9);
            });
        }
    }

    /** Breathing gold pulse on the dealer's scoreboard frame. */
    tick(dt: number): void {
        this.pulseT += dt;
        if (!this.state) return;
        for (let i = 0; i < this.boards.length; i++) {
            const mat = this.boards[i].frameMat;
            if (i === this.state.dealer) {
                mat.emissiveIntensity = 0.4 + 0.35 * (0.5 + 0.5 * Math.sin(this.pulseT * 2.6));
            } else {
                mat.emissiveIntensity = 0.12;
            }
        }
    }

    rollDice(): Promise<[number, number]> {
        return this.dice.roll();
    }
}
