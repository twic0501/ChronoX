precision mediump float;

uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_size;

varying vec2 v_texCoord;

void main() {
  float size = max(u_size, 1.0);
  vec2 block = size / u_resolution;
  vec2 uv = (floor(v_texCoord / block) + 0.5) * block;
  gl_FragColor = texture2D(u_texture, uv);
}
