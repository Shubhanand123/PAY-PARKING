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
