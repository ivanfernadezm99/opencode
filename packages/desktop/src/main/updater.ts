import { app, dialog, shell } from "electron"
import * as https from "node:https"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { exec } from "node:child_process"
import { UPDATER_ENABLED } from "./constants"
import { createUpdaterController, type UpdaterReadyRecord, type UpdaterBackend } from "./updater-controller"
import { getLogger } from "./logging"
import { getStore } from "./store"
import { setAppQuitting } from "./windows"

const GITHUB_REPO = "ivanfernadezm99/opencode"
const key = "ready"

function fetchLatestRelease(): Promise<{ version: string; assets: { name: string; browser_download_url: string }[] }> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.github.com",
      path: `/repos/${GITHUB_REPO}/releases/latest`,
      headers: { "User-Agent": "opencode-desktop-updater", Accept: "application/vnd.github.v3+json" },
    }

    https.get(options, (res) => {
      let data = ""
      res.on("data", (chunk: string) => (data += chunk))
      res.on("end", () => {
        try {
          const release = JSON.parse(data)
          resolve({
            version: release.tag_name,
            assets: release.assets.map((a: any) => ({
              name: a.name,
              browser_download_url: a.browser_download_url,
            })),
          })
        } catch (e) {
          reject(new Error(`Failed to parse release: ${String(e)}`))
        }
      })
    }).on("error", reject)
  })
}

function createGithubBackend(currentVersion: string): UpdaterBackend {
  let downloadPath = ""

  return {
    async checkForUpdates() {
      const release = await fetchLatestRelease()
      const isUpdateAvailable = release.version !== currentVersion && release.version !== `v${currentVersion}`

      return {
        isUpdateAvailable,
        updateInfo: { version: release.version },
      }
    },

    async downloadUpdate() {
      const release = await fetchLatestRelease()
      const ps1Asset = release.assets.find((a) => a.name === "install.ps1")
      if (!ps1Asset) throw new Error("install.ps1 not found in release")

      downloadPath = path.join(os.tmpdir(), "opencode-install.ps1")
      return new Promise<void>((resolve, reject) => {
        https.get(ps1Asset.browser_download_url, (res) => {
          if (res.statusCode === 302 && res.headers.location) {
            https.get(res.headers.location, (redirectRes) => {
              const file = fs.createWriteStream(downloadPath)
              redirectRes.pipe(file)
              file.on("finish", () => {
                file.close()
                resolve()
              })
            }).on("error", reject)
            return
          }
          const file = fs.createWriteStream(downloadPath)
          res.pipe(file)
          file.on("finish", () => {
            file.close()
            resolve()
          })
        }).on("error", reject)
      })
    },

    quitAndInstall() {
      if (!downloadPath || !fs.existsSync(downloadPath)) {
        dialog.showErrorBox("Update Error", "Installer not found. Download manually from GitHub.")
        return
      }

      const psCommand = `powershell -ExecutionPolicy Bypass -File "${downloadPath}" -Desktop`
      exec(psCommand, { windowsHide: false }, (err) => {
        if (err) {
          dialog.showErrorBox("Update Error", `Failed to run installer: ${err.message}`)
        }
      })

      // Give PowerShell a moment to start, then quit the app so installer can replace files
      setTimeout(() => app.quit(), 1000)
    },
  }
}

export function setupAutoUpdater(stop: () => Promise<void>) {
  const logger = getLogger()
  const currentVersion = app.getVersion()

  logger.log("auto updater configured", {
    channel: "latest",
    currentVersion,
    mode: "github-release-installer",
  })

  const store = getStore("opencode.updater")
  return createUpdaterController({
    enabled: UPDATER_ENABLED,
    currentVersion,
    backend: createGithubBackend(currentVersion),
    persistence: {
      get() {
        const value = store.get(key)
        if (!value || typeof value !== "object" || !("version" in value) || typeof value.version !== "string") return
        return { version: value.version } satisfies UpdaterReadyRecord
      },
      set: (value) => store.set(key, value),
      clear: () => store.delete(key),
    },
    stop,
    log: (message, data) => logger.log(message, data),
  })
}

export async function showUpdaterDialog(controller: ReturnType<typeof setupAutoUpdater>, alertOnFail: boolean) {
  const state = await controller.check()
  if (state.status === "error") {
    if (!alertOnFail) return
    await dialog.showMessageBox({ type: "error", message: "Update check failed.", title: "Update Error" })
    return
  }
  if (state.status === "up-to-date") {
    if (!alertOnFail) return
    await dialog.showMessageBox({ type: "info", message: "You're up to date.", title: "No Updates" })
    return
  }
  if (state.status !== "ready") return

  const response = await dialog.showMessageBox({
    type: "info",
    message: `one info code ${state.version} is available.\n\nUpdate now? The installer will close this app and update automatically.`,
    title: "one info code - Update Available",
    buttons: ["Update Now", "Later"],
    defaultId: 0,
    cancelId: 1,
  })
  if (response.response === 0) await controller.install()
}

export async function checkForUpdateNotification(controller: ReturnType<typeof setupAutoUpdater>) {
  const state = await controller.check()
  if (state.status === "ready" && state.version !== app.getVersion()) {
    const response = await dialog.showMessageBox({
      type: "info",
      message: `one info code ${state.version} is available.\n\nUpdate now? The installer will close this app and update automatically.`,
      title: "one info code - Update Available",
      buttons: ["Update Now", "Later"],
      defaultId: 0,
      cancelId: 1,
    })
    if (response.response === 0) await controller.install()
  }
}
