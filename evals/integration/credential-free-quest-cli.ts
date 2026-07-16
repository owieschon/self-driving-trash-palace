import { runCredentialFreeQuest } from './credential-free-quest.js'

void runCredentialFreeQuest()
  .then((receipt) => {
    process.stdout.write(
      `Credential-free Quest passed: ${receipt.lifecycle.terminalState}; application response loss and ${receipt.ledger.gatewayAttemptCount} gateway attempt(s) reconciled; ${receipt.evidence.eventCount} current-mission evidence events validated.\n`,
    )
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Credential-free Quest failed'}\n`,
    )
    process.exitCode = 1
  })
