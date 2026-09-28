/**
 * happy-dom never lays out elements, so ResizeObserver callbacks never fire.
 * This fake lets a step decide when an element gains a visible size.
 */
export class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  targets: Element[] = []

  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this)
  }

  observe(target: Element) {
    this.targets.push(target)
  }

  unobserve(target: Element) {
    this.targets = this.targets.filter(item => item !== target)
  }

  disconnect() {
    this.targets = []
  }

  static resizeAll(width: number, height: number) {
    for (const observer of FakeResizeObserver.instances) {
      const entries = observer.targets.map(target => ({ target, contentRect: { width, height } }))
      if (entries.length)
        observer.callback(entries as unknown as ResizeObserverEntry[], observer as unknown as ResizeObserver)
    }
  }

  static reset() {
    FakeResizeObserver.instances = []
  }
}
