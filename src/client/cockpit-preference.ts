/**
 * cockpit-preference — whether this browser shows the Task cockpit.
 *
 * The cockpit (a floating "任务控制台" launcher) appears automatically when the
 * page is opened from a non-loopback host or in a phone-narrow viewport, because
 * that is where Harness's own approval sheets are easy to miss. Some owners run
 * a desktop browser at a narrow width and do not want the extra launcher there;
 * this preference lets them turn it off per browser without touching the host.
 *
 * Deliberately a *client* preference, not a host config field: it describes one
 * browser's viewport habits, not the proxy's behaviour. It survives reloads via
 * localStorage, and the same tab picks it up immediately through the listener
 * set — `storage` events alone would never fire for the writing tab.
 */
import { useSyncExternalStore } from 'react'

export type CockpitPreference = 'auto' | 'off'

export const COCKPIT_STORAGE_KEY = 'dsh-full-remote.cockpit'

function preferenceOf(value: string | null): CockpitPreference {
  return value === 'off' ? 'off' : 'auto'
}

export type CockpitPreferenceController = {
  getPreference: () => CockpitPreference
  subscribe: (listener: () => void) => () => void
  setPreference: (value: CockpitPreference) => void
  dispose: () => void
}

/** A no-op controller for tests and for a component used without the plugin. */
export const NO_COCKPIT_CONTROLLER: CockpitPreferenceController = {
  getPreference: () => 'auto',
  subscribe: () => () => {},
  setPreference: () => {},
  dispose: () => {},
}

export function createCockpitPreference(): CockpitPreferenceController {
  let current: CockpitPreference = 'auto'
  try {
    current = preferenceOf(globalThis.localStorage?.getItem(COCKPIT_STORAGE_KEY) ?? null)
  } catch {
    // A blocked storage must never prevent the settings page from rendering.
  }
  const listeners = new Set<() => void>()
  const notify = () => {
    // Copy first: a listener may unsubscribe while the set is being walked.
    for (const listener of [...listeners]) listener()
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key !== COCKPIT_STORAGE_KEY && event.key !== null) return
    current = preferenceOf(event.newValue)
    notify()
  }
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage)
  return {
    getPreference: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    setPreference(value) {
      current = value
      try {
        if (value === 'auto') globalThis.localStorage?.removeItem(COCKPIT_STORAGE_KEY)
        else globalThis.localStorage?.setItem(COCKPIT_STORAGE_KEY, value)
      } catch {
        // Keep the in-memory choice; it still applies for this page's lifetime.
      }
      notify()
    },
    dispose() {
      if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
    },
  }
}

/** Subscribe a component to the preference; `getPreference` is a stable snapshot. */
export function useCockpitPreference(controller: CockpitPreferenceController): CockpitPreference {
  return useSyncExternalStore(controller.subscribe, controller.getPreference, controller.getPreference)
}
