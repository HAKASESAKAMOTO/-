// A pure mapping layer: model scale stays in the existing hardware service.
export class RotationLink {
  constructor(direction = 1) { this.direction = direction; this.anchor = null; this.previousMs = null; }
  setDirection(direction) {
    if (direction !== 1 && direction !== -1) throw new Error('Invalid visual direction');
    this.direction = direction; this.rebase();
  }
  rebase() { this.anchor = null; this.previousMs = null; }
  update(state, visualAngle) {
    const angle = state?.angle;
    if (!state?.connected || !angle?.available || !Number.isFinite(state.age_ms) || state.age_ms > 1000 ||
        !Number.isFinite(angle.steps) || !Number.isFinite(angle.steps_per_turn) || angle.steps_per_turn <= 0) {
      this.rebase(); return null;
    }
    const boot = state.latest?.boot_id ?? null;
    const ms = state.latest?.ms ?? 0;
    if (!this.anchor || this.anchor.boot !== boot || this.anchor.sign !== angle.sign || this.anchor.perTurn !== angle.steps_per_turn ||
        (this.previousMs !== null && ms < this.previousMs)) {
      this.anchor = {steps: angle.steps, visual: visualAngle, boot, sign: angle.sign, perTurn: angle.steps_per_turn};
    }
    this.previousMs = ms;
    return this.anchor.visual + this.direction * (angle.steps - this.anchor.steps) * 360 / angle.steps_per_turn;
  }
}

