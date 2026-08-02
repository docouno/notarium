// Minimal typings for the slice of d3-force-3d the graph canvas uses (the package
// ships no declarations). Only the forces and simulation methods we actually
// chain are declared — enough to type the call sites without `any`.
declare module 'd3-force-3d' {
  type ForceAccessor<N> = number | ((node: N, i: number, nodes: N[]) => number)

  interface CollideForce<N> {
    (alpha: number): void
    radius(radius: ForceAccessor<N>): this
    strength(strength: number): this
    iterations(iterations: number): this
  }

  interface PositionForce<N> {
    (alpha: number): void
    strength(strength: ForceAccessor<N>): this
    x(x: ForceAccessor<N>): this
    y(y: ForceAccessor<N>): this
  }

  interface ChargeForce<N> {
    (alpha: number): void
    strength(strength: ForceAccessor<N>): this
    distanceMax(distance: number): this
  }

  interface LinkForce<L> {
    (alpha: number): void
    distance(distance: number | ((link: L) => number)): this
    strength(strength: number | ((link: L) => number)): this
  }

  interface Simulation<N> {
    alpha(): number
    alpha(alpha: number): this
    alphaDecay(decay: number): this
    velocityDecay(decay: number): this
    force(name: string, force: ((alpha: number) => void) | null): this
    stop(): this
    tick(iterations?: number): this
    nodes(): N[]
  }

  export function forceCollide<N = unknown>(radius?: ForceAccessor<N>): CollideForce<N>
  export function forceX<N = unknown>(x?: ForceAccessor<N>): PositionForce<N>
  export function forceY<N = unknown>(y?: ForceAccessor<N>): PositionForce<N>
  export function forceManyBody<N = unknown>(): ChargeForce<N>
  export function forceLink<L = unknown>(links?: L[]): LinkForce<L>
  export function forceSimulation<N = unknown>(nodes?: N[], numDimensions?: number): Simulation<N>
}
