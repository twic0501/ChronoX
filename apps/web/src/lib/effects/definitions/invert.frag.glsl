precision mediump float;

uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_intensity;

varying vec2 v_texCoord;

void main() {
  vec4 color = texture2D(u_texture, v_texCoord);
  vec3 inverted = 1.0 - color.rgb;
  float t = u_intensity / 100.0;
  gl_FragColor = vec4(mix(color.rgb, inverted, t), color.a);
}
