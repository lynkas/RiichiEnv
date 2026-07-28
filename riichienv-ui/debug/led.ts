import * as THREE from 'three';

/**
 * Shared LED panel utility: near-black canvas + glowing amber text,
 * used by the arena console scoreboards and info bars.
 * LedSettings is global — changing color/glow then calling
 * refreshLedPanels() repaints every registered panel.
 */

export type LedDraw = (ctx: CanvasRenderingContext2D, w: number, h: number) => void;

export const LedSettings = {
    color: '#ffb300',
    glow: 14,
};

export interface LedPanel {
    mesh: THREE.Mesh;
    setContent(draw: LedDraw): void;
    redraw(): void;
    dispose(): void;
}

const registry = new Set<LedPanel>();

export function refreshLedPanels(): void {
    for (const p of registry) p.redraw();
}

const LED_FONT_STACK = '"Hiragino Sans", "PingFang SC", "Microsoft YaHei", ui-monospace, monospace';

export function ledFont(weight: number, px: number): string {
    return `${weight} ${px}px ${LED_FONT_STACK}`;
}

/** Glowing LED text. Drawn twice: wide glow pass + tight core pass. */
export function ledText(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    font: string,
    alpha = 1,
    align: CanvasTextAlign = 'center',
): void {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = font;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = LedSettings.color;
    ctx.shadowColor = LedSettings.color;
    ctx.shadowBlur = LedSettings.glow;
    ctx.fillText(text, x, y);
    ctx.shadowBlur = LedSettings.glow * 0.35;
    ctx.fillText(text, x, y);
    ctx.restore();
}

/** Small round LED dot (riichi marker, status lights). */
export function ledDot(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    r: number,
    color: string,
): void {
    ctx.save();
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = LedSettings.glow;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

/**
 * A plane mesh backed by an LED canvas. `pxPerMm` controls canvas
 * resolution relative to the physical panel size in mm.
 */
export function makeLedPanel(widthMm: number, heightMm: number, pxPerMm = 4): LedPanel {
    const w = Math.max(2, Math.round(widthMm * pxPerMm));
    const h = Math.max(2, Math.round(heightMm * pxPerMm));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('led: 2d context unavailable');

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;

    const material = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(widthMm, heightMm), material);

    let drawFn: LedDraw = () => {};

    const panel: LedPanel = {
        mesh,
        setContent(draw: LedDraw): void {
            drawFn = draw;
            panel.redraw();
        },
        redraw(): void {
            ctx.save();
            ctx.shadowBlur = 0;
            ctx.fillStyle = '#0a0805';
            ctx.fillRect(0, 0, w, h);
            ctx.restore();
            drawFn(ctx, w, h);
            texture.needsUpdate = true;
        },
        dispose(): void {
            registry.delete(panel);
            mesh.geometry.dispose();
            material.map?.dispose();
            material.dispose();
        },
    };
    registry.add(panel);
    panel.redraw();
    return panel;
}
