import { useEffect, useRef, useState } from 'react'
import { readPlateFrame, warmPlateReader } from './plate-worker'
import { prettyPlate } from './engine'
import { plateFromText, rankPlateFrames, type PlateReading } from './plate-reading'
import { Ico } from './ui'

export type ScanResult = PlateReading & { alternatives: string[] }

const guideWidth = .92
const guideHeight = .64

function frameRegion(video: HTMLVideoElement, heightRatio: number) {
  const width = Math.round(video.videoWidth * guideWidth)
  const height = Math.round(video.videoHeight * heightRatio)
  return { width, height, x: (video.videoWidth - width) / 2, y: (video.videoHeight - height) / 2 }
}

function crop(video: HTMLVideoElement, canvas: HTMLCanvasElement, firstPass: boolean, enhance: boolean) {
  const region = frameRegion(video, firstPass ? .38 : guideHeight)
  canvas.width = Math.min(firstPass ? 720 : 880, region.width * 2)
  canvas.height = Math.round(canvas.width * region.height / region.width)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Video frames could not be read.')
  context.filter = enhance ? 'grayscale(1) contrast(1.45)' : 'grayscale(1)'
  context.drawImage(video, region.x, region.y, region.width, region.height, 0, 0, canvas.width, canvas.height)
}

export function PlateScanner({ onRead, onClose, onQr }: {
  onRead: (result: ScanResult) => void
  onClose: () => void
  onQr?: (data: string) => boolean
}) {
  const video = useRef<HTMLVideoElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const callbacks = useRef({ onRead, onClose, onQr })
  const [error, setError] = useState('')
  const [status, setStatus] = useState('Starting camera…')
  const [qrNotice, setQrNotice] = useState('')
  const [draft, setDraft] = useState<ScanResult>()
  const [cameraRatio, setCameraRatio] = useState(0)

  useEffect(() => { callbacks.current = { onRead, onClose, onQr } }, [onRead, onClose, onQr])
  useEffect(() => {
    let stopped = false
    let stream: MediaStream | undefined
    let qrTimer: ReturnType<typeof setInterval> | undefined
    const readsQr = Boolean(callbacks.current.onQr)
    const preview = video.current!
    const panel = dialog.current!
    panel.showModal()

    function stop() {
      stopped = true
      clearInterval(qrTimer)
      stream?.getTracks().forEach(track => track.stop())
      preview.srcObject = null
    }
    const background = () => {
      if (document.hidden) {
        stop()
        callbacks.current.onClose()
      }
    }
    document.addEventListener('visibilitychange', background)
    async function scanQr() {
      try {
        const { default: decode } = await import('jsqr')
        if (stopped) return
        const canvas = document.createElement('canvas')
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (!context) throw new Error('Could not start QR reader.')
        let lastTime = -1
        let lastRejected = ''
        const readFrame = () => {
          const w = preview.videoWidth, h = preview.videoHeight
          if (stopped || !w || !h || preview.currentTime === lastTime) return
          lastTime = preview.currentTime
          const region = frameRegion(preview, guideHeight)
          const width = Math.min(760, region.width)
          const height = Math.max(1, Math.round(width * region.height / region.width))
          if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width
            canvas.height = height
          }
          context.drawImage(preview, region.x, region.y, region.width, region.height, 0, 0, width, height)
          const pixels = context.getImageData(0, 0, width, height)
          const data = decode(pixels.data, width, height, { inversionAttempts: 'dontInvert' })?.data
          if (!data) return
          if (callbacks.current.onQr?.(data)) { stop(); return }
          if (data === lastRejected) return
          lastRejected = data
          setQrNotice('That QR does not match a parking ticket. Try another ticket or scan the plate.')
        }
        readFrame()
        if (!stopped) qrTimer = setInterval(readFrame, 90)
      } catch {
        if (!stopped) setQrNotice('QR scanning is unavailable. Scan the plate or look up the ticket manually.')
      }
    }

    async function scan() {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Live camera access is unavailable in this browser.')
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
          facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 },
        } })
        if (stopped) { stream.getTracks().forEach(track => track.stop()); return }
        preview.srcObject = stream
        await preview.play()
        if (stopped) return
        setCameraRatio(preview.videoWidth / preview.videoHeight)
        if (readsQr) void scanQr()
        setStatus(readsQr ? 'Scan a ticket QR. The plate reader is loading…' : 'Loading plate reader…')
        await warmPlateReader()
        if (stopped) return
        setStatus(readsQr ? 'Centre the ticket QR or the whole plate in the guide.' : 'Keep the entire plate inside the frame and hold steady.')

        const canvas = document.createElement('canvas')
        const frames: (PlateReading | undefined)[] = []
        let index = 0
        let lastTime = -1
        let previousRead: PlateReading | undefined
        while (!stopped) {
          if (!preview.videoWidth || preview.currentTime === lastTime) {
            await new Promise(resolve => setTimeout(resolve, 35))
            continue
          }
          lastTime = preview.currentTime
          const fastPass = index === 0 || Boolean(previousRead && index % 3 !== 2)
          crop(preview, canvas, fastPass, index++ % 2 === 1)
          const data = await readPlateFrame(canvas, fastPass ? 'line' : 'block')
          if (stopped) return
          previousRead = plateFromText(data.text, data.confidence)
          frames.push(previousRead)
          if (frames.length > 6) frames.shift()
          const ranked = rankPlateFrames(frames)
          const result = ranked.best && { ...ranked.best, alternatives: ranked.alternatives }
          setDraft(result)
          if (result && ranked.stable) {
            stop()
            callbacks.current.onRead(result)
            return
          }
          if (index > 7 && !result) setStatus(readsQr ? 'Hold the ticket QR or the whole plate steady inside the guide.' : 'Move closer, reduce glare, or enter the number manually.')
        }
      } catch (failure) {
        if (stopped) return
        if (readsQr && preview.videoWidth && stream?.active) {
          setStatus('Plate reading is unavailable. You can scan a ticket QR or use manual lookup.')
          return
        }
        const denied = failure instanceof DOMException && failure.name === 'NotAllowedError'
        setError(denied ? 'Camera access was denied. Allow it in browser settings or type the plate.' : 'The scanner could not start or lost the camera. Reopen it or type the plate.')
        setCameraRatio(0)
        stop()
      }
    }
    void scan()
    return () => {
      document.removeEventListener('visibilitychange', background)
      stop()
      if (panel.open) panel.close()
    }
  }, [])

  return <dialog ref={dialog} className="plate-camera" aria-labelledby="plate-camera-title"
    onCancel={event => { event.preventDefault(); onClose() }}>
    <div className="stack">
      <h2 id="plate-camera-title"><Ico n="scan" /> {onQr ? 'Scan ticket or plate' : 'Live plate scanner'}</h2>
      <div className="plate-video" style={cameraRatio ? { width: `min(100%, ${64 * cameraRatio}dvh)` } : undefined}>
        <video ref={video} autoPlay playsInline muted aria-label="Live camera preview" />
        {cameraRatio > 0 && <div className="plate-guide" aria-hidden="true" />}
      </div>
      {error ? <p role="alert" className="msg bad">{error}</p> : <p role="status" className="muted small">{status}</p>}
      {qrNotice && <p className="msg info" role="status">{qrNotice}</p>}
      {draft && <button className="btn btn-primary" onClick={() => onRead(draft)}>Review {prettyPlate(draft.plate)}</button>}
      <button className="btn btn-ghost" onClick={onClose}>Enter manually</button>
    </div>
  </dialog>
}
