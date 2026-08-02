/**
 * Extract [[wikilink]] targets from a markdown body, in order of appearance.
 * `[[target|alias]]` yields the target; a `#fragment` is dropped (links resolve
 * to whole notes); duplicates are kept — edge dedup is the graph's concern.
 */
export const parseWikilinks = (content: string): string[] => {
  const targets: string[] = []
  const re = /\[\[([^\]]+)\]\]/g

  for (let m = re.exec(content || ''); m !== null; m = re.exec(content || '')) {
    const target = m[1].split('|')[0].split('#')[0].trim()

    if (target) {
      targets.push(target)
    }
  }

  return targets
}
