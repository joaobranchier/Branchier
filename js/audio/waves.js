/**
 * waves.js — the master chain's output ceiling.
 *
 * This file used to hold the harmonic tables and noise buffers the
 * oscillator-graph synthesis was built from. That synthesis was replaced by
 * per-sample rendering in render.js, which can express things a graph of
 * oscillators cannot, so only the ceiling is left.
 */

/**
 * Final safety ceiling. A DynamicsCompressor is a limiter, not a brickwall:
 * a fast transient (three air-horn bells hitting together) slips past its
 * attack and lands above full scale, which a DAC reproduces as a click.
 * This stays perfectly linear under 0.70 and soft-knees to a hard asymptote
 * just under 1.0, so the output can never exceed full scale no matter how
 * many voices MIX mode stacks up.
 */
export function makeCeilingCurve(n = 4096, knee = 0.70, ceil = 0.985) {
  const curve = new Float32Array(n);
  const span = ceil - knee;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    curve[i] = a <= knee
      ? x
      : Math.sign(x) * (knee + span * Math.tanh((a - knee) / span));
  }
  return curve;
}
