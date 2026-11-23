import { checkPlate, normPlate } from './engine'

export async function readPlate(file: File) {
  const { createWorker, PSM } = await import('tesseract.js')
  const worker = await createWorker('eng')
  try {
    await worker.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -', tessedit_pageseg_mode: PSM.SPARSE_TEXT })
    const { data } = await worker.recognize(file)
    const lines = data.text.trim().split(/\r?\n/).map(normPlate).filter(Boolean)
    const candidates = [...lines, ...lines.slice(0, -1).map((line, index) => line + lines[index + 1])]
    const plate = candidates.find(value => checkPlate(value).kind !== 'unknown') ?? candidates.find(value => value.length >= 6 && value.length <= 16)
    if (!plate) throw new Error('Could not read the plate. Retake the photo or type the number.')
    return { plate, confidence: data.confidence / 100 }
  } finally {
    await worker.terminate()
  }
}

export async function readQr(file: File) {
  const { default: jsQR } = await import('jsqr')
  const image = await createImageBitmap(file)
  try {
    const canvas = document.createElement('canvas')
    const scale = Math.min(1, 1600 / Math.max(image.width, image.height))
    canvas.width = Math.max(1, Math.round(image.width * scale))
    canvas.height = Math.max(1, Math.round(image.height * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Camera image could not be read.')
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
    const qr = jsQR(pixels.data, pixels.width, pixels.height)
    if (!qr) throw new Error('No QR code found. Retake the photo or enter the ticket number.')
    return qr.data
  } finally {
    image.close()
  }
}
