/** Deferred readiness publication for a renderer that may be destroyed before its frame lands. */
export type PresentedPublisher<T> = {
  /** Defers one snapshot; a later call supersedes any snapshot still waiting for its second frame. */
  publish(snapshot: T): void;
  /** Cancels every pending delivery; later publish calls still deliver. */
  invalidate(): void;
  /** Cancels every pending delivery permanently; later publish calls deliver nothing. */
  dispose(): void;
};

/**
 * This hands a renderer's readiness snapshot to the sink two animation frames after the draw that
 * produced it, mirroring the settle the estimate stands for. A later publish supersedes an earlier
 * pending one, and a destroyed renderer disposes the publisher so no stale snapshot outlives it.
 */
export function createPresentedPublisher<T>(
  present: (snapshot: T) => void,
  raf: (callback: FrameRequestCallback) => number = requestAnimationFrame,
): PresentedPublisher<T> {
  let revision = 0;
  let disposed = false;
  return {
    publish(snapshot: T): void {
      if (disposed) return;
      const atPublish = ++revision;
      raf(() => {
        if (disposed || atPublish !== revision) return;
        raf(() => {
          if (disposed || atPublish !== revision) return;
          present(snapshot);
        });
      });
    },
    invalidate(): void {
      revision++;
    },
    dispose(): void {
      disposed = true;
    },
  };
}
