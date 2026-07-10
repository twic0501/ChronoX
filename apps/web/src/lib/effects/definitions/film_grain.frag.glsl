precision mediump float;

uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_intensity;
uniform float u_size;
uniform float u_time;

varying vec2 v_texCoord;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

void main() {
  vec4 color = texture2D(u_texture, v_texCoord);

  vec2 cell = floor(v_texCoord * u_resolution / max(u_size, 1.0));
  // Re-seed every frame so the grain dances like film stock.
  float seed = floor(u_time * 24.0);
  float noise = hash(cell + vec2(seed * 37.0, seed * 17.0));
  float grain = (noise - 0.5) * u_intensity;

  // Grain reads strongest in the midtones, fades in deep shadows and highlights.
  float lum = dot(color.rgb, vec3(0.299, 0.587, 0.114));
  float midtone = 4.0 * lum * (1.0 - lum);
  vec3 rgb = clamp(color.rgb + grain * mix(0.4, 1.0, midtone), 0.0, 1.0);

  gl_FragColor = vec4(rgb, color.a);
}
