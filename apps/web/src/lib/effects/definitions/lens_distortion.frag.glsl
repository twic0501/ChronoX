precision mediump float;

uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_distortion;
uniform float u_zoom;

varying vec2 v_texCoord;

void main() {
  float aspect = u_resolution.x / u_resolution.y;

  vec2 uv = v_texCoord - 0.5;
  uv.x *= aspect;

  // Positive distortion bulges (fisheye), negative pinches (pincushion).
  float r2 = dot(uv, uv);
  uv *= (1.0 + u_distortion * r2) / max(u_zoom, 0.1);

  uv.x /= aspect;
  uv += 0.5;

  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    gl_FragColor = vec4(0.0);
  } else {
    gl_FragColor = texture2D(u_texture, uv);
  }
}
