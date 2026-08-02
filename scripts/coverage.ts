// Print the seed-catalog coverage matrix (#175): `make seed-coverage` / `npm run
// seed-coverage`. A dependency-light view over the registry + corpus — shows which
// cases drive each axis and how many fragments exercise each markdown feature.
import { renderCoverage } from '../test/cases/coverage'

process.stdout.write(renderCoverage())
