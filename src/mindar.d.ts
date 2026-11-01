declare module 'mind-ar/dist/mindar-image-three.prod.js' {
  export interface MindARThreeOptions {
    container: HTMLElement;
    imageTargetSrc: string;
    maxTrack?: number;
    uiLoading?: string;
    uiScanning?: string;
    uiError?: string;
    filterMinCF?: number;
    filterBeta?: number;
    warmupTolerance?: number;
    missTolerance?: number;
  }

  export interface Anchor {
    group: import('three').Group;
    targetIndex: number;
    onTargetFound: () => void;
    onTargetLost: () => void;
  }

  export class MindARThree {
    constructor(options: MindARThreeOptions);
    renderer: import('three').WebGLRenderer;
    scene: import('three').Scene;
    camera: import('three').Camera;
    /** Camera feed element (created by start()). */
    video?: HTMLVideoElement;
    addAnchor(targetIndex: number): Anchor;
    start(): Promise<void>;
    stop(): void;
    switchTarget(targetIndex: number): void;
  }
}
