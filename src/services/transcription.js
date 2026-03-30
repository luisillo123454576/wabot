const axios = require('axios')
const Groq = require('groq-sdk')
const fs = require('fs')
const path = require('path')

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

async function transcribeAudio(mediaId) {
  // Paso 1: obtener la URL del audio desde Meta
  const mediaResponse = await axios.get(
    `https://graph.facebook.com/v22.0/${mediaId}`,
    {
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }
    }
  )

  const audioUrl = mediaResponse.data.url

  // Paso 2: descargar el archivo de audio
  const audioResponse = await axios.get(audioUrl, {
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
    responseType: 'arraybuffer'
  })

  // Paso 3: guardar temporalmente
  const tempPath = path.join('/tmp', `audio_${mediaId}.ogg`)
  fs.writeFileSync(tempPath, audioResponse.data)

  // Paso 4: transcribir con Groq Whisper
  const transcription = await groq.audio.transcriptions.create({
    file: fs.createReadStream(tempPath),
    model: 'whisper-large-v3-turbo',
    language: 'es'
  })

  // Paso 5: limpiar archivo temporal
  fs.unlinkSync(tempPath)

  return transcription.text
}

module.exports = { transcribeAudio }