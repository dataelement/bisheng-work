import { isAbsolute } from 'node:path'
import { MarketInstallError } from './market-install.mjs'

/**
 * The verified artifact stays server-side until the Manager finishes using it.
 * @param {import('@deepseek-ai/dsh-plugin-manager').PluginManager} manager
 * @param {{ open(id: string): Promise<{ path: string, packageName: string, version: string, release(): Promise<unknown> | void }> }} packages
 * @param {string} id Enterprise catalog identity, never an npm spec or local path.
 */
export async function installEnterpriseWorkbench(manager, packages, id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{32}$/u.test(id)) throw new MarketInstallError('An enterprise workbench is required.')
  const opened = await packages.open(id)
  try {
    if (!opened || typeof opened.path !== 'string' || !isAbsolute(opened.path) ||
        typeof opened.packageName !== 'string' || !opened.packageName || typeof opened.version !== 'string' || !opened.version) {
      throw new MarketInstallError('The enterprise workbench package could not be prepared.')
    }
    const installed = (await manager.listBundles()).some(bundle => bundle.name === opened.packageName && bundle.installed)
    const result = await manager.installBundle(opened.path, {
      enabled: true, expectedName: opened.packageName, expectedVersion: opened.version, replace: installed
    })
    if (!result || !['applied', 'restart-required', 'overridden', 'failed', 'cancelled'].includes(result.application)) {
      throw new MarketInstallError('Plugin Manager returned no lifecycle outcome.', 502)
    }
    const failed = !['applied', 'restart-required'].includes(result.application)
    return {
      status: failed ? 409 : 200,
      body: {
        result, application: result.application,
        restartRequired: result.application === 'restart-required',
        ...(result.restartReason ? { restartReason: result.restartReason } : {}),
        ...(!failed && result.bundle === opened.packageName && result.stage === 'enable' ? {
          install: { id, pluginName: opened.packageName, version: opened.version, source: 'enterprise', installedAt: new Date().toISOString() }
        } : {}),
        ...(failed ? { error: result.error?.diagnostic || result.error?.message || result.error?.code || 'Plugin operation did not complete.' } : {})
      }
    }
  } finally { await opened?.release?.() }
}
