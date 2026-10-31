/**
 * DSH Desktop listens on 43127–43130 (mobile bridge, then Harness, each with a
 * development port one higher). BISHENG keeps its own stable ports so
 * both desktops can run at the same time.
 */
const BISHENG_MOBILE_PORT = 43227
const BISHENG_HARNESS_PORT = 43229

/** An isolated development profile may select a separate pair of service ports. */
function developmentOffset(developmentBuild: boolean): number {
  if (!developmentBuild) return 0
  const raw = process.env.BISHENG_DEV_PORT_OFFSET
  if (!raw) return 1
  const offset = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(offset) || offset < 1 || offset > 65535 - BISHENG_HARNESS_PORT) {
    throw new Error('BISHENG_DEV_PORT_OFFSET must keep both development ports between 1 and 65535.')
  }
  return offset
}

export function mobileBridgePort(developmentBuild: boolean): number {
  return BISHENG_MOBILE_PORT + developmentOffset(developmentBuild)
}

export function harnessPreferredPort(developmentBuild: boolean): number {
  return BISHENG_HARNESS_PORT + developmentOffset(developmentBuild)
}
