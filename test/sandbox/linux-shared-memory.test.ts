import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  cleanupBwrapMountPoints,
  wrapCommandWithSandboxLinux,
} from '../../src/sandbox/linux-sandbox-utils.js'
import { quote } from '../../src/utils/shell-quote.js'
import { bwrapCanNamespace } from '../helpers/bwrap-namespace.js'
import { isLinux } from '../helpers/platform.js'

describe.skipIf(!isLinux || !existsSync('/dev/shm') || !bwrapCanNamespace())(
  'Linux shared-memory write grants',
  () => {
    let fixture: string
    let workspace: string
    let sibling: string
    beforeEach(() => {
      fixture = mkdtempSync('/dev/shm/srt-shm-')
      workspace = join(fixture, "work space's root")
      sibling = join(fixture, 'sibling')
      mkdirSync(workspace)
      mkdirSync(sibling)
    })

    afterEach(() => {
      cleanupBwrapMountPoints({ force: true })
      rmSync(fixture, { force: true, recursive: true })
    })

    async function run(
      command: string,
      options: {
        allowOnly?: string[]
        denyWithinAllow?: string[]
        denyRead?: string[]
      } = {},
    ) {
      const wrapped = await wrapCommandWithSandboxLinux({
        command,
        needsNetworkRestriction: false,
        mandatoryDenySearchDepth: 0,
        readConfig: { denyOnly: options.denyRead ?? [] },
        writeConfig: {
          allowOnly: options.allowOnly ?? [workspace],
          denyWithinAllow: options.denyWithinAllow ?? [],
        },
      })
      const child = spawnSync('/bin/sh', ['-c', wrapped], {
        encoding: 'utf8',
        timeout: 5000,
      })
      expect(child.error).toBeUndefined()
      expect(child.status, child.stderr).toBe(0)
      return child.stdout
    }

    it('preserves the explicit directory and leaves its siblings hidden', async () => {
      const alias = join(workspace, 'alias')
      mkdirSync(join(workspace, 'sub'))
      symlinkSync('sub', alias)
      writeFileSync(join(sibling, 'host-only'), 'host')
      await run(
        `set -e; cd ${quote([alias])}; printf first > draft; mv draft saved; ` +
          `printf second >> saved; test -c /dev/null; ` +
          `test ! -e ${quote([join(sibling, 'host-only')])}`,
      )
      expect(readFileSync(join(workspace, 'sub', 'saved'), 'utf8')).toBe(
        'firstsecond',
      )
      expect(readFileSync(join(sibling, 'host-only'), 'utf8')).toBe('host')
    })

    it('keeps nested read and write denies under the grant', async () => {
      const locked = join(workspace, 'locked')
      const hidden = join(workspace, 'hidden')
      writeFileSync(locked, 'original')
      writeFileSync(hidden, 'host-only')
      await run(
        `set -e; cd ${quote([workspace])}; ` +
          'test "$(cat locked)" = original; test -z "$(cat hidden)"; ' +
          'if (printf changed > locked) 2>/dev/null; then exit 1; fi; ' +
          'printf allowed > saved',
        { denyWithinAllow: [locked], denyRead: [hidden] },
      )
      expect(readFileSync(locked, 'utf8')).toBe('original')
      expect(readFileSync(hidden, 'utf8')).toBe('host-only')
      expect(readFileSync(join(workspace, 'saved'), 'utf8')).toBe('allowed')
    })

    it('leaves shared memory private with no specific grant', async () => {
      const hidden = join(workspace, 'host-only')
      writeFileSync(hidden, 'host')
      await run(`test -c /dev/null && test ! -e ${quote([hidden])}`, {
        allowOnly: ['/'],
      })
    })

    it('keeps a covering write deny in force', async () => {
      const locked = join(workspace, 'locked')
      writeFileSync(locked, 'original')
      await run(
        `test -c /dev/null && ! (printf changed > ${quote([locked])}) 2>/dev/null`,
        { denyWithinAllow: [fixture] },
      )
      expect(readFileSync(locked, 'utf8')).toBe('original')
    })
  },
)
