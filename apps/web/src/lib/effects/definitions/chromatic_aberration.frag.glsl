precision mediump float;

uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_amount;
uniform float u_radial;

varying vec2 v_texCoord;

void main() {
  vec2 center = vec2(0.5, 0.5);
  // Radial mode fringes stronger toward the edges (lens-like); linear mode shifts uniformly.
  vec2 dir = u_radial > 0.5 ? (v_texCoord - center) * 2.0 : vec2(1.0, 0.0);
  vec2 shift = dir * u_amount * 0.02;

  float r = texture2D(u_texture, v_texCoord + shift).r;
  vec4 g = texture2D(u_texture, v_texCoord);
  float b = texture2D(u_texture, v_texCoord - shift).b;

  gl_FragColor = vec4(r, g.g, b, g.a);
}
