import { builtinModules, createRequire } from 'node:module'
import commonjs from '@rollup/plugin-commonjs'
import json from '@rollup/plugin-json'
import nodeResolve from '@rollup/plugin-node-resolve'
import { join } from 'pathe'
import oxc from 'unplugin-oxc/rollup'
import { createDtsUtils } from '../../scripts/build-utils.js'

const require = createRequire(import.meta.url)
const pkg = require('./package.json')

const entries = {
  index: 'src/index.ts',
  provider: 'src/provider.ts',
}

const external = [
  ...builtinModules,
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.peerDependencies || {}),
  /^@?vitest(\/|$)/,
]

const dtsUtils = createDtsUtils()

const plugins = [
  ...dtsUtils.isolatedDecl(),
  nodeResolve(),
  json(),
  commonjs(),
  oxc({
    transform: { target: 'node18' },
  }),
]

export default () => [
  {
    input: entries,
    output: {
      dir: 'dist',
      format: 'esm',
    },
    external,
    plugins,
  },
  {
    input: dtsUtils.dtsInput(entries),
    output: {
      dir: join(process.cwd(), 'dist'),
      entryFileNames: '[name].d.ts',
      format: 'esm',
    },
    watch: false,
    external,
    plugins: dtsUtils.dts(),
  },
]
