precision mediump float;

uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_radius;       // Blur radius (e.g. 0.01)
uniform float u_intensity;    // Glow intensity (e.g. 0.8)
uniform float u_threshold;    // Highlight threshold (e.g. 0.7)

varying vec2 v_texCoord;

void main() {
    vec4 baseColor = texture2D(u_texture, v_texCoord);
    
    // Simple 9-tap blur to extract and spread highlights
    vec4 sum = vec4(0.0);
    float totalWeight = 0.0;
    
    for (float x = -2.0; x <= 2.0; x += 1.0) {
        for (float y = -2.0; y <= 2.0; y += 1.0) {
            vec2 offset = vec2(x, y) * u_radius / u_resolution;
            vec4 sampleCol = texture2D(u_texture, v_texCoord + offset);
            
            // Extract brightness
            float brightness = max(sampleCol.r, max(sampleCol.g, sampleCol.b));
            float weight = smoothstep(u_threshold, 1.0, brightness);
            
            sum += sampleCol * weight;
            totalWeight += weight;
        }
    }
    
    vec4 glow = (totalWeight > 0.0) ? (sum / totalWeight) : vec4(0.0);
    
    // Tint glow to classic warm red/orange halation tone
    vec3 halationColor = glow.rgb * vec3(1.0, 0.25, 0.05) * u_intensity;
    
    vec3 finalRgb = baseColor.rgb + halationColor;
    gl_FragColor = vec4(finalRgb, baseColor.a);
}
