import path from 'path'
import { ViteDevServer } from '..'
import { createDebugger, normalizePath } from '../utils'
import { ModuleNode } from './moduleGraph'
import chalk from 'chalk'
import slash from 'slash'
import { Update } from 'types/hmrPayload'
import { CLIENT_DIR } from '../constants'
import { RollupError } from 'rollup'

export const debugHmr = createDebugger('vite:hmr')

export interface HmrOptions {
  protocol?: string
  host?: string
  port?: number
  path?: string
  timeout?: number
  overlay?: boolean
}

export async function handleHMRUpdate(
  file: string,
  server: ViteDevServer
): Promise<any> {
  const { ws, config, moduleGraph } = server

  if (file === config.configPath) {
    // TODO auto restart server
    debugHmr(`[config change] ${chalk.dim(file)}`)
    return
  }

  if (file.endsWith('.env')) {
    // TODO notification for manual server restart
    debugHmr(`[.env change] ${chalk.dim(file)}`)
    return
  }

  debugHmr(`[file change] ${chalk.dim(file)}`)

  // html files and the client itself cannot be hot updated.
  if (file.endsWith('.html') || file.startsWith(CLIENT_DIR)) {
    ws.send({
      type: 'full-reload',
      path: '/' + slash(path.relative(config.root, file))
    })
    return
  }

  let mods = moduleGraph.getModulesByFile(file)
  if (!mods) {
    // loaded but not in the module graph, probably not js
    debugHmr(`[no module entry] ${chalk.dim(file)}`)
    return
  }

  // check if any plugin wants to perform custom HMR handling
  let filteredMods = [...mods]
  for (const plugin of config.plugins) {
    if (plugin.handleHotUpdate) {
      filteredMods =
        (await plugin.handleHotUpdate(file, filteredMods, server)) ||
        filteredMods
    }
  }

  const timestamp = Date.now()
  const updates: Update[] = []

  for (const mod of filteredMods) {
    const boundaries = new Set<{
      boundary: ModuleNode
      acceptedVia: ModuleNode
    }>()
    const hasDeadEnd = propagateUpdate(mod, timestamp, boundaries)
    if (hasDeadEnd) {
      debugHmr(`[full reload] ${chalk.dim(file)}`)
      ws.send({
        type: 'full-reload'
      })
      return
    }

    updates.push(
      ...[...boundaries].map(({ boundary, acceptedVia }) => {
        const type = `${boundary.type}-update` as Update['type']
        debugHmr(`[${type}] ${chalk.dim(boundary.url)}`)
        return {
          type,
          timestamp,
          path: boundary.url,
          accpetedPath: acceptedVia.url
        }
      })
    )
  }

  ws.send({
    type: 'update',
    updates
  })
}

function propagateUpdate(
  node: ModuleNode,
  timestamp: number,
  boundaries: Set<{
    boundary: ModuleNode
    acceptedVia: ModuleNode
  }>,
  currentChain: ModuleNode[] = [node]
): boolean /* hasDeadEnd */ {
  if (node.isSelfAccepting) {
    boundaries.add({
      boundary: node,
      acceptedVia: node
    })
    // mark current propagation chain dirty.
    // timestamp is used for injecting timestamp query during rewrite
    // also invalidate cache
    invalidateChain(currentChain, timestamp)
    return false
  }

  if (!node.importers.size) {
    return true
  }

  for (const importer of node.importers) {
    const subChain = currentChain.concat(importer)
    if (importer.acceptedHmrDeps.has(node)) {
      boundaries.add({
        boundary: importer,
        acceptedVia: node
      })
      invalidateChain(subChain, timestamp)
      continue
    }

    if (!currentChain.includes(importer)) {
      if (propagateUpdate(importer, timestamp, boundaries, subChain)) {
        return true
      }
    }
  }
  return false
}

function invalidateChain(chain: ModuleNode[], timestamp: number) {
  chain.forEach((node) => {
    node.lastHMRTimestamp = timestamp
    node.transformResult = null
  })
}

export function handlePrunedModules(
  mods: Set<ModuleNode>,
  { ws }: ViteDevServer
) {
  // update the disposed modules' hmr timestamp
  // since if it's re-imported, it should re-apply side effects
  // and without the timestamp the browser will not re-import it!
  const t = Date.now()
  mods.forEach((mod) => {
    mod.lastHMRTimestamp = t
    debugHmr(`[dispose] ${chalk.dim(mod.file)}`)
  })
  ws.send({
    type: 'prune',
    paths: [...mods].map((m) => m.url)
  })
}

const enum LexerState {
  inCall,
  inSingleQuoteString,
  inDoubleQuoteString,
  inTemplateString,
  inArray
}

/**
 * Lex import.meta.hot.accept() for accepted deps.
 * Since hot.accept() can only accept string literals or array of string
 * literals, we don't really need a heavy @babel/parse call on the entire source.
 *
 * @returns selfAccepts
 */
export function lexAcceptedHmrDeps(
  code: string,
  start: number,
  urls: Set<string>
): boolean {
  let state: LexerState = LexerState.inCall
  // the state can only be 2 levels deep so no need for a stack
  let prevState: LexerState = LexerState.inCall
  let currentDep: string = ''

  for (let i = start; i < code.length; i++) {
    const char = code.charAt(i)
    switch (state) {
      case LexerState.inCall:
      case LexerState.inArray:
        if (char === `'`) {
          prevState = state
          state = LexerState.inSingleQuoteString
        } else if (char === `"`) {
          prevState = state
          state = LexerState.inDoubleQuoteString
        } else if (char === '`') {
          prevState = state
          state = LexerState.inTemplateString
        } else if (/\s/.test(char)) {
          continue
        } else {
          if (state === LexerState.inCall) {
            if (char === `[`) {
              state = LexerState.inArray
            } else {
              // reaching here means the first arg is neither a string literal
              // nor an Array literal (direct callback) or there is no arg
              // in both case this indicates a self-accepting module
              return true // done
            }
          } else if (state === LexerState.inArray) {
            if (char === `]`) {
              return false // done
            } else if (char === ',') {
              continue
            } else {
              error(i)
            }
          }
        }
        break
      case LexerState.inSingleQuoteString:
        if (char === `'`) {
          urls.add(currentDep)
          currentDep = ''
          state = prevState
        } else {
          currentDep += char
        }
        break
      case LexerState.inDoubleQuoteString:
        if (char === `"`) {
          urls.add(currentDep)
          state = prevState
        } else {
          currentDep += char
        }
        break
      case LexerState.inTemplateString:
        if (char === '`') {
          urls.add(currentDep)
          currentDep = ''
          state = prevState
        } else if (char === '$' && code.charAt(i + 1) === '{') {
          error(i)
        } else {
          currentDep += char
        }
        break
      default:
        throw new Error('unknown lexer state')
    }
  }
  return false
}

function error(pos: number) {
  const err = new Error(
    `import.meta.accept() can only accept string literals or an ` +
      `Array of string literals.`
  ) as RollupError
  err.pos = pos
  throw err
}
