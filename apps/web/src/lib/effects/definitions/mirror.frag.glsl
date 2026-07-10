precision mediump float;

uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_direction;

varying vec2 v_texCoord;

void main() {
  vec2 uv = v_texCoord;

  if (u_direction < 0.5) {
    // Mirror the left half onto the right.
    uv.x = uv.x > 0.5 ? 1.0 - uv.x : uv.x;
  } else if (u_direction < 1.5) {
    // Mirror the right half onto the left.
    uv.x = uv.x < 0.5 ? 1.0 - uv.x : uv.x;
  } else if (u_direction < 2.5) {
    // Mirror the top half onto the bottom.
    uv.y = uv.y > 0.5 ? 1.0 - uv.y : uv.y;
  } else {
    // Mirror the bottom half onto the top.
    uv.y = uv.y < 0.5 ? 1.0 - uv.y : uv.y;
  }

  gl_FragColor = texture2D(u_texture, uv);
}
