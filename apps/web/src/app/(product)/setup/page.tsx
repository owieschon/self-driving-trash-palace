import { TrashPalaceApp } from '../../../components/trash-palace-app'
import { configuredPalaceId } from '../palace-page-props'

export default function SetupPage() {
  return <TrashPalaceApp initialView="household" initialPalaceId={configuredPalaceId()} />
}
