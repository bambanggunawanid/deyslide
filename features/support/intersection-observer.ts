/**
 * happy-dom lays nothing out, so its IntersectionObserver never reports.
 * This fake lets a step say which watched elements are in view.
 */
export class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = []
  readonly targets = new Set<Element>()

  constructor(private readonly callback: IntersectionObserverCallback, readonly options: IntersectionObserverInit = {}) {
    FakeIntersectionObserver.instances.push(this)
  }

  observe(target: Element) {
    this.targets.add(target)
  }

  unobserve(target: Element) {
    this.targets.delete(target)
  }

  disconnect() {
    this.targets.clear()
  }

  takeRecords(): IntersectionObserverEntry[] {
    return []
  }

  /**
   * Every observer reports its elements: in view when `inView` says true,
   * out of view when it says false. Elements it says nothing about are not
   * reported.
   */
  static report(inView: (target: Element) => boolean | undefined) {
    for (const observer of FakeIntersectionObserver.instances) {
      const entries = [...observer.targets].flatMap((target) => {
        const visible = inView(target)
        return visible === undefined ? [] : [{ target, isIntersecting: visible, intersectionRatio: visible ? 1 : 0 }]
      })
      if (entries.length)
        observer.callback(entries as unknown as IntersectionObserverEntry[], observer as unknown as IntersectionObserver)
    }
  }

  static reset() {
    FakeIntersectionObserver.instances = []
  }
}
