// Types for fogged-glass.js. The module registers the <fogged-glass> custom element on import.

export type WritingReason = "" | "small" | "big" | "simple";

/** What looksLikeWriting() and the "fogwrite" event report. */
export interface WritingResult {
  ok: boolean;
  /** Why it was refused: "small" too small, "big" a scrub over the glass, "simple" a swipe, a circle, a cross. */
  reason: WritingReason;
  /** Bounding box of the strokes, css px. */
  w: number;
  h: number;
  /** Total length of ink, css px. */
  ink: number;
  /** Total turning, in half turns (pi radians). */
  turn: number;
  strokes: number;
}

/** "fogprogress" detail, a few times a second. */
export interface FogProgress {
  /** 0..1 of the glass wiped. */
  cleared: number;
  /** 0..1 of data-target wiped (0 without a target). */
  target: number;
}

export interface FoggedGlassEventMap extends HTMLElementEventMap {
  fogtouch: CustomEvent<void>;
  fogprogress: CustomEvent<FogProgress>;
  fogwrite: CustomEvent<WritingResult>;
  fogreveal: CustomEvent<FogProgress | WritingResult>;
  fogunsupported: CustomEvent<void>;
}

export interface FoggedGlassElement extends HTMLElement {
  /** Evaporate the fog in patches over `seconds`, and keep the glass clear. */
  clearAll(seconds?: number): void;
  /** Fog the glass back up over about `seconds`. */
  fogUp(seconds?: number): void;
  /** Drops follow this direction (y down), e.g. from the device tilt. */
  setGravity(x: number, y: number): void;
  /** Stop and free the GL context. Called on its own when the element leaves the page. */
  destroy(): void;
  addEventListener<K extends keyof FoggedGlassEventMap>(
    type: K,
    listener: (this: FoggedGlassElement, ev: FoggedGlassEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
  removeEventListener<K extends keyof FoggedGlassEventMap>(
    type: K,
    listener: (this: FoggedGlassElement, ev: FoggedGlassEventMap[K]) => unknown,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void;
}

/** Strokes are flat [x0, y0, x1, y1, ...] arrays in css px. Pure: no DOM, no GL. */
export function looksLikeWriting(strokes: ArrayLike<number>[], width: number, height: number): WritingResult;

export interface Drop {
  x: number;
  y: number;
  r: number;
  run: boolean;
}

/** The drop simulation behind the element. Pure: no DOM, no GL. Units are css px, y down. */
export class DropSim {
  constructor(width: number, height: number, seed?: number);
  drops: Drop[];
  /** Segments the running drops travelled during the last step: what to clear in the fog. */
  trails: { x0: number; y0: number; x1: number; y1: number; r: number }[];
  /** Drop multiplier, 0 for none. */
  amount: number;
  /** Drops per minute that form on their own. */
  ambient: number;
  gravity: [number, number];
  resize(width: number, height: number): void;
  fillGrid(value: number): void;
  wipe(x0: number, y0: number, x1: number, y1: number, radius: number): void;
  endStroke(): void;
  step(dt: number, refogRate: number): void;
  progress(rect: [number, number, number, number] | null): FogProgress;
}

declare const FoggedGlass: {
  prototype: FoggedGlassElement;
  new (): FoggedGlassElement;
};
export default FoggedGlass;

declare global {
  interface HTMLElementTagNameMap {
    "fogged-glass": FoggedGlassElement;
  }
}
