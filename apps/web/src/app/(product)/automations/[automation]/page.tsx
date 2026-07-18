import { notFound } from 'next/navigation'

import { TrashPalaceApp } from '../../../../components/trash-palace-app'
import { configuredPalaceId } from '../../palace-page-props'

const supportedAutomations = ['night_shift_homecoming', 'scheduled_hauler_access'] as const

export default async function AutomationDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ automation: string }>
  searchParams: Promise<{ mission?: string | string[] }>
}) {
  const { automation } = await params
  const { mission } = await searchParams
  if (!supportedAutomations.includes(automation as (typeof supportedAutomations)[number]))
    notFound()
  return (
    <TrashPalaceApp
      initialView="automations"
      initialAutomation={automation as (typeof supportedAutomations)[number]}
      initialPalaceId={configuredPalaceId()}
      initialMissionId={typeof mission === 'string' ? mission : null}
    />
  )
}
