#version 300 es
precision highp float;
precision highp sampler3D;

in vec2 v_texCoord;
out vec4 outColor;

uniform sampler2D u_texture;
uniform sampler3D u_lutTexture;     // 3D LUT Color texture (33x33x33)
uniform float u_logProfile;         // 0.0: Rec709, 1.0: S-Log3, 2.0: D-Log
uniform float u_intensity;          // LUT Grading intensity [0.0 - 1.0]
uniform float u_lumaVsSatBottom;    // Shadows luma-vs-sat threshold

// Converts S-Log3 color values to linear light values
vec3 sLog3ToLinear(vec3 sLog) {
    vec3 linear;
    for(int i = 0; i < 3; i++) {
        if (sLog[i] >= 0.1812855) {
            linear[i] = pow(10.0, (sLog[i] - 0.598206) / 0.241514) - 0.00873;
        } else {
            linear[i] = (sLog[i] - 0.125) / 5.6;
        }
    }
    return linear;
}

// Converts S-Gamut3.Cine to Rec.709 colorspace
vec3 applyGamutMapping(vec3 srcColor) {
    mat3 m = mat3(
        1.806576, -0.170090, -0.025206,
        -0.695697, 1.305955, -0.154468,
        -0.110879, -0.135865, 1.179674
    );
    return m * srcColor;
}

void main() {
    vec4 texColor = texture(u_texture, v_texCoord);
    vec3 rgb = texColor.rgb;

    // 1. Recover LOG color space to Linear Rec.709
    if (u_logProfile > 0.5 && u_logProfile < 1.5) { // S-Log3 (1.0)
        rgb = applyGamutMapping(sLog3ToLinear(rgb));
    }
    
    // Clamp coordinates to safe texture boundaries [0.0, 1.0] before LUT lookup
    rgb = clamp(rgb, 0.0, 1.0);

    // 2. Sample from 3D LUT Creative Grading Texture
    vec3 gradedColor = texture(u_lutTexture, rgb).rgb;
    rgb = mix(rgb, gradedColor, u_intensity);

    // 3. Apply Luma vs Saturation Curve (Shadow grading & cleanup)
    float luma = dot(rgb, vec3(0.299, 0.587, 0.114));
    if (luma < u_lumaVsSatBottom) {
        float satFactor = smoothstep(0.0, u_lumaVsSatBottom, luma);
        rgb = mix(vec3(luma), rgb, satFactor);
    }

    outColor = vec4(rgb, texColor.a);
}
