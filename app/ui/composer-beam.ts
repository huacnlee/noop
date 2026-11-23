// One lap's timing is `duration`; the light keeps circling until `until` (seconds of the
// shader's clock, far away while whatever it stands for is still going), then fades out.
// Fold the rounded rectangle into one quadrant. Measure from the top midpoint,
// along the straight edge, around the quarter circle and down to the side midpoint.
export const composerBeam = /* wgsl */ `
struct Uniforms { radius: f32, tint: vec4f, duration: f32, until: f32 }

fn shade(uv: vec2f) -> vec4f {
  let halfSize = nsh.size * 0.5;
  let radius = min(uniforms.radius, min(halfSize.x, halfSize.y));
  let p = (uv - 0.5) * nsh.size;
  let straight = halfSize - radius;
  let q = abs(p) - straight;
  let depth = radius - length(max(q, vec2f(0.0))) - min(max(q.x, q.y), 0.0);
  let quarter = straight.x + 1.5707963 * radius + straight.y;
  var arc = abs(p.x);
  if (q.x > 0.0 && q.y > 0.0) {
    arc = straight.x + radius * atan2(q.x, q.y);
  } else if (q.x > q.y) {
    arc = quarter - abs(p.y);
  }
  if (p.y > 0.0) { arc = 2.0 * quarter - arc; }
  if (p.x < 0.0) { arc = 4.0 * quarter - arc; }

  let t = nsh.time / uniforms.duration;
  // A long comet: short bright head, long tail that shifts cyan -> blue -> indigo.
  let offset = fract(arc / (4.0 * quarter) - t * 1.25 + 0.5) - 0.5;
  let tail = clamp(-offset / 0.45, 0.0, 1.0);
  let beam = select(exp(-pow(offset / 0.025, 2.0)), pow(1.0 - tail, 1.6), offset <= 0.0);
  let cyan = vec3f(0.25, 0.85, 1.0);
  let violet = vec3f(0.55, 0.35, 1.0);
  var hue = mix(cyan, uniforms.tint.rgb, smoothstep(0.0, 0.45, tail));
  hue = mix(hue, violet, smoothstep(0.45, 1.0, tail));
  // Everything stays inside the border: a thin rim just inside the edge plus a soft inward glow.
  let inside = smoothstep(0.0, 1.0, depth);
  let rim = exp(-pow((depth - 1.4) / 2.0, 2.0));
  // The arc mapping jumps along the centre line and the quadrant diagonals, so the glow must
  // fade out well before it reaches them or those seams show as hard edges.
  let reach = min(halfSize.x, halfSize.y);
  let halo = exp(-max(depth, 0.0) / 12.0) * (1.0 - smoothstep(0.3 * reach, 0.8 * reach, depth));
  let head = exp(-pow(offset / 0.015, 2.0));
  let color = mix(hue, vec3f(0.92, 0.97, 1.0), rim * head * 0.5);
  let fade = smoothstep(0.0, 0.1, t) * (1.0 - smoothstep(uniforms.until - 0.18 * uniforms.duration, uniforms.until, nsh.time));
  // Keep it a faint accent: the owner wants a hint of light, not a bright ring.
  return vec4f(color, 0.45 * beam * fade * inside * min(1.0, 0.8 * rim + 0.3 * halo + 0.2 * head * halo));
}`;
