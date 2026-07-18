import { TrashPalaceApp } from '../../../components/trash-palace-app'
import { configuredPalaceId } from '../palace-page-props'

export default function AutomationsPage() {
  return <TrashPalaceApp initialView="automations" initialPalaceId={configuredPalaceId()} />
}
