import { TrashPalaceApp } from '../../components/trash-palace-app'
import { configuredPalaceId } from './palace-page-props'

export default function Home() {
  return <TrashPalaceApp initialView="home" initialPalaceId={configuredPalaceId()} />
}
