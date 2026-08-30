import { WorldBuilder } from '../generators'
import type { CaseSpec, ProviderSeedDecl } from '../types'

const model = (name: string) => ({ name, dimensions: null, status: 'available' as const })

const enabledProviders = (): ProviderSeedDecl => ({
  enabled: true,
  privateOrigins: ['http://host.docker.internal:11434'],
  credentials: [
    {
      ref: 'shared',
      owner: 'sergey',
      name: 'Shared OpenAI credential',
      kind: 'bearer',
      secret: 'seed-provider-value-shared',
      origin: 'https://provider.example',
      rpm: 60,
      tpm: 120_000,
    },
    {
      ref: 'unused',
      owner: 'sergey',
      name: 'Unused credential',
      kind: 'header',
      secret: 'seed-provider-value-unused',
      origin: 'https://unused.example',
      injection: { header: 'x-seed-key', prefix: '' },
    },
    {
      ref: 'disabled',
      owner: 'sergey',
      name: 'Disabled credential',
      kind: 'bearer',
      secret: 'seed-provider-value-disabled',
      origin: 'https://disabled.example',
      disabled: true,
    },
    {
      ref: 'mismatch',
      owner: 'sergey',
      name: 'Origin mismatch credential',
      kind: 'bearer',
      secret: 'seed-provider-value-mismatch',
      origin: 'https://matched.example',
    },
  ],
  resources: [
    {
      ref: 'primary',
      owner: 'sergey',
      name: 'Primary',
      wire: 'openai-compatible',
      baseUrl: 'https://provider.example/v1',
      purposes: ['chat'],
      models: [model('seed-chat-primary')],
      defaultModel: 'seed-chat-primary',
      credential: 'shared',
    },
    {
      ref: 'secondary',
      owner: 'sergey',
      name: 'Secondary',
      wire: 'openai-compatible',
      baseUrl: 'https://provider.example/v1',
      purposes: ['embedding'],
      models: [{ ...model('seed-embed'), dimensions: 1536 }],
      defaultModel: 'seed-embed',
      credential: 'shared',
    },
    {
      ref: 'local-no-credential',
      owner: 'sergey',
      name: 'Local Ollama without credential',
      wire: 'ollama',
      baseUrl: 'http://host.docker.internal:11434',
      allowPrivateNetwork: true,
      purposes: ['chat', 'embedding'],
      models: [model('qwen3:8b')],
      defaultModel: 'qwen3:8b',
    },
    {
      ref: 'disabled-credential-resource',
      owner: 'sergey',
      name: 'Credential disabled',
      wire: 'openai-compatible',
      baseUrl: 'https://disabled.example/v1',
      purposes: ['chat'],
      models: [model('seed-disabled')],
      credential: 'disabled',
    },
    {
      ref: 'origin-mismatch',
      owner: 'sergey',
      name: 'Credential origin mismatch',
      wire: 'openai-compatible',
      baseUrl: 'https://matched.example/v1',
      mismatchedBaseUrl: 'https://other.example/v1',
      purposes: ['chat'],
      models: [model('seed-mismatch')],
      credential: 'mismatch',
    },
    {
      ref: 'unreadable-header',
      owner: 'sergey',
      name: 'Unreadable custom header',
      wire: 'openai-compatible',
      baseUrl: 'https://headers.example/v1',
      headers: { 'x-seed-private': 'seed-provider-header-value' },
      unreadableHeaders: true,
      purposes: ['chat'],
      models: [model('seed-unreadable')],
    },
    {
      ref: 'reconsent',
      owner: 'sergey',
      name: 'Changed after acceptance',
      wire: 'openai-compatible',
      baseUrl: 'https://reconsent.example/v1',
      purposes: ['chat'],
      models: [model('seed-reconsent')],
    },
    {
      ref: 'pending',
      owner: 'sergey',
      name: 'Offer near expiry',
      wire: 'openai-compatible',
      baseUrl: 'https://pending.example/v1',
      purposes: ['chat'],
      models: [model('seed-pending')],
    },
    {
      ref: 'owner-disabled',
      owner: 'disabled-owner',
      name: 'Deactivated owner resource',
      wire: 'openai-compatible',
      baseUrl: 'https://disabled-owner.example/v1',
      purposes: ['chat'],
      models: [model('seed-owner-disabled')],
    },
    {
      ref: 'archived-space',
      owner: 'archive-owner',
      name: 'Archived Space resource',
      wire: 'openai-compatible',
      baseUrl: 'https://archived.example/v1',
      purposes: ['chat'],
      models: [model('seed-archived')],
    },
  ],
  attachments: [
    {
      ref: 'primary-active',
      resource: 'primary',
      target: { kind: 'space', space: 'main' },
      manager: 'sergey',
      state: 'active',
    },
    {
      ref: 'needs-reconsent',
      resource: 'reconsent',
      target: { kind: 'space', space: 'main' },
      manager: 'sergey',
      state: 'awaiting-reconsent',
      reconsentBaseUrl: 'https://reconsent.example/v2',
    },
    {
      ref: 'expiring-offer',
      resource: 'pending',
      target: { kind: 'space', space: 'main' },
      manager: 'sergey',
      state: 'pending',
      expiresInMs: 5 * 60 * 1000,
    },
    {
      ref: 'disabled-owner-active',
      resource: 'owner-disabled',
      target: { kind: 'space', space: 'main' },
      manager: 'sergey',
      state: 'active',
    },
    {
      ref: 'archived-active',
      resource: 'archived-space',
      target: { kind: 'space', space: 'archive-target' },
      manager: 'sergey',
      state: 'active',
    },
  ],
})

