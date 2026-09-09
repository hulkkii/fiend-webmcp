import * as THREE from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { clone } from "three/addons/utils/SkeletonUtils.js";

export async function exportGLB(scene, selector = "Scene") {
  const matches = [];
  scene.traverse((node) => { if (node.uuid === selector || node.name === selector) matches.push(node); });
  const source = selector === "Scene" || selector === scene.uuid ? scene : matches.length === 1 ? matches[0] : null;
  if (!source) throw new Error(matches.length > 1 ? "Ambiguous object name; use UUID" : "Object not found");
  const object = clone(source);
  const unwanted = [];
  object.traverse((node) => { if (node.isLight || node.isCamera) unwanted.push(node); });
  for (const node of unwanted) node.removeFromParent();
  if (object.isLight || object.isCamera) throw new Error("Choose a mesh or group to export");
  const output = new THREE.Scene();
  if (object.isScene) { while (object.children.length) output.add(object.children[0]); }
  else {
    // An asset is exported in its parent's local coordinates; retain its own pivot.
    output.add(object);
  }
  output.updateMatrixWorld(true);
  return new GLTFExporter().parseAsync(output, { binary:true, onlyVisible:true, trs:true });
}
