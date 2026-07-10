precision mediump float;

uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_levels;

varying vec2 v_texCoord;

void main() {
  vec4 color = texture2D(u_texture, v_texCoord);
  float levels = max(u_levels, 2.0);
  vec3 rgb = floor(color.rgb * (levels - 1.0) + 0.5) / (levels - 1.0);
  gl_FragColor = vec4(rgb, color.a);
}
