/**
 * Deck construction and demo deal logic.
 *
 * Tile codes follow the project convention: '1m'..'9m', '1p'..'9p',
 * '1s'..'9s', honors 'E','S','W','N','P','F','C', red fives '0m','0p','0s'
 * (copy 0 of each five). 4-player: 136 tiles; 3-player: 108 (2m-8m
 * removed, so no red 5m).
 */

export interface DealResult {
    hands: string[][]; // 13 tiles each, sorted
    discards: string[][]; // 6-9 per player
    walls: string[][]; // per seat, flat codes in stack order [bottom, top, ...]
    deadWall: string[]; // 14 codes (7 stacks), displayed at seat 0's wall tail
    doraIndicator: string; // code flipped face-up on the dead wall
    ponMelds: string[][]; // one 3-tile pon per player
    ankan: string[]; // dealer's 4-tile concealed kan
    liveCount: number; // tiles remaining in the live wall
}

const RED_FIVE_34: Record<number, string> = { 4: '0m', 13: '0p', 22: '0s' };

function t34ToCode(t34: number): string {
    if (t34 <= 8) return `${t34 + 1}m`;
    if (t34 <= 17) return `${t34 - 8}p`;
    if (t34 <= 26) return `${t34 - 17}s`;
    return ['E', 'S', 'W', 'N', 'P', 'F', 'C'][t34 - 27];
}

export function buildDeck(players: 3 | 4): string[] {
    const codes: string[] = [];
    for (let t34 = 0; t34 < 34; t34++) {
        if (players === 3 && t34 >= 1 && t34 <= 7) continue; // no 2m-8m
        for (let copy = 0; copy < 4; copy++) {
            codes.push(copy === 0 && RED_FIVE_34[t34] ? RED_FIVE_34[t34] : t34ToCode(t34));
        }
    }
    return codes;
}

function shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function codeToT34(code: string): number {
    if (code.length === 1) return 27 + ['E', 'S', 'W', 'N', 'P', 'F', 'C'].indexOf(code);
    const n = code === '0m' || code === '0p' || code === '0s' ? 5 : Number(code[0]);
    const suit = code[1];
    if (suit === 'm') return n - 1;
    if (suit === 'p') return 9 + n - 1;
    return 18 + n - 1;
}

function sortKey(code: string): number {
    const red = code[0] === '0' ? 0 : 1;
    return codeToT34(code) * 10 + red;
}

export function sortHand(hand: string[]): string[] {
    return hand.sort((a, b) => sortKey(a) - sortKey(b));
}

/** Remove `count` copies of one tile kind (copies pulled from `pool`). */
function takeKind(pool: string[], count: number, usedT34: Set<number>): string[] {
    for (let t34 = 0; t34 < 34; t34++) {
        if (usedT34.has(t34)) continue;
        const normal = t34ToCode(t34);
        const red = RED_FIVE_34[t34];
        const copies = pool.filter((c) => c === normal || (red !== undefined && c === red));
        if (copies.length >= count) {
            usedT34.add(t34);
            const taken: string[] = [];
            for (const c of copies.slice(0, count)) {
                pool.splice(pool.indexOf(c), 1);
                taken.push(c);
            }
            return taken;
        }
    }
    throw new Error('deck: no tile kind available for meld');
}

export function deal(players: 3 | 4): DealResult {
    const pool = buildDeck(players);

    // Reserve example calls first so they never collide with hands.
    const used = new Set<number>();
    const ponMelds: string[][] = [];
    for (let i = 0; i < players; i++) ponMelds.push(takeKind(pool, 3, used));
    const ankan = takeKind(pool, 4, used);

    shuffle(pool);

    const hands: string[][] = [];
    for (let i = 0; i < players; i++) hands.push(sortHand(pool.splice(0, 13)));

    const discards: string[][] = [];
    for (let i = 0; i < players; i++) {
        const n = 6 + ((i * 5 + 2) % 4); // 6-9, deterministic spread
        discards.push(pool.splice(0, n));
    }

    const deadWall = pool.splice(0, 14);
    const doraIndicator = deadWall[9]; // top tile of the 3rd stack from the end

    // Keep the live wall even so it pairs cleanly into 2-tile stacks.
    if (pool.length % 2 === 1 && discards.length > 1) {
        const moved = pool.splice(0, 1);
        discards[1].push(moved[0]);
    }

    const liveCount = pool.length;
    const stacks = liveCount / 2;
    const base = Math.floor(stacks / players);
    const extra = stacks % players;
    const walls: string[][] = [];
    for (let i = 0; i < players; i++) {
        const nStacks = base + (i < extra ? 1 : 0);
        walls.push(pool.splice(0, nStacks * 2));
    }

    return { hands, discards, walls, deadWall, doraIndicator, ponMelds, ankan, liveCount };
}
