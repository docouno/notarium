// Where a container this process starts is actually reachable from.
//
// `docker port` answers in the DAEMON's network namespace, not ours. Those are the
// same place only when the daemon is local; under a remote one — dind in CI — the
// published port lives over there, and probing our own loopback reaches nothing but a
// timeout that reads as "the product never came up". Two drills learned this the
// expensive way, which is why the rule lives in one place rather than in each of them.

import { connect, createServer } from 'node:net'
import { pathToFileURL } from 'node:url'

/** The host a remote daemon is reached at, or null when it is our own machine.
 *  Deliberately null for a unix socket and for anything unparseable: "I do not know
 *  where the daemon is" must resolve to the conservative local behaviour, not to a
 *  bind address nobody vetted. */
export const daemonHostFrom = (dockerHost) => {
  if (!dockerHost || dockerHost.startsWith('unix:')) {
    return null
  }

  try {
    return new URL(dockerHost.replace(/^tcp:/, 'http:')).hostname || null
  } catch {
    return null
  }
}

/** Make `localhost:<port>` on THIS side mean the daemon's published port on the other.
 *
 *  Some things cannot follow the daemon the way a probe host can. A registry address is
 *  baked into the image reference, and it has to be `localhost` because that is the one
 *  name both halves of a publish accept over plain HTTP: the daemon can be told about
 *  other names with --insecure-registry, but `buildx imagetools inspect` — the
 *  client-side read of a published tag — has no such flag at all.
 *
 *  Returns null when the daemon is local and the address already means what it says.
 *  Plain TCP rather than a shell forwarder (socat, nc): that would be one more package
 *  for every image that runs a drill. Do NOT call this in a process that then blocks —
 *  see the script entry at the bottom. */
export const forwardToDaemon = (dockerHost, port) => {
  const daemonHost = daemonHostFrom(dockerHost)

  if (!daemonHost) {
    return null
  }
  // allowHalfOpen on BOTH sides. Without it Node ends a socket's writable half as soon
  // as its readable half ends, so a client that says its piece and half-closes — which
  // is ordinary TCP, and what a `Connection: close` request looks like — has the reply
  // cut off before it arrives. The forwarder has to be faithful to bytes, not to the
  // shape of the traffic that happens to be common.
  const server = createServer({ allowHalfOpen: true }, (from) => {
    const to = connect({ port, host: daemonHost, allowHalfOpen: true })

    // A connection that arrives before the far side is listening is ordinary — the
    // caller is usually polling for readiness. It must not surface as an unhandled
    // 'error' and take the run down.
    from.on('error', () => from.destroy())
    to.on('error', () => from.destroy())
    from.pipe(to)
    to.pipe(from)
  })

  server.listen(port, '127.0.0.1')

  return server
}

/** How a container must publish a port, and where to then look for it.
 *
 *  Local keeps the loopback bind, which is what stops a drill from exposing an
 *  unauthenticated instance on every interface of a shared machine. A remote daemon
 *  has to publish somewhere its client can reach, and there that surface is the
 *  job-scoped throwaway network the dind service owns. */
export const publishTarget = (dockerHost, containerPort) => {
  const daemonHost = daemonHostFrom(dockerHost)

  return {
    publishSpec: daemonHost ? `0.0.0.0::${containerPort}` : `127.0.0.1::${containerPort}`,
    probeHost: daemonHost ?? '127.0.0.1',
  }
}

/** RUN THE FORWARDER IN ITS OWN PROCESS — `node scripts/dockerHost.mjs forward <port>`.
 *
 *  Sharing a process with the code that uses the forwarded port is a deadlock, not a
 *  style question. The release entrypoint drives docker through `spawnSync`, which
 *  blocks the event loop for the whole of the child's life, so the forwarder can never
 *  accept the connection that child is waiting on. Both sides then wait forever: it
 *  hung a CI job for twenty minutes at `buildx imagetools inspect`, with a healthy
 *  registry on one side and a healthy client on the other. */
const main = () => {
  const [command, port] = process.argv.slice(2)

  if (command !== 'forward' || !Number(port)) {
    console.error('usage: dockerHost.mjs forward <port>')
    process.exit(1)
  }
  if (!forwardToDaemon(process.env.DOCKER_HOST, Number(port))) {
    console.error('dockerHost: the daemon is local — nothing to forward')
    process.exit(0)
  }
  console.error(`dockerHost: forwarding localhost:${port} to the daemon`)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main()
}
