import test from 'node:test'
import assert from 'node:assert/strict'
import { compareVersions, checkForUpdate, buildUpdateCommand } from '../server/update-runtime.mjs'

test('Versionen werden semver-artig verglichen', () => {
  assert.equal(compareVersions('0.2.1', '0.2.1'), 0)
  assert.equal(compareVersions('0.2.0', '0.2.1'), -1)
  assert.equal(compareVersions('1.0.0', '0.9.9'), 1)
})

test('Update-Prüfung liefert neueste Version und sicheren manuellen Befehl', async () => {
  const result = await checkForUpdate({
    currentVersion: '0.2.0',
    fetchImpl: async () => new Response(JSON.stringify({ tag_name: 'v0.2.1', html_url: 'https://github.com/zappotex/bonys-agents-mission-control/releases/tag/v0.2.1' }), { status: 200 }),
  })
  assert.deepEqual(result, {
    currentVersion: '0.2.0',
    latestVersion: '0.2.1',
    updateAvailable: true,
    releaseUrl: 'https://github.com/zappotex/bonys-agents-mission-control/releases/tag/v0.2.1',
    command: 'sudo /opt/bonys-mission-control/scripts/update.sh --version 0.2.1',
  })
})

test('Ungültige oder fehlerhafte Release-Antwort wird generisch abgefangen', async () => {
  const result = await checkForUpdate({
    currentVersion: '0.2.1',
    fetchImpl: async () => new Response(JSON.stringify({ tag_name: 'not-a-version' }), { status: 200 }),
  })
  assert.deepEqual(result, { currentVersion: '0.2.1', available: false, error: 'update_check_failed' })
})

test('Update-Befehl akzeptiert nur sichere Release-Versionen', () => {
  assert.equal(buildUpdateCommand('0.2.1'), 'sudo /opt/bonys-mission-control/scripts/update.sh --version 0.2.1')
  assert.equal(buildUpdateCommand('v0.2.1'), 'sudo /opt/bonys-mission-control/scripts/update.sh --version 0.2.1')
  assert.throws(() => buildUpdateCommand('latest && rm -rf /'), /invalid_version/)
})
