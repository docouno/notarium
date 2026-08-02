import { useNavigate } from 'react-router'
import { useSpace } from '../../composers/SpaceProvider'
import { Button } from '../../core/Button'
import { IconSearch } from '../../core/Icons'
import { StateView } from '../../core/StateView'
import { feedRoute, spaceRoute } from '../../libs/routing/routePaths'

// The catch-all route (#65): a URL that matches no known shape. Replaces the old
// silent redirect-to-home — a mistyped or dead link now says so honestly, with a
// way back into the active space, instead of bouncing the user somewhere they
// didn't ask for. Known live scopes (/feed, /graph, /files) still redirect;
// only genuinely-unknown URLs land here.
export const NotFoundPage = () => {
  const { space } = useSpace()
  const navigate = useNavigate()
  return (
    <StateView
      tone="muted"
      code="404"
      icon={<IconSearch size={30} />}
      title="I looked everywhere"
      description="This URL doesn’t lead anywhere in your workspace — it may be mistyped, or point to something that was moved or removed. Let’s get you back on track."
      testId="page-not-found"
      actions={
        <>
          <Button variant="primary" onClick={() => navigate(spaceRoute(space))}>
            Go home
          </Button>
          <Button variant="ghost" onClick={() => navigate(feedRoute(space))}>
            Open feed
          </Button>
        </>
      }
    />
  )
}
