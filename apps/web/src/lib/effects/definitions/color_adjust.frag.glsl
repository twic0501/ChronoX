precision mediump float;

uniform sampler2D u_texture;
uniform vec2 u_resolution;

uniform float u_brightness;
uniform float u_contrast;
uniform float u_saturation;
uniform float u_exposure;
uniform float u_temperature;
uniform float u_tint;
uniform float u_highlights;
uniform float u_shadows;

uniform vec3 u_lift;
uniform vec3 u_gamma;
uniform vec3 u_gain;

varying vec2 v_texCoord;

void main() {
  vec4 color = texture2D(u_texture, v_texCoord);
  vec3 rgb = color.rgb;

  // 1. Exposure: scale RGB intensity
  rgb = rgb * pow(2.0, u_exposure);

  // 2. Temperature & Tint
  // Temperature: Warm (Red/Yellow) vs Cool (Blue)
  rgb.r += u_temperature * 0.05;
  rgb.b -= u_temperature * 0.05;
  // Tint: Green vs Magenta
  rgb.g += u_tint * 0.05;
  rgb.r -= u_tint * 0.025;
  rgb.b -= u_tint * 0.025;

  // 3. Brightness & Contrast
  rgb = rgb + vec3(u_brightness);
  rgb = (rgb - 0.5) * (1.0 + u_contrast) + 0.5;

  // 4. Shadows & Highlights (using soft curves)
  float lum = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  
  float shadowMask = clamp(1.0 - lum, 0.0, 1.0);
  shadowMask = shadowMask * shadowMask;
  rgb += rgb * u_shadows * shadowMask * 0.4;

  float highlightMask = clamp(lum, 0.0, 1.0);
  highlightMask = highlightMask * highlightMask;
  rgb += rgb * u_highlights * highlightMask * 0.4;

  // 5. Lift, Gamma, Gain (3-Way Color Wheels)
  // Lift: offsets shadows
  rgb = rgb + u_lift * (1.0 - rgb);
  
  // Gain: scales highlights
  rgb = rgb * u_gain;
  
  // Gamma: adjusts midtones
  rgb = pow(clamp(rgb, 0.0, 1.0), vec3(1.0 / max(u_gamma, vec3(0.01))));

  // 6. Saturation
  lum = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  rgb = mix(vec3(lum), rgb, 1.0 + u_saturation);

  // Clamp and output
  rgb = clamp(rgb, 0.0, 1.0);
  gl_FragColor = vec4(rgb, color.a);
}
