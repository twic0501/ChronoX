precision mediump float;

uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_intensity;

varying vec2 v_texCoord;

void main() {
  vec4 color = texture2D(u_texture, v_texCoord);
  float lum = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
  vec3 gray = vec3(lum);
  float t = u_intensity / 100.0;
  gl_FragColor = vec4(mix(color.rgb, gray, t), color.a);
}
