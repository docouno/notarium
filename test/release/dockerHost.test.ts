// Where a drill publishes the container it just started, and where it then looks for
// it. Both the backup drill and the release probe once assumed those were the same
// machine; under a remote daemon they are not, and the symptom — a health poll that
// times out — reads as a broken product rather than a misaddressed probe.

import { connect, createServer } from 'node:net'
import { describe, expect, it } from 'vitest'

import { daemonHostFrom, forwardToDaemon, publishTarget } from '../../scripts/dockerHost.mjs'

describe('daemonHostFrom', () => {
  it('reads the host out of a TCP daemon address', () => {
    expect(daemonHostFrom('tcp://docker:2376')).toBe('docker')
  })

  it('treats a unix socket as local', () => {
    expect(daemonHostFrom('unix:///var/run/docker.sock')).toBeNull()
  })

  it('treats an unset DOCKER_HOST as local', () => {
    expect(daemonHostFrom(undefined)).toBeNull()
    expect(daemonHostFrom('')).toBeNull()
  })

  it('falls back to local on anything it cannot parse', () => {
    // "I do not know where the daemon is" has to resolve to the conservative
    // behaviour — a loopback bind — not to a listening address nobody vetted.
    expect(daemonHostFrom('not a url')).toBeNull()
  })
})

describe('publishTarget', () => {
  it('binds to loopback and probes loopback with a local daemon', () => {
    // The security property: a release build runs on a shared developer machine and
    // boots an AUTH_MODE=none container for seconds. It has no business being
    // reachable from the LAN.
    expect(publishTarget(undefined, 3000)).toEqual({
      publishSpec: '127.0.0.1::3000',
      probeHost: '127.0.0.1',
    })
  })

  it('binds where the client can reach it with a remote daemon', () => {
    expect(publishTarget('tcp://docker:2376', 3000)).toEqual({
      publishSpec: '0.0.0.0::3000',
      probeHost: 'docker',
    })
  })
})

describe('forwardToDaemon', () => {
  // A registry address cannot follow the daemon the way a probe host can — it is baked
  // into the image reference and has to stay `localhost`, because that is the one name
  // `buildx imagetools inspect` will speak plain HTTP to. So the PORT moves instead,
  // and this is the only part of that trick that can go silently wrong.
  //
  // The daemon side is 127.0.0.2 — a second loopback address, so "over there" and
  // "here" are genuinely different endpoints on the SAME port number, which is exactly
  // the shape the forwarder has to survive.
  const PORT = 57391

  it('carries bytes to the daemon side and back', async () => {
    const far = createServer((socket) => {
      socket.on('data', (chunk) => socket.end(`far:${chunk}`))
    })

    await new Promise<void>((resolve) => far.listen(PORT, '127.0.0.2', () => resolve()))
    const forward = forwardToDaemon(`tcp://127.0.0.2:2376`, PORT)

    try {
      const answer = await new Promise<string>((resolve, reject) => {
        const socket = connect(PORT, '127.0.0.1', () => socket.end('ping'))
        let seen = ''

        socket.setEncoding('utf8')
        socket.on('data', (chunk) => (seen += chunk))
        socket.on('error', reject)
        socket.on('close', () => resolve(seen))
      })

      expect(answer).toBe('far:ping')
    } finally {
      forward?.close()
      far.close()
    }
  })

  it('survives a connection that arrives before the far side listens', async () => {
    // The caller polls for readiness, so this is the NORMAL first attempt, not an edge
    // case. An unhandled socket error here would take the whole drill down.
    const forward = forwardToDaemon('tcp://127.0.0.2:2376', PORT)

    try {
      await expect(
        new Promise<string>((resolve, reject) => {
          const socket = connect(PORT, '127.0.0.1', () => socket.end('ping'))

          socket.on('error', reject)
          socket.on('close', () => resolve('closed'))
        }),
      ).resolves.toBe('closed')
    } finally {
      forward?.close()
    }
  })

  it('does nothing at all when the daemon is local', () => {
    expect(forwardToDaemon(undefined, 5000)).toBeNull()
    expect(forwardToDaemon('unix:///var/run/docker.sock', 5000)).toBeNull()
  })
})
