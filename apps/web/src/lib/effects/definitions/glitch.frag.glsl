precision mediump float;

uniform sampler2D u_texture;
uniform float u_time;
uniform float u_intensity;    // glitch intensity (e.g. 0.5)

varying vec2 v_texCoord;

float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

void main() {
    vec2 uv = v_texCoord;
    
    // Generate horizontal strip glitch triggers
    float timeVal = floor(u_time * 8.0); // discrete steps
    float stripVal = sin(uv.y * 30.0 + timeVal) * cos(uv.y * 10.0 - timeVal);
    
    float glitchTrigger = step(0.85 - (u_intensity * 0.2), hash(vec2(timeVal, 1.0)));
    float stripGlitch = step(0.7, hash(vec2(floor(uv.y * 15.0), timeVal))) * glitchTrigger;
    
    // Horizontal tearing offset
    uv.x += stripGlitch * 0.08 * sin(u_time * 50.0) * u_intensity;
    
    // Chromatic aberration (color split)
    float splitAmount = 0.015 * u_intensity * glitchTrigger;
    
    float r = texture2D(u_texture, uv + vec2(splitAmount, 0.0)).r;
    float g = texture2D(u_texture, uv).g;
    float b = texture2D(u_texture, uv - vec2(splitAmount, 0.0)).b;
    float a = texture2D(u_texture, uv).a;
    
    gl_FragColor = vec4(r, g, b, a);
}
