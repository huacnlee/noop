// Fold the rounded rectangle into one quadrant. Measure from the top midpoint,
// along the straight edge, around the quarter circle and down to the side midpoint.
export const composerBeam = /* wgsl */ `
struct Uniforms { radius: f32, tint: vec4f, duration: f32 }

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

  let t = clamp(nsh.time / uniforms.duration, 0.0, 1.0);
  let offset = fract(arc / (4.0 * quarter) - t + 0.5) - 0.5;
  let width = select(0.16, 0.05, offset > 0.0);
  let beam = exp(-pow(abs(offset) / width, 2.0));
  let rim = exp(-pow((depth - 1.2) / 1.8, 2.0));
  let halo = exp(-max(depth, 0.0) / 12.0);
  let fade = smoothstep(0.0, 0.08, t) * (1.0 - smoothstep(0.88, 1.0, t));
  let core = exp(-pow(abs(offset) / 0.02, 2.0));
  let tint = mix(uniforms.tint.rgb, vec3f(0.85, 0.95, 1.0), rim * (0.4 * beam + 0.6 * core));
  return vec4f(tint, beam * fade * min(1.0, 1.0 * rim + 0.42 * halo) * smoothstep(-0.5, 0.5, depth));
}`;
