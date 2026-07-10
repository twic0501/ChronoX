#version 300 es
precision highp float;

in vec2 v_texCoord;
out vec4 outColor;

// JFA seed textures: nearest seed PIXEL COORDINATES packed into RGBA8
// (xHi, xLo, yHi, yLo) / 255 — same encoding as jfa-init.frag.glsl.
// (1,1,1,1) means "no seed found".
uniform sampler2D u_jfa_inside;
uniform sampler2D u_jfa_outside;
uniform vec2 u_sdf_resolution;   // resolution the JFA ran at (e.g. 512x512)
uniform vec4 u_textColor;
uniform vec4 u_outlineColor;
uniform float u_outlineWidth;    // stroke width in SDF-texture pixels (0 = off)

vec2 decodeSeed(vec4 encoded) {
    float x = floor(encoded.r * 255.0 + 0.5) * 256.0 + floor(encoded.g * 255.0 + 0.5);
    float y = floor(encoded.b * 255.0 + 0.5) * 256.0 + floor(encoded.a * 255.0 + 0.5);
    return vec2(x, y);
}

bool isNoSeed(vec4 encoded) {
    return encoded.r > 0.99 && encoded.g > 0.99 && encoded.b > 0.99 && encoded.a > 0.99;
}

void main() {
    vec2 pixelCoord = v_texCoord * u_sdf_resolution;

    vec4 insideEncoded = texture(u_jfa_inside, v_texCoord);
    vec4 outsideEncoded = texture(u_jfa_outside, v_texCoord);

    float distToInside = isNoSeed(insideEncoded)
        ? 1e5
        : distance(pixelCoord, decodeSeed(insideEncoded));
    float distToOutside = isNoSeed(outsideEncoded)
        ? 1e5
        : distance(pixelCoord, decodeSeed(outsideEncoded));

    // > 0 inside the glyph, < 0 outside; units are SDF-texture pixels
    float signedDist = distToOutside - distToInside;

    // Screen-space derivative width: keeps the edge razor sharp at any zoom
    float delta = max(fwidth(signedDist), 1e-4);
    float fillAlpha = smoothstep(-delta, delta, signedDist);

    if (u_outlineWidth > 0.0) {
        float outlineAlpha = smoothstep(
            -u_outlineWidth - delta,
            -u_outlineWidth + delta,
            signedDist
        );
        vec4 baseColor = mix(u_outlineColor, u_textColor, fillAlpha);
        outColor = vec4(baseColor.rgb, baseColor.a * outlineAlpha);
    } else {
        outColor = vec4(u_textColor.rgb, u_textColor.a * fillAlpha);
    }
}
