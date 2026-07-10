precision mediump float;

uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_amount;

varying vec2 v_texCoord;

void main() {
  vec2 center = vec2(0.5, 0.5);
  vec2 dir = v_texCoord - center;

  // Accumulate samples along the ray toward the centre (zoom blur).
  vec4 accum = vec4(0.0);
  for (int i = 0; i < 12; i++) {
    float t = float(i) / 11.0;
    float scale = 1.0 - u_amount * 0.4 * t;
    accum += texture2D(u_texture, center + dir * scale);
  }

  gl_FragColor = accum / 12.0;
}
