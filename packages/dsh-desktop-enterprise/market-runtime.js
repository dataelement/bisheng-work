import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { bundlePatchPaths, loadOverlayPatches, resolvePluginResource } from '@deepseek-ai/dsh-app-boot'
import { randomUUID } from 'node:crypto'
import { bindEnterpriseAuth, inheritEnterpriseAuth } from './enterprise-auth.js'

function contained(root, path) {
  const nested = relative(root, path)
  if (isAbsolute(nested) || nested.startsWith('..')) throw new Error('Plugin entry leaves its package.')
}

/** Authorization adapter only: Harness owns ESM resolution and root composition. */
export function createMarketRuntime(ctx, auth, onRequestSettled) {
  return async record => {
    const layers = ctx.get('profileRuntimeLayers')
    if (!layers) throw new Error('Enterprise plugins require the Harness root composition service.')
    const root = join(record.directory, 'node_modules', record.name)
    const parent = pathToFileURL(join(root, 'package.json')).href
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    const id = randomUUID()
    const patches = pkg.dsh?.bundle
      ? bundlePatchPaths(root, pkg.dsh.bundle).flatMap(path => {
        contained(root, path)
        return loadOverlayPatches('enterprise-market', path)
      })
      : [{ insert: [{ id: `enterprise-${record.plugin_id ?? record.name}`, name: record.name, config: record.config ?? {} }] }]
    const owned = new Map()
    const originalNames = new Map()
    const existing = new Set([...ctx.loader.entries()].map(entry => entry.options.id))
    const anchor = (rows, inserted = false) => {
      for (const row of rows) {
        const originalName = row.name
        if (inserted && row.name && !row.name.startsWith('cordis:')) {
          // The same Node import resolver used by Harness metadata/client discovery.
          row.name = pathToFileURL(resolvePluginResource(row.name, parent)).href
        }
        if (inserted) {
          ctx.loader.ensureId(row)
          if (existing.has(row.id) || owned.has(row.id)) throw new Error(`Enterprise bundle requires a unique entry id: ${row.id}`)
          owned.set(row.id, row.name)
          originalNames.set(row.id, originalName)
        }
        // A patch name is a matching assertion, not a replacement. Keep
        // assertions on this layer's inserted entries aligned with their URL.
        if (!inserted && row.name && originalNames.get(row.id) === row.name) row.name = owned.get(row.id)
        if (row.insert) anchor(row.insert, true)
        if (row.group && Array.isArray(row.config)) anchor(row.config, inserted)
      }
    }
    anchor(patches)
    let transport, unbind, detach, removed
    const remove = () => removed ??= (async () => {
      unbind?.()
      detach?.()
      const errors = []
      try { if (transport) await auth.revoke(transport) } catch (error) { errors.push(error) }
      try {
        // Stop our own fibers even when the owner is being removed by a root
        // transaction; waiting on another root transaction would deadlock it.
        for (const entry of [...ctx.loader.entries()]) {
          if (owned.has(entry.options.id) && owned.get(entry.options.id) === entry.options.name) {
            try { await entry.fiber?.dispose() } catch (error) { errors.push(error) }
          }
        }
      } catch (error) { errors.push(error) }
      try { await layers.remove(id, ctx.fiber.uid === null) } catch (error) { errors.push(error) }
      if (errors.length) throw new AggregateError(errors, 'Enterprise plugin cleanup failed.')
    })()
    try {
      if (auth) {
        if (typeof record.plugin_id !== 'string' || !record.plugin_id) throw new Error('Enterprise plugin identity is required.')
        transport = await auth.grant({ pluginId: record.plugin_id, instanceId: id })
        const scope = ctx.extend({})
        unbind = await bindEnterpriseAuth(scope, transport, error => onRequestSettled?.(record, error))
        // Cordis emits this synchronously before apply. Bind the new fiber itself,
        // leaving reused entries and unrelated root plugins without credentials.
        detach = ctx.on('internal/plugin', fiber => {
          const entry = fiber.ctx.fiber.entry
          if (fiber.uid != null && entry && owned.has(entry.options.id) && owned.get(entry.options.id) === entry.options.name) {
            inheritEnterpriseAuth(fiber.ctx, scope)
          }
        }, { global: true })
      }
      const required = [...owned.keys()].filter(key => {
        const find = rows => rows.some(row => !row.disabled && (row.id === key || find(row.insert ?? []) || (row.group && Array.isArray(row.config) && find(row.config))))
        return find(patches)
      })
      const active = () => {
        const entries = [...ctx.loader.entries()]
        return required.every(key => entries.some(entry => entry.options.id === key && (entry.options.disabled || entry.fiber?.state === 2)))
      }
      await layers.set(id, patches, required)
      if (!active()) throw new Error('Enterprise bundle entries did not activate in the root composition.')
      return { dispose: remove, get state() { return active() ? 2 : 0 } }
    } catch (error) {
      try { await remove() } catch (cleanup) { throw new AggregateError([error, cleanup], error.message, { cause: error }) }
      throw error
    }
  }
}
