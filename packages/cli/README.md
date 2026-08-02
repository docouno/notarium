# notarium

Companion CLI for [Notarium](https://notarium.ai) — a self-hosted, AI-agent-native knowledge workspace with an Obsidian-style knowledge graph, on a Markdown-file-first engine.

**The workspace itself is not an npm package — it runs as a container:**

```bash
docker run -d --name notarium \
  -p 3000:3000 \
  -v notarium-data:/data \
  docouno/notarium:latest
```

Open http://localhost:3000 and create the owner account.

## This package

```bash
npx notarium          # how to run the workspace, and what this CLI can do
npx notarium version
```

Operating a running instance — `start`, `backup`, `restore`, `admin` — is the CLI shipped inside the image, not this one.

## Documentation

- Docs — https://notarium.ai/en/docs/
- Installation and self-hosting — https://notarium.ai/en/docs/self-hosting/install/
- Connecting an AI agent (MCP) — https://notarium.ai/en/docs/agents/connect/
