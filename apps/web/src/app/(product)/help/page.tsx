import { TrashPalaceApp } from '../../../components/trash-palace-app'
import { configuredPalaceId } from '../palace-page-props'

export default function HelpPage() {
  return <TrashPalaceApp initialView="learn" initialPalaceId={configuredPalaceId()} />
}
