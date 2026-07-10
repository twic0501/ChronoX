precision mediump float;

uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_intensity;
uniform float u_radius;

varying vec2 v_texCoord;

void main() {
  vec4 color = texture2D(u_texture, v_texCoord);

  // Calculate distance from center (normalized to aspect ratio)
  vec2 center = vec2(0.5, 0.5);
  vec2 uv = v_texCoord - center;

  // Correct for aspect ratio
  float aspect = u_resolution.x / u_resolution.y;
  uv.x *= aspect;

  float dist = length(uv);

  // Vignette darkening based on distance from center
  float vignette = smoothstep(u_radius, u_radius - 0.45, dist);
  float strength = u_intensity / 100.0;

  vec3 rgb = color.rgb * mix(1.0, vignette, strength);

  gl_FragColor = vec4(rgb, color.a);
}
