import type * as THREE from "three";
import type { RetainedResourceWitness } from "#engine/renderer-handle.ts";

/** This counts and disposes renderer-owned graphics resources and does not count shared Three defaults. */
export class ResourceRegistry {
  private readonly geometries = new Set<THREE.BufferGeometry>();
  private readonly materials = new Set<THREE.Material>();
  private readonly textures = new Set<THREE.Texture>();
  private disposed = false;

  /** This registers one owned geometry and does not clone it. */
  registerGeometry<T extends THREE.BufferGeometry>(geometry: T): T {
    this.assertOpen();
    this.geometries.add(geometry);
    return geometry;
  }

  /** This registers one owned material and does not clone it. */
  registerMaterial<T extends THREE.Material>(material: T): T {
    this.assertOpen();
    this.materials.add(material);
    return material;
  }

  /** This registers one owned texture and does not upload it. */
  registerTexture<T extends THREE.Texture>(texture: T): T {
    this.assertOpen();
    this.textures.add(texture);
    return texture;
  }

  /** This reports currently retained owned resources and does not dispose them. */
  readRetainedResources(domOverlayNodes: number): RetainedResourceWitness {
    return {
      geometries: this.geometries.size,
      materials: this.materials.size,
      textures: this.textures.size,
      domOverlayNodes,
    };
  }

  /** This disposes every registered resource once and does not retain disposed objects in its sets. */
  disposeAll(): void {
    if (this.disposed) {
      return;
    }
    for (const texture of this.textures) {
      texture.dispose();
    }
    for (const material of this.materials) {
      material.dispose();
    }
    for (const geometry of this.geometries) {
      geometry.dispose();
    }
    this.textures.clear();
    this.materials.clear();
    this.geometries.clear();
    this.disposed = true;
  }

  private assertOpen(): void {
    if (this.disposed) {
      throw new TypeError("cannot register a resource after disposal");
    }
  }
}
