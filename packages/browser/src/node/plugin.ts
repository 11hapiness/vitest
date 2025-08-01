import type { Stats } from 'node:fs'
import type { HtmlTagDescriptor } from 'vite'
import type { Plugin } from 'vitest/config'
import type { Vitest } from 'vitest/node'
import type { ParentBrowserProject } from './projectParent'
import { createReadStream, lstatSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dynamicImportPlugin } from '@vitest/mocker/node'
import { toArray } from '@vitest/utils'
import MagicString from 'magic-string'
import { basename, dirname, extname, resolve } from 'pathe'
import sirv from 'sirv'
import * as vite from 'vite'
import { coverageConfigDefaults } from 'vitest/config'
import { isFileServingAllowed, isValidApiRequest, resolveApiServerConfig, resolveFsAllow, distDir as vitestDist } from 'vitest/node'
import { distRoot } from './constants'
import { createOrchestratorMiddleware } from './middlewares/orchestratorMiddleware'
import { createTesterMiddleware } from './middlewares/testerMiddleware'
import BrowserContext from './plugins/pluginContext'

export { defineBrowserCommand } from './commands/utils'
export type { BrowserCommand } from 'vitest/node'

const versionRegexp = /(?:\?|&)v=\w{8}/

export default (parentServer: ParentBrowserProject, base = '/'): Plugin[] => {
  function isPackageExists(pkg: string, root: string) {
    return parentServer.vitest.packageInstaller.isPackageExists?.(pkg, {
      paths: [root],
    })
  }

  return [
    {
      enforce: 'pre',
      name: 'vitest:browser',
      async configureServer(server) {
        parentServer.setServer(server)

        // eslint-disable-next-line prefer-arrow-callback
        server.middlewares.use(function vitestHeaders(_req, res, next) {
          const headers = server.config.server.headers
          if (headers) {
            for (const name in headers) {
              res.setHeader(name, headers[name]!)
            }
          }
          next()
        })
        server.middlewares.use(createOrchestratorMiddleware(parentServer))
        server.middlewares.use(createTesterMiddleware(parentServer))

        server.middlewares.use(
          `${base}favicon.svg`,
          (_, res) => {
            const content = readFileSync(resolve(distRoot, 'client/favicon.svg'))
            res.write(content, 'utf-8')
            res.end()
          },
        )

        const coverageFolder = resolveCoverageFolder(parentServer.vitest)
        const coveragePath = coverageFolder ? coverageFolder[1] : undefined
        if (coveragePath && base === coveragePath) {
          throw new Error(
            `The ui base path and the coverage path cannot be the same: ${base}, change coverage.reportsDirectory`,
          )
        }

        if (coverageFolder) {
          server.middlewares.use(
            coveragePath!,
            sirv(coverageFolder[0], {
              single: true,
              dev: true,
              setHeaders: (res) => {
                res.setHeader(
                  'Cache-Control',
                  'public,max-age=0,must-revalidate',
                )
              },
            }),
          )
        }

        const uiEnabled = parentServer.config.browser.ui

        if (uiEnabled) {
        // eslint-disable-next-line prefer-arrow-callback
          server.middlewares.use(`${base}__screenshot-error`, function vitestBrowserScreenshotError(req, res) {
            if (!req.url) {
              res.statusCode = 404
              res.end()
              return
            }

            const url = new URL(req.url, 'http://localhost')
            const id = url.searchParams.get('id')
            if (!id) {
              res.statusCode = 404
              res.end()
              return
            }

            const task = parentServer.vitest.state.idMap.get(id)
            const file = task?.meta.failScreenshotPath
            if (!file) {
              res.statusCode = 404
              res.end()
              return
            }

            let stat: Stats | undefined
            try {
              stat = lstatSync(file)
            }
            catch {
            }

            if (!stat?.isFile()) {
              res.statusCode = 404
              res.end()
              return
            }

            const ext = extname(file)
            const buffer = readFileSync(file)
            res.setHeader(
              'Cache-Control',
              'public,max-age=0,must-revalidate',
            )
            res.setHeader('Content-Length', buffer.length)
            res.setHeader('Content-Type', ext === 'jpeg' || ext === 'jpg'
              ? 'image/jpeg'
              : ext === 'webp'
                ? 'image/webp'
                : 'image/png')
            res.end(buffer)
          })
        }
        server.middlewares.use((req, res, next) => {
          // 9000 mega head move
          // Vite always caches optimized dependencies, but users might mock
          // them in _some_ tests, while keeping original modules in others
          // there is no way to configure that in Vite, so we patch it here
          // to always ignore the cache-control set by Vite in the next middleware
          if (req.url && versionRegexp.test(req.url) && !req.url.includes('chunk-')) {
            res.setHeader('Cache-Control', 'no-cache')
            const setHeader = res.setHeader.bind(res)
            res.setHeader = function (name, value) {
              if (name === 'Cache-Control') {
                return res
              }
              return setHeader(name, value)
            }
          }
          next()
        })
        // handle attachments the same way as in packages/ui/node/index.ts
        server.middlewares.use((req, res, next) => {
          if (!req.url) {
            return next()
          }

          const url = new URL(req.url, 'http://localhost')

          if (url.pathname !== '/__vitest_attachment__') {
            return next()
          }

          const path = url.searchParams.get('path')
          const contentType = url.searchParams.get('contentType')

          if (!isValidApiRequest(parentServer.config, req) || !contentType || !path) {
            return next()
          }

          const fsPath = decodeURIComponent(path)

          if (!isFileServingAllowed(parentServer.vite.config, fsPath)) {
            return next()
          }

          try {
            res.setHeader(
              'content-type',
              contentType,
            )

            return createReadStream(fsPath)
              .pipe(res)
              .on('close', () => res.end())
          }
          catch (err) {
            return next(err)
          }
        })
      },
    },
    {
      name: 'vitest:browser:tests',
      enforce: 'pre',
      async config() {
        // this plugin can be used in different projects, but all of them
        // have the same `include` pattern, so it doesn't matter which project we use
        const project = parentServer.project
        const { testFiles: browserTestFiles } = await project.globTestFiles()
        const setupFiles = toArray(project.config.setupFiles)

        // replace env values - cannot be reassign at runtime
        const define: Record<string, string> = {}
        for (const env in (project.config.env || {})) {
          const stringValue = JSON.stringify(project.config.env[env])
          define[`import.meta.env.${env}`] = stringValue
        }

        const entries: string[] = [
          ...browserTestFiles,
          ...setupFiles,
          resolve(vitestDist, 'index.js'),
          resolve(vitestDist, 'browser.js'),
          resolve(vitestDist, 'runners.js'),
          resolve(vitestDist, 'utils.js'),
          ...(project.config.snapshotSerializers || []),
        ]

        const exclude = [
          'vitest',
          'vitest/internal/browser',
          'vitest/runners',
          '@vitest/browser',
          '@vitest/browser/client',
          '@vitest/utils',
          '@vitest/utils/source-map',
          '@vitest/runner',
          '@vitest/spy',
          '@vitest/utils/error',
          '@vitest/snapshot',
          '@vitest/expect',
          'std-env',
          'tinybench',
          'tinyspy',
          'tinyrainbow',
          'pathe',
          'msw',
          'msw/browser',
        ]

        if (typeof project.config.diff === 'string') {
          entries.push(project.config.diff)
        }

        if (parentServer.vitest.coverageProvider) {
          const coverage = parentServer.vitest.config.coverage
          const provider = coverage.provider
          if (provider === 'v8') {
            const path = tryResolve('@vitest/coverage-v8', [parentServer.config.root])
            if (path) {
              entries.push(path)
              exclude.push('@vitest/coverage-v8/browser')
            }
          }
          else if (provider === 'istanbul') {
            const path = tryResolve('@vitest/coverage-istanbul', [parentServer.config.root])
            if (path) {
              entries.push(path)
              exclude.push('@vitest/coverage-istanbul')
            }
          }
          else if (provider === 'custom' && coverage.customProviderModule) {
            entries.push(coverage.customProviderModule)
          }
        }

        const include = [
          'vitest > expect-type',
          'vitest > @vitest/snapshot > magic-string',
          'vitest > chai',
          'vitest > chai > loupe',
          'vitest > @vitest/runner > strip-literal',
          'vitest > @vitest/utils > loupe',
          '@vitest/browser > @testing-library/user-event',
          '@vitest/browser > @testing-library/dom',
        ]

        const fileRoot = browserTestFiles[0] ? dirname(browserTestFiles[0]) : project.config.root

        const svelte = isPackageExists('vitest-browser-svelte', fileRoot)
        if (svelte) {
          exclude.push('vitest-browser-svelte')
        }

        // since we override the resolution in the esbuild plugin, Vite can no longer optimizer it
        const vue = isPackageExists('vitest-browser-vue', fileRoot)
        if (vue) {
          // we override them in the esbuild plugin so optimizer can no longer intercept it
          include.push(
            'vitest-browser-vue',
            'vitest-browser-vue > @vue/test-utils',
            'vitest-browser-vue > @vue/test-utils > @vue/compiler-core',
          )
        }
        const vueTestUtils = isPackageExists('@vue/test-utils', fileRoot)
        if (vueTestUtils) {
          include.push('@vue/test-utils')
        }

        return {
          define,
          resolve: {
            dedupe: ['vitest'],
          },
          optimizeDeps: {
            entries,
            exclude,
            include,
          },
        }
      },
      async resolveId(id) {
        if (!/\?browserv=\w+$/.test(id)) {
          return
        }

        let useId = id.slice(0, id.lastIndexOf('?'))
        if (useId.startsWith('/@fs/')) {
          useId = useId.slice(5)
        }

        if (/^\w:/.test(useId)) {
          useId = useId.replace(/\\/g, '/')
        }

        return useId
      },
    },
    {
      name: 'vitest:browser:resolve-virtual',
      async resolveId(rawId) {
        if (rawId === '/mockServiceWorker.js') {
          return this.resolve('msw/mockServiceWorker.js', distRoot, {
            skipSelf: true,
          })
        }
      },
    },
    {
      name: 'vitest:browser:assets',
      configureServer(server) {
        server.middlewares.use(
          '/__vitest__',
          sirv(resolve(distRoot, 'client/__vitest__')),
        )
      },
      resolveId(id) {
        if (id.startsWith('/__vitest_browser__/')) {
          return resolve(distRoot, 'client', id.slice(1))
        }
      },
      transform(code, id) {
        if (id.includes(parentServer.vite.config.cacheDir) && id.includes('loupe.js')) {
          // loupe bundle has a nastry require('util') call that leaves a warning in the console
          const utilRequire = 'nodeUtil = require_util();'
          return code.replace(utilRequire, ' '.repeat(utilRequire.length))
        }
      },
    },
    BrowserContext(parentServer),
    dynamicImportPlugin({
      globalThisAccessor: '"__vitest_browser_runner__"',
      filter(id) {
        if (id.includes(distRoot)) {
          return false
        }
        return true
      },
    }),
    {
      name: 'vitest:browser:config',
      enforce: 'post',
      async config(viteConfig) {
        // Enables using ignore hint for coverage providers with @preserve keyword
        if (viteConfig.esbuild !== false) {
          viteConfig.esbuild ||= {}
          viteConfig.esbuild.legalComments = 'inline'
        }

        const defaultPort = parentServer.vitest.state._data.browserLastPort++

        const api = resolveApiServerConfig(
          viteConfig.test?.browser || {},
          defaultPort,
        )

        viteConfig.server = {
          ...viteConfig.server,
          port: defaultPort,
          ...api,
          middlewareMode: false,
          open: false,
        }
        viteConfig.server.fs ??= {}
        viteConfig.server.fs.allow = viteConfig.server.fs.allow || []
        viteConfig.server.fs.allow.push(
          ...resolveFsAllow(
            parentServer.vitest.config.root,
            parentServer.vitest.vite.config.configFile,
          ),
          distRoot,
        )

        return {
          resolve: {
            alias: viteConfig.test?.alias,
          },
        }
      },
    },
    {
      name: 'vitest:browser:in-source-tests',
      transform(code, id) {
        const filename = cleanUrl(id)
        const project = parentServer.vitest.getProjectByName(parentServer.config.name)

        if (!project._isCachedTestFile(filename) || !code.includes('import.meta.vitest')) {
          return
        }
        const s = new MagicString(code, { filename })
        s.prepend(
          `Object.defineProperty(import.meta, 'vitest', { get() { return typeof __vitest_worker__ !== 'undefined' && __vitest_worker__.filepath === "${filename.replace(/"/g, '\\"')}" ? __vitest_index__ : undefined } });\n`,
        )
        return {
          code: s.toString(),
          map: s.generateMap({ hires: true }),
        }
      },
    },
    {
      name: 'vitest:browser:worker',
      transform(code, id, _options) {
        // https://github.com/vitejs/vite/blob/ba56cf43b5480f8519349f7d7fe60718e9af5f1a/packages/vite/src/node/plugins/worker.ts#L46
        if (/(?:\?|&)worker_file&type=\w+(?:&|$)/.test(id)) {
          const s = new MagicString(code)
          s.prepend('globalThis.__vitest_browser_runner__ = { wrapDynamicImport: f => f() };\n')
          return {
            code: s.toString(),
            map: s.generateMap({ hires: 'boundary' }),
          }
        }
      },
    },
    {
      name: 'vitest:browser:transform-tester-html',
      enforce: 'pre',
      async transformIndexHtml(html, ctx) {
        const projectBrowser = [...parentServer.children].find((server) => {
          return ctx.filename === server.testerFilepath
        })
        if (!projectBrowser) {
          return
        }

        if (!parentServer.testerScripts) {
          const testerScripts = await parentServer.formatScripts(
            parentServer.config.browser.testerScripts,
          )
          parentServer.testerScripts = testerScripts
        }
        const stateJs = typeof parentServer.stateJs === 'string'
          ? parentServer.stateJs
          : await parentServer.stateJs

        const testerTags: HtmlTagDescriptor[] = []

        const isDefaultTemplate = resolve(distRoot, 'client/tester/tester.html') === projectBrowser.testerFilepath
        if (!isDefaultTemplate) {
          const manifestContent = parentServer.manifest instanceof Promise
            ? await parentServer.manifest
            : parentServer.manifest
          const testerEntry = manifestContent['tester/tester.html']

          testerTags.push({
            tag: 'script',
            attrs: {
              type: 'module',
              crossorigin: '',
              src: `${parentServer.base}${testerEntry.file}`,
            },
            injectTo: 'head',
          })

          for (const importName of testerEntry.imports || []) {
            const entryManifest = manifestContent[importName]
            if (entryManifest) {
              testerTags.push(
                {
                  tag: 'link',
                  attrs: {
                    href: `${parentServer.base}${entryManifest.file}`,
                    rel: 'modulepreload',
                    crossorigin: '',
                  },
                  injectTo: 'head',
                },
              )
            }
          }
        }
        else {
          // inject the reset style only in the default template,
          // allowing users to customize the style in their own template
          testerTags.push({
            tag: 'style',
            children: `
html {
  padding: 0;
  margin: 0;
}
body {
  padding: 0;
  margin: 0;
  min-height: 100vh;
}`,
            injectTo: 'head',
          })
        }

        return [
          {
            tag: 'script',
            children: '{__VITEST_INJECTOR__}',
            injectTo: 'head-prepend' as const,
          },
          {
            tag: 'script',
            children: stateJs,
            injectTo: 'head-prepend',
          } as const,
          {
            tag: 'script',
            attrs: {
              type: 'module',
              src: parentServer.errorCatcherUrl,
            },
            injectTo: 'head' as const,
          },
          {
            tag: 'script',
            attrs: {
              type: 'module',
              src: parentServer.matchersUrl,
            },
            injectTo: 'head' as const,
          },
          parentServer.locatorsUrl
            ? {
                tag: 'script',
                attrs: {
                  type: 'module',
                  src: parentServer.locatorsUrl,
                },
                injectTo: 'head',
              } as const
            : null,
          ...parentServer.testerScripts,
          ...testerTags,
        ].filter(s => s != null)
      },
    },
    {
      name: 'vitest:browser:support-testing-library',
      config() {
        const rolldownPlugin = {
          name: 'vue-test-utils-rewrite',
          resolveId: {
            // test-utils: resolve to CJS instead of the browser because the browser version expects a global Vue object
            // compiler-core: only CJS version allows slots as strings
            filter: { id: /^@vue\/(test-utils|compiler-core)$/ },
            handler(source: string, importer: string) {
              const resolved = getRequire().resolve(source, {
                paths: [importer!],
              })
              return resolved
            },
          },
        }

        const esbuildPlugin = {
          name: 'test-utils-rewrite',
          // "any" because vite doesn't expose any types for this
          setup(build: any) {
            // test-utils: resolve to CJS instead of the browser because the browser version expects a global Vue object
            // compiler-core: only CJS version allows slots as strings
            build.onResolve({ filter: /^@vue\/(test-utils|compiler-core)$/ }, (args: any) => {
              const resolved = getRequire().resolve(args.path, {
                paths: [args.importer],
              })
              return { path: resolved }
            })
          },
        }

        return {
          optimizeDeps: 'rolldownVersion' in vite
            ? { rollupOptions: { plugins: [rolldownPlugin] } }
            : { esbuildOptions: { plugins: [esbuildPlugin] } },
        }
      },
    },
  ]
}

