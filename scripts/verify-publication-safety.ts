import { resolve } from 'node:path'

import { verifyPublicationSafety } from './publication-safety.js'

const repositoryRoot = resolve(process.cwd())
const findings = verifyPublicationSafety(repositoryRoot)

if (findings.length > 0) {
  console.error('Public-artifact safety verification failed:')
  for (const finding of findings) console.error(`- ${finding.path}: ${finding.reason}`)
  process.exitCode = 1
} else {
  console.log('Public-artifact safety verification passed.')
}
