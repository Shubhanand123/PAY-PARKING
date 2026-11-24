import { useEffect, useState } from 'react'
import { nativeApp, PlateReader } from './native'

type Latest = { versionCode: number; minVersionCode: number; versionName: string; apk: string }

// Android app only: compares the installed app with public/app-version.json on the live site.
// Newer version: a banner with a download button. Below the minimum: a full-screen "update to continue".
export function AppUpdate() {
  const [update, setUpdate] = useState<Latest & { current: number }>()
  useEffect(() => {
    if (!nativeApp) return
    let alive = true
    Promise.all([PlateReader.version(), fetch('/app-version.json', { cache: 'no-store' }).then(r => r.json() as Promise<Latest>)])
      .then(([mine, latest]) => { if (alive && latest.versionCode > mine.versionCode) setUpdate({ ...latest, current: mine.versionCode }) })
      .catch(() => {})
    return () => { alive = false }
  }, [])
  if (!update) return null
  const forced = update.current < update.minVersionCode
  const download = () => void PlateReader.openExternal({ url: update.apk }).catch(() => {})
  return <div className={forced ? 'app-update forced' : 'app-update'} role="alert">
    <div className="app-update-box">
      <b>{forced ? 'Update the app to continue' : 'App update available'}</b>
      <span>Version {update.versionName} is ready. It downloads in the browser; open it to install. Your tickets and settings stay.</span>
      <div className="app-update-actions">
        <button className="btn btn-primary" onClick={download}>Download update</button>
        {!forced && <button className="btn btn-ghost" onClick={() => setUpdate(undefined)}>Later</button>}
      </div>
    </div>
  </div>
}
