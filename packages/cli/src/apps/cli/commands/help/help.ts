const IMAGE = 'docouno/notarium:latest'
const DOCS_URL = 'https://notarium.ai/en/docs/'
const INSTALL_URL = 'https://notarium.ai/en/docs/self-hosting/install/'
const AGENTS_URL = 'https://notarium.ai/en/docs/agents/connect/'

// `:latest` rather than this CLI's own version: the CLI is published far less often
// than the image, so a pinned tag here would go stale and hand out an old workspace.
export const helpText = `Notarium — a self-hosted, AI-agent-native knowledge workspace.

The workspace runs as a container; this package is its companion CLI, not the server:

  docker run -d --name notarium -p 3000:3000 -v notarium-data:/data ${IMAGE}

Open http://localhost:3000 and create the owner account.

Usage
  npx notarium <command>

Commands
  help       Show this help
  version    Print this CLI's version

Docs       ${DOCS_URL}
Install    ${INSTALL_URL}
Agents     ${AGENTS_URL}

Operating a running instance — start, backup, restore, admin — is the CLI shipped
inside the image, not this one.
`

export const runHelp = () => {
  process.stdout.write(helpText)
}
