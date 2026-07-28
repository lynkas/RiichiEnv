import GUI from 'lil-gui';
import { createArena } from './arena.js';
import { buildTableBody } from './table_body.js';
import { ArenaConsole, SEAT_ROTATIONS, type ConsoleState } from './console.js';
import { TableLayout } from './layout.js';
import { deal, type DealResult } from './deck.js';
import { TextureCache } from '../src/renderers/webgl/textures.js';
import { LedSettings, refreshLedPanels } from './led.js';

const arena = createArena(document.body);
buildTableBody(arena.scene);

const cache = new TextureCache();
const console3d = new ArenaConsole(arena.scene);
const layout = new TableLayout(arena.scene, cache);
arena.onTick((dt) => console3d.tick(dt));

const KYOKU_OPTIONS = ['東1', '東2', '東3', '東4', '南1', '南2', '南3', '南4'];
const LED_COLORS: Record<string, string> = { 金琥珀: '#ffb300', 红: '#ff4444', 青: '#33ddff' };

const params = {
    players: 4,
    kyoku: '東1',
    honba: 0,
    kyoutaku: 0,
    dealer: 0,
    score0: 35000,
    score1: 25000,
    score2: 25000,
    score3: 15000,
    camera: '初始',
    mainLight: 1.5,
    rimLight: 0.55,
    ledGlow: 14,
    ledColor: '金琥珀',
    rollDice: () => {
        void console3d.rollDice();
    },
    redeal: () => {
        void rebuild();
    },
};

let lastDeal: DealResult | null = null;

function playerCount(): 3 | 4 {
    return params.players === 3 ? 3 : 4;
}

function currentState(): ConsoleState {
    const n = playerCount();
    return {
        players: n,
        roundWind: params.kyoku[0],
        kyokuNum: Number(params.kyoku.slice(1)),
        honba: params.honba,
        riichiSticks: params.kyoutaku,
        remaining: lastDeal?.liveCount ?? 0,
        dealer: Math.min(Math.round(params.dealer), n - 1),
        scores: [params.score0, params.score1, params.score2, params.score3].slice(0, n),
        riichi: Array.from({ length: n }, (_, i) => i === 0), // demo: south declares riichi
    };
}

async function rebuild(): Promise<void> {
    const n = playerCount();
    lastDeal = deal(n);
    const state = currentState();
    console3d.setSeats(n);
    console3d.update(state);
    await layout.build(lastDeal, n, state.dealer, 0);
}

function refreshConsole(): void {
    console3d.update(currentState());
}

// --- Camera presets ------------------------------------------------------
function seatCamera(rot: number): { pos: [number, number, number]; tgt: [number, number, number] } {
    const dir: [number, number] = [Math.sin(rot), Math.cos(rot)];
    return { pos: [dir[0] * 950, 560, dir[1] * 950], tgt: [dir[0] * 120, 20, dir[1] * 120] };
}

const CAMERA_PRESETS: Record<string, { pos: [number, number, number]; tgt: [number, number, number] }> = {
    初始: { pos: [520, 620, 680], tgt: [0, 20, 0] },
    俯瞰: { pos: [0, 1450, 380], tgt: [0, 0, 0] },
    南席: seatCamera(SEAT_ROTATIONS[4][0]),
    西席: seatCamera(SEAT_ROTATIONS[4][1]),
    北席: seatCamera(SEAT_ROTATIONS[4][2]),
    東席: seatCamera(SEAT_ROTATIONS[4][3]),
    控制台特写: { pos: [300, 380, 300], tgt: [0, 45, 0] },
};

// --- GUI ------------------------------------------------------------------
const gui = new GUI({ title: '黑金竞技场' });

const gameFolder = gui.addFolder('对局');
gameFolder.add(params, 'players', { '4人': 4, '3人': 3 }).name('人数').onChange(() => {
    void rebuild();
});
gameFolder.add(params, 'kyoku', KYOKU_OPTIONS).name('局数').onChange(refreshConsole);
gameFolder.add(params, 'honba', 0, 8, 1).name('本场').onChange(refreshConsole);
gameFolder.add(params, 'kyoutaku', 0, 4, 1).name('供托').onChange(refreshConsole);
gameFolder.add(params, 'dealer', 0, 3, 1).name('庄家').onChange(refreshConsole);
gameFolder.open();

const scoreFolder = gui.addFolder('分数');
scoreFolder.add(params, 'score0', 0, 100000, 100).name('南家').onChange(refreshConsole);
scoreFolder.add(params, 'score1', 0, 100000, 100).name('西家').onChange(refreshConsole);
scoreFolder.add(params, 'score2', 0, 100000, 100).name('北家').onChange(refreshConsole);
scoreFolder.add(params, 'score3', 0, 100000, 100).name('东家').onChange(refreshConsole);

const actionFolder = gui.addFolder('动作');
actionFolder.add(params, 'rollDice').name('掷骰子');
actionFolder.add(params, 'redeal').name('重新配牌');

gui.add(params, 'camera', Object.keys(CAMERA_PRESETS)).name('相机').onChange((name: string) => {
    const p = CAMERA_PRESETS[name];
    if (p) arena.flyTo(p.pos, p.tgt);
});

const lightFolder = gui.addFolder('灯光');
lightFolder.add(params, 'mainLight', 0, 3, 0.05).name('主光强度').onChange((v: number) => {
    arena.spot.intensity = v;
});
lightFolder.add(params, 'rimLight', 0, 2, 0.05).name('轮廓光强度').onChange((v: number) => {
    for (const l of arena.rimLights) l.intensity = v;
});
lightFolder.add(params, 'ledGlow', 0, 40, 1).name('LED 辉光').onChange((v: number) => {
    LedSettings.glow = v;
    refreshLedPanels();
});
lightFolder.add(params, 'ledColor', Object.keys(LED_COLORS)).name('LED 颜色').onChange((name: string) => {
    LedSettings.color = LED_COLORS[name] ?? '#ffb300';
    refreshLedPanels();
});

rebuild().catch((err) => console.error('[arena] init failed:', err));
