import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const host = document.querySelector("#mascot");
try {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.setClearColor(0x080808, 0);
  host.append(renderer.domElement);

  const scene = new THREE.Scene();
  const environment = new RoomEnvironment();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const lighting = pmrem.fromScene(environment, .04);
  scene.environment = lighting.texture;
  scene.environmentIntensity = .65;
  environment.dispose(); pmrem.dispose();
  scene.add(new THREE.HemisphereLight(0xe7e7e7, 0x353535, 2));
  for (const [color, intensity, position] of [
    [0xf1f1f1, 4, [3, 4, 5]],
    [0xacacac, 4, [-3, 2, -2]],
    [0xd2d2d2, 1.2, [-3, 1, 3]],
  ]) {
    const light = new THREE.DirectionalLight(color, intensity);
    light.position.fromArray(position); scene.add(light);
  }

  // This GLB was modeled and exported through Fiend's public MCP server.
  const asset = await new GLTFLoader().loadAsync(new URL("./assets/fiend.glb", import.meta.url).href);
  const bounds = new THREE.Box3().setFromObject(asset.scene);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  asset.scene.position.sub(center);
  const mascot = new THREE.Group(); mascot.add(asset.scene); scene.add(mascot);
  mascot.rotation.y = -.18;
  const camera = new THREE.PerspectiveCamera(32, 1, .1, 100);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let visible = true;
  let previous = null;
  let elapsed = 0;

  function resize() {
    const { width, height } = host.getBoundingClientRect();
    renderer.setSize(width, height);
    camera.aspect = width / Math.max(1, height);
    const span = Math.max(size.y, Math.max(size.x, size.z) / camera.aspect);
    camera.position.set(0, .08, span / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) * 1.2);
    camera.lookAt(0, .03, 0); camera.updateProjectionMatrix();
    renderer.render(scene, camera);
  }
  function animate(time) {
    if (!visible || document.hidden) { previous = null; return; }
    if (previous !== null) elapsed = (elapsed + Math.min(time - previous, 100)) % 60000;
    previous = time;
    mascot.rotation.y = -.18 + elapsed / 60000 * Math.PI * 2;
    renderer.render(scene, camera);
  }
  function motion() {
    previous = null;
    renderer.setAnimationLoop(reduced.matches ? null : animate);
    if (reduced.matches) { elapsed = 0; mascot.rotation.y = -.18; renderer.render(scene, camera); }
  }
  new ResizeObserver(resize).observe(host);
  new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; }).observe(host);
  reduced.addEventListener("change", motion);
  resize(); motion();
} catch (error) {
  host.textContent = "3d preview unavailable";
  console.error(error);
}
