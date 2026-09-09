import * as THREE from "three";
import { exportGLB } from "./export.js";
import { TextGeometry } from "three/addons/geometries/TextGeometry.js";
THREE.ObjectLoader.registerGeometry("TextGeometry", TextGeometry);
try {
  const id = location.pathname.split("/").filter(Boolean).at(-1);
  const response = await fetch(`/labs/fiend/api/scenes/${id}`);
  const snapshot = await response.json();
  if (!response.ok) throw new Error(snapshot.error);
  const loader = new THREE.ObjectLoader();
  const scene = await loader.parseAsync(snapshot.document.scene);
  let exportBytes;
  window.fiendExportPrepare = async (selector) => {
    exportBytes = new Uint8Array(await exportGLB(scene, selector));
    return { revision:snapshot.revision, bytes:exportBytes.length };
  };
  window.fiendExportChunk = (offset, length) => {
    const bytes = exportBytes.subarray(offset, offset + length);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(binary);
  };
  window.fiendExport = async (selector) => {
    const result = await window.fiendExportPrepare(selector);
    return { ...result, data:window.fiendExportChunk(0, result.bytes) };
  };
  const camera = await loader.parseAsync(snapshot.document.camera);
  const renderer = new THREE.WebGLRenderer({ antialias:true, preserveDrawingBuffer:true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  if (camera.isPerspectiveCamera) camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  document.body.append(renderer.domElement);
  renderer.render(scene, camera);
  window.fiendCapture = () => {
    renderer.render(scene, camera);
    const objects = [];
    scene.traverseVisible((node) => {
      if (!node.isMesh) return;
      const box = new THREE.Box3().setFromObject(node);
      const center = box.getCenter(new THREE.Vector3()).project(camera);
      objects.push({ uuid:node.uuid, name:node.name, x:Math.round((center.x + 1) / 2 * innerWidth), y:Math.round((1 - center.y) / 2 * innerHeight), inFrame:Math.abs(center.x) <= 1 && Math.abs(center.y) <= 1 && Math.abs(center.z) <= 1, bounds:{min:box.min.toArray(),max:box.max.toArray()} });
    });
    return { image:renderer.domElement.toDataURL("image/png"), objects, revision:snapshot.revision };
  };
} catch (error) { window.fiendError = error.message; console.error(error); }
