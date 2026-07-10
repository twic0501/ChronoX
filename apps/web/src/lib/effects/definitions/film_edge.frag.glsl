precision mediump float;

uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_depth;      // edge erosion depth (0..0.25 of frame)
uniform float u_roughness;  // noise frequency along the edge
uniform float u_softness;   // feather width of the torn boundary
uniform float u_seed;       // variation seed
uniform float u_grain;      // grain intensity sprinkled near the edge

varying vec2 v_texCoord;

// ── Value-noise (Perlin-style) with fbm ──────────────────────
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21) + u_seed);
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f); // smoothstep interpolation
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 3; i++) {
    v += amp * vnoise(p);
    p *= 2.17;
    amp *= 0.5;
  }
  return v;
}

void main() {
  vec4 color = texture2D(u_texture, v_texCoord);

  float aspect = u_resolution.x / u_resolution.y;
  vec2 uv = v_texCoord;

  // Distance to the nearest frame edge (aspect-corrected so the torn band
  // has equal physical thickness on every side)
  float dx = min(uv.x, 1.0 - uv.x) * aspect;
  float dy = min(uv.y, 1.0 - uv.y);
  float edgeDist = min(dx, dy);

  // Noise sampled along the edge direction: use the position projected on
  // the frame border so the tear pattern follows the boundary
  vec2 noiseCoord = uv * u_roughness;
  float tear = fbm(noiseCoord);

  // Torn boundary: erode where edgeDist falls under noise-modulated depth
  float threshold = u_depth * (0.35 + 0.65 * tear);
  float edgeAlpha = smoothstep(threshold - u_softness, threshold + u_softness, edgeDist);

  // Film grain concentrated near the torn edge for a rough celluloid look
  float band = 1.0 - smoothstep(threshold, threshold + u_depth * 1.5, edgeDist);
  float grain = (hash(uv * u_resolution) - 0.5) * u_grain * band;

  vec3 rgb = color.rgb + grain;

  gl_FragColor = vec4(rgb * edgeAlpha, color.a * edgeAlpha);
}
