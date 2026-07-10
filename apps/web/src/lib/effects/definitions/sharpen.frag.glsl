precision mediump float;

uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_amount;

varying vec2 v_texCoord;

void main() {
  vec2 px = 1.0 / u_resolution;
  vec4 color = texture2D(u_texture, v_texCoord);

  // Unsharp mask against the 4-neighbour average.
  vec3 blurred = (
    texture2D(u_texture, v_texCoord + vec2(px.x, 0.0)).rgb +
    texture2D(u_texture, v_texCoord - vec2(px.x, 0.0)).rgb +
    texture2D(u_texture, v_texCoord + vec2(0.0, px.y)).rgb +
    texture2D(u_texture, v_texCoord - vec2(0.0, px.y)).rgb
  ) * 0.25;

  vec3 rgb = clamp(color.rgb + (color.rgb - blurred) * u_amount, 0.0, 1.0);
  gl_FragColor = vec4(rgb, color.a);
}
