// Vertex shader — packed alpha video layer
// Passes through UV coordinates and view depth to the fragment shader.

varying vec2 vUv;
varying float vViewDepth; // distance in front of the camera (scene units; metres in WebXR)

void main() {
  vUv = uv;
  vec4 viewPos = modelViewMatrix * vec4(position, 1.0);
  vViewDepth = -viewPos.z;
  gl_Position = projectionMatrix * viewPos;
}
