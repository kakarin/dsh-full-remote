import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COCKPIT_STORAGE_KEY,
  createCockpitPreference,
  type CockpitPreferenceController,
} from '../src/client/cockpit-preference.ts'
import { InteractionOverlay } from '../src/client/InteractionOverlay.tsx'
import { RemoteSection } from '../src/client/RemoteSection.tsx'
import { shouldUseInteractionOverlay } from '../src/client/pending-source.ts'
import { translatorFor, zh, type ReverseProxyTranslate } from '../src/client/i18n.ts'
import type { ProxyApi, ProxyStatus } from '../src/client/types.ts'

const t = translatorFor(zh) as ReverseProxyTranslate

afterEach(() => { cleanup() })

const stopped: ProxyStatus = {
  enabled: false,
  running: false,
  target: 'http://127.0.0.1:3081',
  backend: 'http://127.0.0.1:3080',
  listen: { host: '127.0.0.1', port: 3081 },
}

function api(overrides: Partial<ProxyApi> = {}): ProxyApi {
  return {
    status: vi.fn().mockResolvedValue(stopped),
    start: vi.fn().mockResolvedValue({ ...stopped, enabled: true, running: true }),
    stop: vi.fn().mockResolvedValue(stopped),
    token: vi.fn().mockResolvedValue('secret-token'),
    rotateToken: vi.fn().mockResolvedValue({ ...stopped, accessToken: 'next-token' }),
    setToken: vi.fn().mockResolvedValue({ ok: true, accessToken: 'custom-token', unchanged: false }),
    setListen: vi.fn().mockResolvedValue(stopped),
    sessions: vi.fn().mockResolvedValue([]),
    approveSession: vi.fn().mockResolvedValue({ ok: true }),
    revokeSession: vi.fn().mockResolvedValue({ ok: true }),
    renameSession: vi.fn().mockResolvedValue({ ok: true }),
    selfCheck: vi.fn().mockResolvedValue({
      running: false,
      fence: { ok: true, method: 'settings.describe', status: 200, rewriteAuthority: '127.0.0.1:3080' },
      tls: false,
      auditLog: true,
      allowTokenRead: true,
      trustBootstrap: true,
      bootstrapFailed: false,
    }),
    invite: vi.fn().mockResolvedValue({ url: 'http://example.test', token: 'secret-token' }),
    audit: vi.fn().mockResolvedValue({ events: [], total: 0 }),
    startTunnel: vi.fn().mockResolvedValue({ ok: true }),
    stopTunnel: vi.fn().mockResolvedValue({ ok: true }),
    exportAudit: vi.fn().mockResolvedValue(new Blob()),
    ...overrides,
  } as unknown as ProxyApi
}

/** Minimal stand-in for the injected overlay face; only the pieces under test. */
const overlayProps = (cockpit: CockpitPreferenceController | undefined, enabled = true) => ({
  t,
  connection: undefined,
  cockpit,
  canOpenSession: true,
  openSession: () => {},
  answerApproval: async () => {},
  answerQuestion: async () => {},
  cancelQuestion: async () => {},
  useRemotePending: (selector: (snapshot: { items: never[], sessions: never[] }) => unknown) =>
    selector({ items: [], sessions: [] }),
  enabled,
}) as unknown as Parameters<typeof InteractionOverlay>[0]

/**
 * The real slot contracts extend GlobalStandardProps with session/workspace
 * hooks this card never reads; the single cast keeps every render typed.
 */
function sectionProps(
  cockpit?: CockpitPreferenceController,
): Parameters<typeof RemoteSection>[0] {
  return {
    api: api(),
    t,
    close: () => {},
    cockpit,
    useSessions: () => () => {},
    useWorkspaces: () => () => {},
  } as unknown as Parameters<typeof RemoteSection>[0]
}

beforeEach(() => {
  try { localStorage.clear() } catch { /* storage may be blocked */ }
})

describe('cockpit preference storage', () => {
  it('defaults to auto and round-trips the off state', () => {
    const controller = createCockpitPreference()
    expect(controller.getPreference()).toBe('auto')

    controller.setPreference('off')
    expect(controller.getPreference()).toBe('off')
    expect(localStorage.getItem(COCKPIT_STORAGE_KEY)).toBe('off')

    controller.setPreference('auto')
    expect(controller.getPreference()).toBe('auto')
    expect(localStorage.getItem(COCKPIT_STORAGE_KEY)).toBeNull()
    controller.dispose()
  })

  it('notifies subscribers on every change and stops after unsubscribe', () => {
    const controller = createCockpitPreference()
    const listener = vi.fn()
    const off = controller.subscribe(listener)

    controller.setPreference('off')
    expect(listener).toHaveBeenCalledTimes(1)
    controller.setPreference('auto')
    expect(listener).toHaveBeenCalledTimes(2)

    off()
    controller.setPreference('off')
    expect(listener).toHaveBeenCalledTimes(2)
    controller.dispose()
  })

  it('reads the stored value on construction', () => {
    localStorage.setItem(COCKPIT_STORAGE_KEY, 'off')
    const controller = createCockpitPreference()
    expect(controller.getPreference()).toBe('off')
    controller.dispose()
  })

  it('never shows the overlay once the browser opted out', () => {
    const controller = createCockpitPreference()
    const mounted = () => document.querySelector('[data-remote-cockpit]')
    render(<InteractionOverlay {...overlayProps(controller)} />)
    expect(mounted()).not.toBeNull()

    act(() => { controller.setPreference('off') })
    expect(mounted()).toBeNull()

    act(() => { controller.setPreference('auto') })
    expect(mounted()).not.toBeNull()
    controller.dispose()
  })

  it('keeps the automatic hostname/viewport rule intact', () => {
    expect(shouldUseInteractionOverlay('192.168.1.9', 1400)).toBe(true)
    expect(shouldUseInteractionOverlay('127.0.0.1', 640)).toBe(true)
    expect(shouldUseInteractionOverlay('127.0.0.1', 1400)).toBe(false)
  })

  it('hides from inside the cockpit without losing the settings entry', () => {
    const controller = createCockpitPreference()
    render(<InteractionOverlay {...overlayProps(controller)} />)
    fireEvent.click(screen.getByLabelText(zh['cockpit.launch'].replace('{count}', '0')))
    fireEvent.click(screen.getByText(zh['cockpit.hide']))
    expect(controller.getPreference()).toBe('off')
    expect(document.querySelector('[data-remote-cockpit]')).toBeNull()

    // The settings card is the way back and must still render once hidden.
    render(<RemoteSection {...sectionProps(controller)} />)
    fireEvent.click(screen.getByText(zh['console.show']))
    expect(controller.getPreference()).toBe('auto')
    controller.dispose()
  })
})

describe('task console settings card', () => {
  it('reflects and toggles the preference', () => {
    const controller = createCockpitPreference()
    render(<RemoteSection {...sectionProps(controller)} />)

    expect(screen.getByText(zh['console.state.auto'])).toBeTruthy()
    fireEvent.click(screen.getByText(zh['console.hideHere']))
    expect(controller.getPreference()).toBe('off')
    expect(screen.getByText(zh['console.state.off'])).toBeTruthy()

    fireEvent.click(screen.getByText(zh['console.show']))
    expect(controller.getPreference()).toBe('auto')
    controller.dispose()
  })

  it('omits the card when the plugin did not inject a controller', () => {
    render(<RemoteSection {...sectionProps()} />)
    expect(screen.queryByText(zh['console.label'])).toBeNull()
  })
})
