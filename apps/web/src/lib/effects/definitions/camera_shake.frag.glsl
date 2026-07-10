precision mediump float;

uniform sampler2D u_texture;
uniform float u_time;
uniform float u_amplitude;   // shake amplitude (e.g. 0.01)
uniform float u_frequency;   // shake frequency (e.g. 15.0)

varying vec2 v_texCoord;

void main() {
    // Generate organic low-frequency shake offsets using sinusoidal sums
    float offsetX = sin(u_time * u_frequency) * 0.5 + cos(u_time * u_frequency * 1.7) * 0.3;
    float offsetY = cos(u_time * u_frequency * 0.9) * 0.5 + sin(u_time * u_frequency * 2.3) * 0.3;
    
    vec2 offset = vec2(offsetX, offsetY) * u_amplitude;
    
    // Sample texture with shake offset
    gl_FragColor = texture2D(u_texture, v_texCoord + offset);
}
