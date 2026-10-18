// Exact critically damped response. Keeps velocity when the target changes.
export class RotationMotion {
  constructor(responseMs = 120) { this.omega = 4 / (responseMs / 1000); this.reset(0); }
  reset(value) { this.value = value; this.velocity = 0; }
  step(target, seconds) {
    const dt = Math.max(0, Math.min(seconds, .1));
    const offset = this.value - target;
    const c = this.velocity + this.omega * offset;
    const decay = Math.exp(-this.omega * dt);
    this.value = target + (offset + c * dt) * decay;
    this.velocity = (this.velocity - this.omega * c * dt) * decay;
    if (Math.abs(this.value-target)<.00005 && Math.abs(this.velocity)<.0005) this.reset(target);
    return this.value;
  }
}
