import { TrashPalaceApp } from '../../../components/trash-palace-app'
import { configuredPalaceId } from '../palace-page-props'

export default function ActivityPage() {
  return <TrashPalaceApp initialView="activity" initialPalaceId={configuredPalaceId()} />
}
