import { notFound } from 'next/navigation'

import { TrashPalaceApp } from '../../../../components/trash-palace-app'
import { configuredPalaceId } from '../../palace-page-props'

export default async function HelpEntryPage({ params }: { params: Promise<{ entry: string }> }) {
  const { entry } = await params
  if (entry.length === 0) notFound()

  return (
    <TrashPalaceApp
      initialView="learn"
      initialHelpEntry={entry}
      initialPalaceId={configuredPalaceId()}
    />
  )
}
