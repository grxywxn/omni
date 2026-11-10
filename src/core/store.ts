// A tiny reactive value. No framework needed — keeps memory and bundle size low.
export type Listener<T> = (value: T) => void;

export class Store<T> {
  private listeners = new Set<Listener<T>>();
  constructor(private value: T) {}

  get(): T {
    return this.value;
  }

  set(value: T): void {
    this.value = value;
    for (const l of [...this.listeners]) l(value);
  }

  update(fn: (v: T) => T): void {
    this.set(fn(this.value));
  }

  /** Subscribe; the listener runs immediately with the current value. Returns an unsubscribe fn. */
  subscribe(listener: Listener<T>, immediate = true): () => void {
    this.listeners.add(listener);
    if (immediate) listener(this.value);
    return () => this.listeners.delete(listener);
  }
}

/** Collects cleanup functions so a view can release everything it subscribed to. */
export class Disposer {
  private fns: Array<() => void> = [];
  add(fn: (() => unknown) | void | undefined): void {
    if (fn) this.fns.push(fn as () => void);
  }
  dispose(): void {
    for (const fn of this.fns.splice(0).reverse()) {
      try {
        fn();
      } catch (e) {
        console.error(e);
      }
    }
  }
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
