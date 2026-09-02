import { describe, expect, it, vi } from 'vitest'
import {
  CI_BUILDKIT_IMAGE,
  ciBuilderContainerName,
  ciBuilderContextCreateArgs,
  ciBuilderContextName,
  ciBuilderCpuSet,
  ciBuilderCreateArgs,
  createCiDockerBuilder,
  removeCiDockerBuilder,
} from '../../scripts/checkup/ciDockerBuilder.mjs'

describe('CI Docker builder resource boundary', () => {
  it('creates a load-enabled docker-container builder on the resolved CPU half', () => {
    const run = vi
      .fn()
      .mockReturnValueOnce({ status: 0, signal: null })
      .mockReturnValueOnce({ status: 0, signal: null })
      .mockReturnValueOnce({ status: 0, signal: null, stdout: '0-3\n' })

    expect(
      createCiDockerBuilder({
        name: 'notarium-ci-42',
        env: { CHECKUP_CPUSET: '0,1,2,3' },
        run,
      }),
    ).toEqual({ name: 'notarium-ci-42', cpuSet: '0-3' })
    const createArgs = [
      'buildx',
      'create',
      '--name',
      'notarium-ci-42',
      '--driver',
      'docker-container',
      '--driver-opt',
      'cpuset-cpus=0-3',
      '--driver-opt',
      'default-load=true',
      '--driver-opt',
      `image=${CI_BUILDKIT_IMAGE}`,
      '--bootstrap',
      'ctx-notarium-ci-42',
    ]

    expect(ciBuilderContextName('notarium-ci-42')).toBe('ctx-notarium-ci-42')
    expect(ciBuilderContextCreateArgs('notarium-ci-42')).toEqual([
      'context',
      'create',
      'ctx-notarium-ci-42',
    ])
    expect(ciBuilderCreateArgs({ name: 'notarium-ci-42', cpuSet: '0,1,2,3' })).toEqual(createArgs)
    expect(run).toHaveBeenNthCalledWith(1, ['context', 'create', 'ctx-notarium-ci-42'])
    expect(run).toHaveBeenNthCalledWith(2, createArgs)
    expect(run).toHaveBeenNthCalledWith(
      3,
      [
        '--context',
        'ctx-notarium-ci-42',
        'container',
        'inspect',
        ciBuilderContainerName('notarium-ci-42'),
        '--format',
        '{{.HostConfig.CpusetCpus}}',
      ],
      { quiet: true },
    )
  })

  it('fails closed on a missing or mismatched affinity', () => {
    expect(() =>
      createCiDockerBuilder({
        name: 'notarium-ci-42',
        env: {},
        run: vi.fn(),
      }),
    ).toThrow(/resolved CHECKUP_CPUSET/u)
    expect(() =>
      createCiDockerBuilder({
        name: 'notarium-ci-42',
        env: { CHECKUP_CPUSET: '0-3' },
        run: vi
          .fn()
          .mockReturnValueOnce({ status: 0, signal: null })
          .mockReturnValueOnce({ status: 0, signal: null })
          .mockReturnValueOnce({ status: 0, signal: null, stdout: '4-7\n' })
          .mockReturnValueOnce({ status: 0, signal: null })
          .mockReturnValueOnce({ status: 0, signal: null }),
      }),
    ).toThrow(/CPU set mismatch/u)
    expect(ciBuilderCpuSet('0,2,3')).toBe('0,2-3')
    expect(ciBuilderCreateArgs({ name: 'notarium-ci-42', cpuSet: '1,3,5,7' })).toContain(
      '"cpuset-cpus=1,3,5,7"',
    )
  })

  it('removes only the exact owned builder and Docker context names', () => {
    const run = vi.fn().mockReturnValue({ status: 0, signal: null })

    removeCiDockerBuilder({ name: 'notarium-ci-42', run })
    expect(run).toHaveBeenCalledWith(['buildx', 'rm', 'notarium-ci-42'], { quiet: true })
    expect(run).toHaveBeenCalledWith(['context', 'rm', 'ctx-notarium-ci-42'], { quiet: true })
    expect(() => removeCiDockerBuilder({ name: '../shared', run })).toThrow(/invalid/u)
  })

  it('makes cleanup idempotent when neither job-owned resource was created', () => {
    const run = vi
      .fn()
      .mockReturnValueOnce({
        status: 1,
        signal: null,
        stderr: 'failed to remove notarium-ci-42: no builder "notarium-ci-42" found',
      })
      .mockReturnValueOnce({
        status: 1,
        signal: null,
        stderr: 'context "ctx-notarium-ci-42": context not found',
      })

    expect(removeCiDockerBuilder({ name: 'notarium-ci-42', run })).toEqual({
      name: 'notarium-ci-42',
    })
  })

  it('cleans the context when builder setup fails and tolerates an absent builder', () => {
    const run = vi
      .fn()
      .mockReturnValueOnce({ status: 0, signal: null })
      .mockReturnValueOnce({ status: 1, signal: null, stderr: 'builder transport failed' })
      .mockReturnValueOnce({
        status: 1,
        signal: null,
        stderr: 'failed to remove notarium-ci-42: no builder "notarium-ci-42" found',
      })
      .mockReturnValueOnce({ status: 0, signal: null })

    expect(() =>
      createCiDockerBuilder({
        name: 'notarium-ci-42',
        env: { CHECKUP_CPUSET: '0-3' },
        run,
      }),
    ).toThrow(/builder transport failed/u)
    expect(run).toHaveBeenNthCalledWith(3, ['buildx', 'rm', 'notarium-ci-42'], { quiet: true })
    expect(run).toHaveBeenNthCalledWith(4, ['context', 'rm', 'ctx-notarium-ci-42'], {
      quiet: true,
    })
  })
})
