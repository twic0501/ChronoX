precision mediump float;

uniform sampler2D u_texture;
uniform float u_aspectRatio;  // target aspect ratio, e.g. 2.39

varying vec2 v_texCoord;

void main() {
    vec4 color = texture2D(u_texture, v_texCoord);
    
    // Calculate cutoff based on target ratio vs standard 16:9 (1.7777)
    // 16:9 height is 1.0. Target height ratio is 1.7777 / targetAspectRatio
    float targetHeight = 1.77777 / u_aspectRatio;
    float margin = (1.0 - targetHeight) / 2.0;
    
    if (v_texCoord.y < margin || v_texCoord.y > (1.0 - margin)) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    } else {
        gl_FragColor = color;
    }
}
