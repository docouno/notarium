import type { ForceGraphMethods, GraphData, LinkObject, NodeObject } from 'react-force-graph-2d'
import type { GraphNodeView as GraphNode } from '../../libs/wire'

// The link payload beyond the node ids the force engine manages.
export type LinkExtra = { type: string }
// A node/link as the running simulation sees them: the domain shape plus the
// x/y/vx/vy the layout writes onto each node in place.
export type SimNode = NodeObject<GraphNode>
export type SimLink = LinkObject<GraphNode, LinkExtra>
export type GraphInput = GraphData<GraphNode, LinkExtra>
export type FgMethods = ForceGraphMethods<SimNode, SimLink>
export type Rgb = { r: number; g: number; b: number }
