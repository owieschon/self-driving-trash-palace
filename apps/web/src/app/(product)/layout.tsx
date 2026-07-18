import type { Metadata } from 'next'
import { Geist_Mono, Inter } from 'next/font/google'
import '../../styles/relay.css'
import '../../styles/product.css'
import '../../styles/overrides.css'
import '../../styles/help-center.css'

// Palace selection is request-time configuration. A shared preview must not bake its absence into
// the build and silently fall back to inspect-only sample mode.
export const dynamic = 'force-dynamic'

const sans = Inter({ variable: '--font-relay-sans', subsets: ['latin'] })
const mono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'TrashPal',
  description: 'Trusted automations for connected raccoon homes.',
}

export default function ProductLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${sans.variable} ${mono.variable}`}>{children}</body>
    </html>
  )
}
