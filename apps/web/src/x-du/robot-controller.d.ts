import type { Object3D } from 'three';
export class RobotController {
  constructor(model: Object3D, options?: object);
  object: Object3D;
  update(dt: number): void;
  play(name: string, options?: object): Promise<unknown>;
  stop(): void;
  setSpeaking(speaking: boolean, level?: number): void;
  dispose(): void;
}
