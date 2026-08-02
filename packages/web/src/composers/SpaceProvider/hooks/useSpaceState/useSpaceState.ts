import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import type { PatchSpaceRequest, Space } from '@notarium/contract'
import { SPACE_ROLE } from '@notarium/contract/enums'
import { canWriteSpace, fallbackSpace } from '../../../../libs/access'
import { parseAppPath, spaceRoute } from '../../../../libs/routing/routePaths'
import { api } from '../../../../services/api'
import { useAuth } from '../../../AuthProvider'
import { remember, remembered } from '../../helpers/activeSpaceStorage'
import type { SpaceContextValue } from '../../types'

export const useSpaceState = (): SpaceContextValue | null => {
  const location = useLocation()
  const navigate = useNavigate()
  // The personal domain (#13) is a real, manageable workspace the user owns — it
  // CAN hold projects and its own Management/Projects surface is reachable. It is
  // filtered out of the workspace LIST (`spaces`) only so it doesn't read as just
  // another shared workspace (and so management never offers invites on it), and
  // exposed separately (`personalSpace`) so the switcher offers an explicit, named
  // destination: opening an about-you memory note makes it the active space, and
  // without a way back the user lands somewhere unlabelled.
  const { me, mode, addLocalGrant } = useAuth()
  const personalSlug = me?.personalSpace ?? null

  // Boot order matters: the providers below (SSE, tree) need a space to talk
  // about, so children render only once the host's space facts arrived. One
  // fast host-level call; a failure falls back to the URL/remembered slug so
  // the app still comes up and the usual error surfaces (tree banner) speak.
  const [ready, setReady] = useState(false)
  const [spaces, setSpaces] = useState<Space[]>([])
  const [archivedSpaces, setArchivedSpaces] = useState<Space[]>([])
  const [capabilities, setCapabilities] = useState({ spaceCreate: false })
  const [active, setActive] = useState<string>(() => {
    // Pre-fetch guess only (children render after `ready`, once the real list
    // arrives): URL → last-active → the user's personal space. No host-global
    // 'main' fallback anymore (#99). '' is a harmless placeholder until the fetch
    // resolves the landing.
    const fromUrl = parseAppPath(window.location.pathname)
    return ('space' in fromUrl && fromUrl.space) || remembered() || personalSlug || ''
  })
  const activeRef = useRef(active)
  activeRef.current = active
  const spacesRef = useRef(spaces)
  spacesRef.current = spaces
  // Mirror the personal slug into a ref so the boot-once effect lands on it
  // without taking it as a dependency (it is stable for the provider's lifetime
  // — SpaceProvider mounts only after `me` is set, AuthGate).
  const personalSlugRef = useRef(personalSlug)
  personalSlugRef.current = personalSlug
  // Mirror `me` so the archive-redirect (fallbackSpace) reads the latest grants
  // without taking `me` as a callback dependency.
  const meRef = useRef(me)
  meRef.current = me

  useEffect(() => {
    void (async () => {
      try {
        // Deleted spaces (#110) ride the same boot fetch — usually empty, and a host
        // without a registry answers []; a failure degrades to [] (the Trash → Spaces
        // tab just shows empty). Membership-filtered to what the caller can manage.
        const [config, list, archived] = await Promise.all([
          api.configGet(),
          api.spacesGet(),
          api.archivedSpaces().catch(() => [] as Space[]),
        ])
        setSpaces(list)
        setArchivedSpaces(archived)
        setCapabilities(config.capabilities)
        // The boot guess (URL/localStorage) must exist on THIS host — and,
        // since #10, in THIS principal's grants (the wire already filters).
        // A stale guess lands the principal in their personal space (#99: that
        // is the home — there is no host-global default), else the first granted
        // space. An empty list keeps the guess as a harmless placeholder: ready
        // flips anyway and the Sidebar shows its honest "no spaces" state.
        const personal = personalSlugRef.current
        setActive((cur) => {
          if (cur && list.some((s) => s.slug === cur)) {
            return cur
          }
          if (personal && list.some((s) => s.slug === personal)) {
            return personal
          }

          return list[0]?.slug ?? cur
        })
      } catch {
        setSpaces([
          { id: activeRef.current, slug: activeRef.current, displayName: activeRef.current },
        ])
      } finally {
        setReady(true)
      }
    })()
  }, [])

  // The URL names a space → it IS the active one (deep links, back/forward).
  // Canonicalise an old slug (#100 phase 4): if the URL names a space by a PAST slug
  // (its alias), redirect to its current slug so a bookmarked `/s/<old>/…` lands
  // on the live handle. The server still resolves the alias, so this is cosmetic
  // URL hygiene, not a correctness gate.
  useEffect(() => {
    const parsed = parseAppPath(location.pathname)

    if (!('space' in parsed) || !parsed.space) {
      return
    }
    const urlSlug = parsed.space
    const canonical =
      spaces.find((s) => s.slug === urlSlug)?.slug ??
      spaces.find((s) => s.aliases?.includes(urlSlug))?.slug

    if (canonical && canonical !== urlSlug) {
      navigate(location.pathname.replace(`/s/${urlSlug}`, `/s/${canonical}`) + location.search, {
        replace: true,
      })
      return
    }
    if (urlSlug !== activeRef.current) {
      setActive(urlSlug)
      remember(urlSlug)
    }
  }, [location.pathname, location.search, spaces, navigate])

  const switchSpace = useCallback(
    (slug: string) => {
      remember(slug)
      navigate(spaceRoute(slug))
    },
    [navigate],
  )

  const createSpace = useCallback(
    async (displayName: string) => {
      // Name in, server derives the handle (#123) — so a name in any language works and
      // the client never has to think in slugs.
      const created = await api.spaceCreate(displayName)
      setSpaces((prev) => [...prev, created])
      // The creator owns what they minted (the server grants owner unconditionally), but
      // the grant lives in `me.spaces`, loaded once at boot. Reflect it locally so
      // canWriteSpace lights up the write affordance the instant we land in the space
      // (#154) — no read-only flash. Deliberately NOT a refresh(): a transient session-GET
      // failure mid-create must not flip the app to the phantom mode-'none' principal. The
      // server's `access` nudge reconciles the canonical list and the creator's OTHER tabs
      // (#155); switchSpace re-anchors the SSE stream to the new space.
      addLocalGrant(created.slug, SPACE_ROLE.owner)
      switchSpace(created.slug)
    },
    [switchSpace, addLocalGrant],
  )

  const reportNoteSpace = useCallback((slug: string) => {
    if (slug === activeRef.current) {
      return
    }
    setActive(slug)
    remember(slug)
  }, [])

  const renameSpace = useCallback(async (patch: PatchSpaceRequest) => {
    const updated = await api.patchSpace(activeRef.current, patch)
    // Swap the fresh row in (new slug + the old slug retired into aliases) and flip the
    // active slug in LOCKSTEP. The flip matters: setSpaces alone would leave `active` on
    // the old slug for a render — a slug now absent from the current list — and the
    // management tabs' `spaces.find(slug === active)` guards would briefly see no active
    // space and cascade-redirect to the space home, dropping the tab. With active and
    // the list moving together, the URL-canonicalisation effect (deps: spaces) just
    // rewrites this tab's `/s/<old>/…` path to the new slug, preserving the tab.
    setSpaces((prev) => prev.map((s) => (s.id === updated.id ? updated : s)))
    if (updated.slug !== activeRef.current) {
      remember(updated.slug)
      setActive(updated.slug)
    }

    return updated
  }, [])

  const reloadSpaces = useCallback(() => {
    void api
      .spacesGet()
      .then((list) => {
        setSpaces(list)
        // Rename-follow (#123): if the active slug is no longer a CURRENT slug but is
        // a past alias of a still-held space, it was renamed — adopt the new slug. The
        // URL effect handles space-scoped routes; this covers space-free surfaces
        // (/n/<id>, /) where the URL carries no slug to canonicalise. A genuinely lost
        // space (revoke/#110) is not an alias of anything, so it's left for the access
        // detector to turn into a takeover.
        const cur = activeRef.current

        if (cur && !list.some((s) => s.slug === cur)) {
          const renamed = list.find((s) => s.aliases?.includes(cur))

          if (renamed) {
            remember(renamed.slug)
            setActive(renamed.slug)
          }
        }
      })
      .catch(() => {
        // A failed refresh just leaves the last-known list — the access detector
        // is the authority on whether the active space is still reachable.
      })
  }, [])

  // Re-fetch the principal's archived spaces (#110) — kept fresh on every
  // archive/restore/purge so the switcher's "Archived" surface tracks reality.
  const reloadArchived = useCallback(() => {
    void api
      .archivedSpaces()
      .then(setArchivedSpaces)
      .catch(() => {})
  }, [])

  const archiveSpace = useCallback(
    async (slug: string) => {
      await api.archiveSpace(slug)
      const wasActive = slug === activeRef.current
      // The space leaves the served list and joins the archived list (both move).
      reloadSpaces()
      reloadArchived()
      // If we deleted the space we're standing in, leave for a readable fallback
      // (personal / first other). It's now in the Trash (Spaces tab) — the caller
      // toasts where it went, so we don't dump the user into the Trash unprompted.
      // fallbackSpace excludes the just-deleted slug even if `me` is briefly stale (it
      // refreshes via the #111 access flow afterwards). In auth mode `none` there is no
      // `me`, so use the local served-space list; otherwise `/` would redirect back to
      // the just-archived active slug.
      if (wasActive) {
        const target = meRef.current
          ? fallbackSpace(meRef.current, slug)
          : (spacesRef.current.find((s) => s.slug !== slug)?.slug ?? null)

        if (target) {
          switchSpace(target)
        } else {
          navigate('/')
        }
      }
    },
    [navigate, switchSpace, reloadSpaces, reloadArchived],
  )

  const restoreSpace = useCallback(
    async (id: string) => {
      await api.restoreSpace(id)
      reloadSpaces()
      reloadArchived()
    },
    [reloadSpaces, reloadArchived],
  )

  const purgeSpace = useCallback(
    async (id: string, confirm: string) => {
      await api.purgeSpace(id, confirm)
      reloadArchived()
    },
    [reloadArchived],
  )

  const visibleSpaces = useMemo(
    () => spaces.filter((s) => s.slug !== personalSlug),
    [spaces, personalSlug],
  )

  // Resolve the personal domain to a switchable Space with a fixed, friendly
  // "Personal" name (the wire displayName may be the user's own name — here it's
  // the domain, not the person). A personal slug exists whenever the host has a
  // signed-in user, so the destination is always offered.
  const personalSpace = useMemo<Space | null>(
    () =>
      personalSlug
        ? {
            id: spaces.find((s) => s.slug === personalSlug)?.id ?? personalSlug,
            slug: personalSlug,
            displayName: 'Personal',
          }
        : null,
    [personalSlug, spaces],
  )

  // The write capability for the ACTIVE space — mirrors the server's
  // can(space:write). Every mutation affordance in the chrome gates on it.
  const canWrite = useMemo(() => canWriteSpace(me, mode, active), [me, mode, active])

  const value = useMemo<SpaceContextValue>(
    () => ({
      space: active,
      spaces: visibleSpaces,
      personalSpace,
      capabilities,
      canWrite,
      switchSpace,
      createSpace,
      renameSpace,
      reportNoteSpace,
      reloadSpaces,
      archivedSpaces,
      reloadArchived,
      archiveSpace,
      restoreSpace,
      purgeSpace,
    }),
    [
      active,
      visibleSpaces,
      personalSpace,
      capabilities,
      canWrite,
      switchSpace,
      createSpace,
      renameSpace,
      reportNoteSpace,
      reloadSpaces,
      archivedSpaces,
      reloadArchived,
      archiveSpace,
      restoreSpace,
      purgeSpace,
    ],
  )

  if (!ready) {
    return null
  }

  return value
}
