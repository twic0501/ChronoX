precision mediump float;

uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform vec3 u_shadowColor;
uniform vec3 u_highlightColor;
uniform float u_mix;

varying vec2 v_texCoord;

void main() {
  vec4 color = texture2D(u_texture, v_texCoord);
  float lum = dot(color.rgb, vec3(0.299, 0.587, 0.114));
  vec3 duotone = mix(u_shadowColor, u_highlightColor, lum);
  vec3 rgb = mix(color.rgb, duotone, u_mix);
  gl_FragColor = vec4(rgb, color.a);
}