export const providers: CaseSpec = {
  name: 'providers',
  description:
    'Provider credentials/resources/consent states: shared and absent credentials, closed invalidity reasons, pending/reconsent/archived attachments and real encrypted fake carriers.',
  axes: ['providers', 'auth'],
  build: ({ now }) => {
    const b = new WorldBuilder(now)
    b.space({ slug: 'main', displayName: 'Main' })
    b.space({ slug: 'archive-target', displayName: 'Archived target', archived: true })
    b.user({
      username: 'sergey',
      password: 'seed-pass',
      displayName: 'Sergey',
      admin: true,
    })
    b.user({
      username: 'disabled-owner',
      password: 'seed-pass',
      displayName: 'Disabled Owner',
      disabled: true,
    })
    b.user({ username: 'archive-owner', password: 'seed-pass', displayName: 'Archive Owner' })
    b.user({ username: 'no-model', password: 'seed-pass', displayName: 'No Model' })
    b.member({ space: 'main', username: 'sergey', role: 'owner' })
    b.member({ space: 'main', username: 'disabled-owner', role: 'writer' })
    b.member({ space: 'archive-target', username: 'sergey', role: 'owner' })
    b.member({ space: 'archive-target', username: 'archive-owner', role: 'writer' })

    return { ...b.build(), providers: enabledProviders() }
  },
}

export const providersDisabled: CaseSpec = {
  name: 'providers-disabled',
  description:
    'A disabled provider subsystem over a non-empty encrypted credential/resource database — routes and surfaces stay absent while backup-visible rows survive.',
  axes: ['providers', 'auth'],
  build: ({ now }) => {
    const b = new WorldBuilder(now)
    b.space({ slug: 'main', displayName: 'Main' })
    b.user({
      username: 'sergey',
      password: 'seed-pass',
      displayName: 'Sergey',
      admin: true,
    })
    b.member({ space: 'main', username: 'sergey', role: 'owner' })

    return {
      ...b.build(),
      providers: {
        enabled: false,
        credentials: [
          {
            ref: 'preserved',
            owner: 'sergey',
            name: 'Preserved while disabled',
            kind: 'bearer',
            secret: 'seed-provider-value-preserved',
            origin: 'https://preserved.example',
          },
        ],
        resources: [
          {
            ref: 'preserved',
            owner: 'sergey',
            name: 'Preserved while disabled',
            wire: 'openai-compatible',
            baseUrl: 'https://preserved.example/v1',
            purposes: ['chat'],
            models: [model('seed-preserved')],
            credential: 'preserved',
          },
        ],
        attachments: [],
      },
    }
  },
}
