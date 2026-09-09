# Upstream sources

`three/editor`, `three/examples/fonts`, and `three/LICENSE` are copied from Three.js **r186**, commit `148ef33ecb6d2502ff796d4554abd1549c95d519`:

https://github.com/mrdoob/three.js/tree/r186/editor

Three.js and its editor are MIT-licensed. The original license is retained at `three/LICENSE`. Individual font licenses are retained with their files. The matching runtime and example modules are installed as `three@0.186.0` and copied at build time.

The additional `three/editor/js/libs/draco_encoder.js` is the upstream editor's pinned Draco **1.5.7** browser encoder, downloaded from:

https://cdn.jsdelivr.net/gh/google/draco@1.5.7/javascript/draco_encoder.js

Draco is Apache-2.0 licensed; see `draco-LICENSE`.

The upstream editor source is preserved. `scripts/build.ts` replaces its HTML bootstrap with Fiend's integration and adjusts two root-relative example asset paths in the build output. Fiend owns cloud persistence and hides the upstream local-autosave control and executable-script tab.

The editor's path tracer and BVH dependency are pinned to the versions in the upstream import map (`three-gpu-pathtracer@0.0.23`, `three-mesh-bvh@0.7.4`). Their MIT licenses, and the Three.js license, are included in deployed assets under `/labs/fiend/lib/`.