function tryResolve(path: string, paths: string[]) {
  try {
    const _require = getRequire()
    return _require.resolve(path, { paths })
  }
  catch {
    return undefined
  }
}

let _require: NodeRequire
function getRequire() {
  if (!_require) {
    _require = createRequire(import.meta.url)
  }
  return _require
}

function resolveCoverageFolder(vitest: Vitest) {
  const options = vitest.config
  const htmlReporter = options.coverage?.enabled
    ? toArray(options.coverage.reporter).find((reporter) => {
        if (typeof reporter === 'string') {
          return reporter === 'html'
        }

        return reporter[0] === 'html'
      })
    : undefined

  if (!htmlReporter) {
    return undefined
  }

  // reportsDirectory not resolved yet
  const root = resolve(
    options.root || process.cwd(),
    options.coverage.reportsDirectory || coverageConfigDefaults.reportsDirectory,
  )

  const subdir
    = Array.isArray(htmlReporter)
      && htmlReporter.length > 1
      && 'subdir' in htmlReporter[1]
      ? htmlReporter[1].subdir
      : undefined

  if (!subdir || typeof subdir !== 'string') {
    return [root, `/${basename(root)}/`]
  }

  return [resolve(root, subdir), `/${basename(root)}/${subdir}/`]
}

const postfixRE = /[?#].*$/
function cleanUrl(url: string): string {
  return url.replace(postfixRE, '')
}
