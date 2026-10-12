import { maxOf, minOf } from '#render-common/array-aggregation.ts';
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { epistemicColors, selectionNeighbourhood, shortLabel } from "./model.ts";
import type { ReviewExport, ReviewNode, ReviewEdge } from "./model.ts";

export function mount3d(host: HTMLElement, data: ReviewExport, nodes: ReviewNode[], edges: ReviewEdge[], onSelect: (id: string) => void) {
  const scene = new THREE.Scene(); scene.background = new THREE.Color("#101725");
  const camera = new THREE.PerspectiveCamera(52, 1, 0.01, 100); camera.position.set(0, 0.5, 5.5);
  const renderer = new THREE.WebGLRenderer({ antialias: true }); renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); host.append(renderer.domElement);
  const labels = new CSS2DRenderer(); labels.domElement.style.position = "absolute"; labels.domElement.style.inset = "0"; labels.domElement.style.pointerEvents = "none"; host.append(labels.domElement);
  const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.dampingFactor = 0.08;
  scene.add(new THREE.AmbientLight(0xffffff, 1.8)); const light = new THREE.DirectionalLight(0xffffff, 2.2); light.position.set(2, 4, 5); scene.add(light);
  const group = new THREE.Group(); scene.add(group);
  const meshes: THREE.Mesh[] = []; const meshById = new Map<string, THREE.Mesh>();
  const labelEntries: { node: ReviewNode; element: HTMLSpanElement }[] = [];
  const material = (node: ReviewNode) => new THREE.MeshStandardMaterial({ color: epistemicColors[node.epistemic] ?? "#d2dbe8", roughness: 0.42, emissive: epistemicColors[node.epistemic] ?? "#d2dbe8", emissiveIntensity: 0.15, transparent: true });
  const geometry = (type: string) => {
    switch (type) {
      case "domain": return new THREE.IcosahedronGeometry(0.095, 0);
      case "connection": return new THREE.SphereGeometry(0.078, 12, 10);
      case "evidence": return new THREE.TetrahedronGeometry(0.045);
      case "record": return new THREE.BoxGeometry(0.065, 0.065, 0.065);
      case "conversation": return new THREE.TorusGeometry(0.065, 0.02, 6, 12);
      case "candidate": return new THREE.ConeGeometry(0.065, 0.11, 8);
      default: return new THREE.OctahedronGeometry(0.075);
    }
  };
  for (const node of nodes) {
    const mesh = new THREE.Mesh(geometry(node.type), material(node));
    const p = data.layouts["3d"][node.id] ?? [0, 0, 0]; mesh.position.set((p[0] ?? 0) * 1.5, (p[1] ?? 0) * 1.5, (p[2] ?? 0) * 1.5);
    mesh.userData.id = node.id; group.add(mesh); meshes.push(mesh); meshById.set(node.id, mesh);
    const element = document.createElement("span"); element.className = "space-label"; element.textContent = shortLabel(node); element.title = String(node.text ?? node.label);
    const label = new CSS2DObject(element); label.position.set(0, 0.11, 0); mesh.add(label); labelEntries.push({ node, element });
  }
  const edgeLines: THREE.Line[] = []; const edgeById = new Map(edges.map((edge) => [edge.id, edge]));
  for (const edge of edges) {
    const a = meshById.get(edge.source), b = meshById.get(edge.target); if (!a || !b) continue;
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a.position, b.position]), new THREE.LineBasicMaterial({ color: "#607891", transparent: true, opacity: 0.45 }));
    line.userData.id = edge.id; group.add(line); edgeLines.push(line);
  }
  const gizmo = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  gizmo.setAttribute("viewBox", "0 0 112 112"); gizmo.setAttribute("aria-label", "Orientamento x y z");
  gizmo.style.cssText = "position:absolute;left:16px;bottom:16px;width:112px;height:112px;pointer-events:none;background:#152033bb;border:1px solid #526880;border-radius:8px";
  const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
  const axisMarks = axes.map((_, index) => { const line = document.createElementNS("http://www.w3.org/2000/svg", "line"); const letter = document.createElementNS("http://www.w3.org/2000/svg", "text");
    const color = ["#f07e80", "#72dba7", "#7cbcff"][index]!; line.setAttribute("stroke", color); line.setAttribute("stroke-width", "2");
    letter.setAttribute("fill", "#ffffff"); letter.setAttribute("stroke", color); letter.setAttribute("paint-order", "stroke"); letter.setAttribute("stroke-width", "0.6"); letter.setAttribute("font-size", "17"); letter.setAttribute("font-weight", "bold"); letter.style.pointerEvents = "auto"; letter.style.cursor = "pointer"; letter.textContent = ["X", "Y", "Z"][index]!;
    letter.addEventListener("click", () => { const direction = axes[index]!; const distance = camera.position.distanceTo(controls.target); camera.position.copy(controls.target).addScaledVector(direction, distance); camera.up.set(0, 0, 1); controls.update(); });
    gizmo.append(line, letter); return { line, letter }; }); host.append(gizmo);
  const drawGizmo = () => { const inverse = camera.quaternion.clone().invert(); axes.forEach((axis, index) => {
    const point = axis.clone().applyQuaternion(inverse).multiplyScalar(34); const x = 56 + point.x, y = 56 - point.y;
    const { line, letter } = axisMarks[index]!; line.setAttribute("x1", "56"); line.setAttribute("y1", "56"); line.setAttribute("x2", String(x)); line.setAttribute("y2", String(y));
    letter.setAttribute("x", String(x + 3)); letter.setAttribute("y", String(y - 3));
  }); };
  const boundingSphere = (ids: Set<string>) => {
    const points = [...ids].map((id) => meshById.get(id)?.position).filter((point): point is THREE.Vector3 => point !== undefined);
    const result = new THREE.Sphere().setFromPoints(points);
    result.radius = Math.max(result.radius, 0.15); return result;
  };
  const sphere = boundingSphere(new Set(nodes.map((node) => node.id)));
  const fitDistance = (radius: number) => {
    // A perspective sphere occupies 82.5% of the smaller screen dimension.
    const verticalHalf = THREE.MathUtils.degToRad(camera.fov) / 2;
    const occupiedHalfAngle = Math.atan(Math.tan(verticalHalf) * Math.min(1, camera.aspect) * 0.825);
    return radius / Math.sin(occupiedHalfAngle);
  };
  const viewDirection = new THREE.Vector3(0.25, 0.2, 1).normalize();
  const setDepth = (distance: number, radius: number) => {
    camera.near = Math.max(0.01, distance - radius * 2.5); camera.far = distance + radius * 3;
    camera.updateProjectionMatrix();
    scene.fog = new THREE.Fog("#101725", Math.max(0, distance - radius * 0.7), distance + radius * 2.2);
  };
  const fit = () => { const distance = fitDistance(sphere.radius);
    controls.target.copy(sphere.center); camera.position.copy(sphere.center).addScaledVector(viewDirection, distance);
    setDepth(distance, sphere.radius); controls.update(); };
  const raycaster = new THREE.Raycaster(); const pointer = new THREE.Vector2(); let start: { x: number; y: number } | null = null;
  renderer.domElement.addEventListener("pointerdown", (event) => { start = { x: event.clientX, y: event.clientY }; });
  const pick = (event: MouseEvent) => {
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
    const box = renderer.domElement.getBoundingClientRect(); pointer.set((event.clientX - box.left) / box.width * 2 - 1, -(event.clientY - box.top) / box.height * 2 + 1);
    raycaster.setFromCamera(pointer, camera); const hit = raycaster.intersectObjects(meshes)[0]; onSelect(hit ? hit.object.userData.id as string : "");
  };
  renderer.domElement.addEventListener("click", pick);
  const resize = () => { const { width, height } = host.getBoundingClientRect(); camera.aspect = width / Math.max(1, height); renderer.setSize(width, height); labels.setSize(width, height); fit(); };
  const observer = new ResizeObserver(resize); observer.observe(host); resize();
  let frame = 0, renderedFrames = 0; let focusTarget: THREE.Vector3 | null = null; let focusCamera: THREE.Vector3 | null = null;
  let selection = selectionNeighbourhood({ nodes, edges }, null);
  const emphasis = new THREE.Group(); group.add(emphasis);
  const clearEmphasis = () => { for (const child of [...emphasis.children]) { emphasis.remove(child); const mesh = child as THREE.Mesh; mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); } };
  const collideLabels = () => { const accepted: DOMRect[] = []; const priority = (entry: typeof labelEntries[number]) =>
    selection.primary.has(entry.node.id) ? 0 : selection.nodes.has(entry.node.id) ? 1 : entry.node.type === "domain" ? 2 : 3;
    for (const entry of labelEntries) { entry.element.style.visibility = entry.node.type === "domain" || entry.node.type === "connection" || selection.nodes.has(entry.node.id) ? "visible" : "hidden";
      entry.element.style.translate = "0 0";
      entry.element.style.opacity = selection.primary.size > 0 && !selection.nodes.has(entry.node.id) ? "0.25" : "1"; }
    const viewport = host.getBoundingClientRect();
    for (const entry of [...labelEntries].sort((a, b) => priority(a) - priority(b) || a.node.id.localeCompare(b.node.id))) {
      if (entry.element.style.visibility === "hidden" || entry.element.style.display === "none") continue;
      const offsets = priority(entry) <= 1 ? [[0, 0], [0, -20], [0, 20], [-44, 0], [44, 0], [-44, -20], [44, -20]] : [[0, 0]];
      let placed = false;
      for (const [x, y] of offsets) {
        entry.element.style.translate = `${x}px ${y}px`;
        const box = entry.element.getBoundingClientRect();
        if (box.width === 0 || box.height === 0 || box.left < viewport.left || box.right > viewport.right || box.top < viewport.top || box.bottom > viewport.bottom ||
            accepted.some((other) => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top)) continue;
        accepted.push(box); placed = true; break;
      }
      if (!placed) entry.element.style.visibility = "hidden";
    } };
  const draw = () => { frame = requestAnimationFrame(draw); if (focusTarget && focusCamera) { controls.target.lerp(focusTarget, 0.12); camera.position.lerp(focusCamera, 0.12); if (controls.target.distanceTo(focusTarget) < 0.005 && camera.position.distanceTo(focusCamera) < 0.005) { controls.target.copy(focusTarget); camera.position.copy(focusCamera); focusTarget = null; focusCamera = null; } }
    controls.update(); renderer.render(scene, camera); labels.render(scene, camera); collideLabels(); drawGizmo(); renderedFrames++; }; draw();
  return {
    focus(id: string) { const focusSphere = id ? boundingSphere(selection.nodes) : sphere;
      const distance = fitDistance(focusSphere.radius);
      const direction = camera.position.clone().sub(controls.target).normalize();
      focusTarget = focusSphere.center.clone(); focusCamera = focusSphere.center.clone().addScaledVector(direction, distance);
      setDepth(distance, focusSphere.radius);
    },
    highlight(id: string | null) { selection = selectionNeighbourhood({ nodes, edges }, id); clearEmphasis();
      const active = selection.primary.size > 0;
      for (const mesh of meshes) { const material = mesh.material as THREE.MeshStandardMaterial;
        material.opacity = !active || selection.nodes.has(mesh.userData.id as string) ? 1 : 0.25;
        mesh.scale.setScalar(selection.primary.has(mesh.userData.id as string) ? 1.55 : 1);
      }
      for (const line of edgeLines) { const incident = selection.edges.has(line.userData.id as string); const material = line.material as THREE.LineBasicMaterial;
        material.opacity = !active ? 0.45 : incident ? 1 : 0.25;
        material.color.set(incident ? "#ffffff" : "#607891");
        if (!incident) continue;
        const edge = edgeById.get(line.userData.id as string)!;
        const a = meshById.get(edge.source)!.position, b = meshById.get(edge.target)!.position;
        const delta = new THREE.Vector3().subVectors(b, a);
        const thick = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, delta.length(), 6),
          new THREE.MeshBasicMaterial({ color: "#eefaff", transparent: true, opacity: 0.92, depthWrite: false }));
        thick.position.copy(a).add(b).multiplyScalar(0.5);
        thick.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize()); emphasis.add(thick);
      }
    },
    cameraPosition() { return { x: camera.position.x, y: camera.position.y, z: camera.position.z, settled: focusTarget === null }; },
    renderedFrames() { return renderedFrames; },
    depthStats() { const values = meshes.map((mesh) => mesh.position.z); const mean = values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
      return { min: minOf(values), max: maxOf(values), std: Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length)) }; },
    destroy() { cancelAnimationFrame(frame); observer.disconnect(); controls.dispose(); clearEmphasis(); for (const mesh of meshes) { mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); } for (const line of edgeLines) { line.geometry.dispose(); (line.material as THREE.Material).dispose(); } renderer.dispose(); host.replaceChildren(); },
  };
}
