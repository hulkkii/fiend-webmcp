import * as THREE from "three";
import { TextGeometry } from "three/addons/geometries/TextGeometry.js";

THREE.ObjectLoader.registerGeometry("TextGeometry", TextGeometry);

// These objects belong to this capture, never to the live editor.
function disposeScene(scene) {
  const resources = new Set();
  scene?.traverse((object) => {
    if (object.geometry) resources.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!material) continue;
      resources.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) resources.add(value);
    }
  });
  for (const value of [scene?.background, scene?.environment]) if (value?.isTexture) resources.add(value);
  for (const resource of resources) resource.dispose();
}

export async function renderSnapshot(snapshot, { width = 1024, height = 768 } = {}) {
  if (!Number.isInteger(width) || width < 256 || width > 1600 || !Number.isInteger(height) || height < 256 || height > 1200) {
    throw new Error("Capture dimensions must be 256–1600 by 256–1200 pixels.");
  }
  let scene, renderer;
  try {
    const loader = new THREE.ObjectLoader();
    scene = await loader.parseAsync(snapshot.document.scene);
    const camera = await loader.parseAsync(snapshot.document.camera);
    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(width, height);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    if (camera.isPerspectiveCamera) camera.aspect = width / height;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    scene.updateMatrixWorld(true);
    renderer.render(scene, camera);
    const objects = [];
    scene.traverseVisible((node) => {
      if (!node.isMesh) return;
      const box = new THREE.Box3().setFromObject(node);
      if (box.isEmpty()) return;
      const center = box.getCenter(new THREE.Vector3()).project(camera);
      objects.push({
        uuid: node.uuid, name: node.name,
        x: Math.round((center.x + 1) / 2 * width), y: Math.round((1 - center.y) / 2 * height),
        inFrame: Math.abs(center.x) <= 1 && Math.abs(center.y) <= 1 && Math.abs(center.z) <= 1,
        bounds: { min: box.min.toArray(), max: box.max.toArray() },
      });
    });
    return { image: renderer.domElement.toDataURL("image/png"), width, height, objects, revision: snapshot.revision };
  } finally {
    disposeScene(scene);
    renderer?.dispose();
    renderer?.forceContextLoss();
  }
}
