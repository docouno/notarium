#!/usr/bin/env node
// Lockstep version bump: set every package to ONE product version, fold the
// Changelog, commit, tag vX.Y.Z. SemVer; all packages share the root version. Only
// the `notarium` CLI publishes to npm, and by hand rather than from here, so
// per-package semver would still be ceremony. 0.x: minor = features, patch = fixes.
// Usage: npm run release <patch|minor|major|x.y.z>
// This owns the VERSION; `npm run release:image` owns the artifact built
// from the resulting tag. Local only — makes a commit + annotated tag; pushing the
// tag is on you, and it must be public before the image can point at it. Refuses
// on a dirty tree or an existing tag so a half-done bump never strands the repo.
// canon: docs/release.md
import { execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { foldUnreleased } from './releaseIdentity.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const die = (msg) => {
  console.error(msg)
  process.exit(1)
}
const sh = (cmd, opts = {}) => execSync(cmd, { cwd: root, encoding: 'utf8', ...opts })

const bump = process.argv[2]

if (!bump) {
  die('usage: npm run release <patch|minor|major|x.y.z>')
}

// A bump on a dirty tree would fold unrelated changes into the release commit (or
// fail half-way, after the manifests are already rewritten). Untracked files are
// fine; tracked modifications are not.
const dirty = sh('git status --porcelain')
  .split('\n')
  .filter((l) => l && !l.startsWith('??'))

if (dirty.length) {
  die(`working tree has uncommitted changes — commit or stash first:\n${dirty.join('\n')}`)
}

const rootPkgPath = join(root, 'package.json')
const current = JSON.parse(readFileSync(rootPkgPath, 'utf8')).version

if (!/^\d+\.\d+\.\d+$/.test(current)) {
  die(`current version "${current}" is not a clean x.y.z`)
}

const next = (() => {
  if (/^\d+\.\d+\.\d+$/.test(bump)) {
    return bump
  }
  const [maj, min, pat] = current.split('.').map(Number)

  if (bump === 'major') {
    return `${maj + 1}.0.0`
  }
  if (bump === 'minor') {
    return `${maj}.${min + 1}.0`
  }
  if (bump === 'patch') {
    return `${maj}.${min}.${pat + 1}`
  }

  return die(`unknown bump "${bump}" (use patch|minor|major|x.y.z)`)
})()

// Don't strand a release commit without its tag.
const tagExists = (() => {
  try {
    sh(`git rev-parse -q --verify refs/tags/v${next}`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

if (tagExists) {
  die(`tag v${next} already exists`)
}

const manifests = [
  rootPkgPath,
  ...readdirSync(join(root, 'packages'))
    .map((d) => join(root, 'packages', d, 'package.json'))
    .filter(existsSync),
]

// Decide the Changelog fold BEFORE touching anything on disk. Every refusal
// below is a refusal to release at all, and discovering it after ten manifests are
// already rewritten strands the tree half-bumped — which the next run's own
// dirty-tree guard then blocks.
const changelogPath = join(root, 'CHANGELOG.md')
const today = new Date().toISOString().slice(0, 10)
const folded = foldUnreleased(readFileSync(changelogPath, 'utf8'), next, today)

if (!folded.changelog) {
  die(folded.reason)
}

for (const p of manifests) {
  const pkg = JSON.parse(readFileSync(p, 'utf8'))
  pkg.version = next
  writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n')
}
console.log(`bumped ${manifests.length} manifests: ${current} → ${next}`)

// The fold rides in the SAME commit as the bump: a Changelog edited afterwards would
// sit on a different commit than the tag, so the tag's release notes would describe a
// tree the tag does not contain.
writeFileSync(changelogPath, folded.changelog)
console.log(`folded CHANGELOG [Unreleased] → [${next}] — ${today}`)

// Sync the committed lockfile's recorded `version` (root + every workspace) to the
// new manifests, so a later `npm install` doesn't silently rewrite it and dirty the
// tree (which would also trip this script's own dirty-tree guard next time).
execSync('npm install --package-lock-only', { cwd: root, stdio: 'inherit' })
const committed = [...manifests, changelogPath, join(root, 'package-lock.json')]

const git = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' })
git(`git add ${committed.map((p) => JSON.stringify(p)).join(' ')}`)
git(`git commit -m ${JSON.stringify(`chore(release): v${next}`)}`)
git(`git tag -a v${next} -m ${JSON.stringify(`v${next}`)}`)
console.log(`\ntagged v${next}. push with:\n  git push && git push origin v${next}`)
